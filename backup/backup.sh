#!/usr/bin/env bash
# =============================================================================
# Резервная копия боевой базы: pg_dump → проверка → шифрование → облако.
#
#   DATABASE_URL=postgres://… BACKUP_PASSPHRASE=… backup/backup.sh
#
# Обязательные переменные:
#   DATABASE_URL        откуда снимать копию (для Neon — прямой адрес, без -pooler)
#   BACKUP_PASSPHRASE   пароль шифрования, от 20 символов. Без него копию не
#                       открыть — храните в менеджере паролей, НЕ только в GitHub.
# Облако (любое S3-совместимое: Cloudflare R2, Backblaze B2, AWS S3, …):
#   S3_BUCKET, S3_ENDPOINT (не нужен для AWS), AWS_ACCESS_KEY_ID,
#   AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION (для R2 — auto)
# Необязательные:
#   BACKUP_NAME         имя проекта в названии файла (по умолчанию db)
#   S3_PREFIX           папка в бакете (по умолчанию BACKUP_NAME)
#   BACKUP_OUT_DIR      куда положить зашифрованный файл локально (./backups)
#   RETENTION_DAYS      сколько дней хранить копии в облаке (60)
#   KEEP_MIN            сколько последних копий не удалять никогда (14)
#
# Без S3_BUCKET копия остаётся только в BACKUP_OUT_DIR.
# =============================================================================
set -euo pipefail

die() { echo "backup: $*" >&2; exit 1; }

: "${DATABASE_URL:?backup: не задан DATABASE_URL}"
: "${BACKUP_PASSPHRASE:?backup: не задан BACKUP_PASSPHRASE}"
[ "${#BACKUP_PASSPHRASE}" -ge 20 ] || die "BACKUP_PASSPHRASE короче 20 символов"

NAME=${BACKUP_NAME:-db}
OUT_DIR=${BACKUP_OUT_DIR:-./backups}
PREFIX=${S3_PREFIX:-$NAME}
RETENTION_DAYS=${RETENTION_DAYS:-60}
KEEP_MIN=${KEEP_MIN:-14}

command -v gpg >/dev/null || die "нужен gpg (apt install gnupg)"

WORK=$(mktemp -d)
export GNUPGHOME="$WORK/gnupg"
mkdir -m 700 "$GNUPGHOME"
trap 'rm -rf "$WORK"' EXIT

# ── Клиент Postgres той же или более новой версии, что и сервер ─────────────
# pg_dump старше сервера отказывается работать, поэтому версию берём с сервера
# и, если местный клиент старее, запускаем официальный образ postgres нужной
# версии (на GitHub Actions Docker есть всегда).
local_major() { "$1" --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/'; }

pgtool() { # pgtool <major> <tool> [args…] — строка подключения в $PGURL
  local major=$1 tool=$2; shift 2
  local have; have=$(local_major "$tool" || true)
  if [ -n "$have" ] && [ "$have" -ge "$major" ]; then
    "$tool" -d "$PGURL" "$@"
  elif command -v docker >/dev/null; then
    docker run --rm -i --network host -e PGURL "postgres:${major}-alpine" \
      sh -c 'exec "$0" -d "$PGURL" "$@"' "$tool" "$@"
  else
    die "нужен $tool версии $major+ или Docker"
  fi
}

export PGURL=$DATABASE_URL
if command -v psql >/dev/null; then
  SERVER_NUM=$(psql -d "$PGURL" -XAtqc 'show server_version_num')
else
  SERVER_NUM=$(pgtool 18 psql -XAtqc 'show server_version_num')
fi
MAJOR=$((SERVER_NUM / 10000))
[ "$MAJOR" -ge 12 ] || die "не удалось определить версию сервера ($SERVER_NUM)"

STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
FILE="$NAME-$STAMP-pg$MAJOR.dump.gpg"
DUMP="$WORK/db.dump"

# ── Дамп ────────────────────────────────────────────────────────────────────
# Формат custom: сжатый, восстанавливается выборочно и в базу с другими
# ролями. Владельцы и права не пишутся — у Neon свои роли, которых нет там,
# куда будем восстанавливать.
echo "backup: снимаю копию (Postgres $MAJOR)…"
pgtool "$MAJOR" pg_dump --format=custom --compress=6 --no-owner --no-privileges \
  --no-publications --no-subscriptions > "$DUMP"

# Архив должен читаться целиком — обрыв связи посреди дампа даёт файл,
# который выглядит нормально, пока не понадобится.
if command -v pg_restore >/dev/null && [ "$(local_major pg_restore)" -ge "$MAJOR" ]; then
  LIST=$(pg_restore --list "$DUMP")
else
  LIST=$(docker run --rm -i "postgres:${MAJOR}-alpine" pg_restore --list < "$DUMP")
fi
TABLES=$(grep -c ' TABLE DATA ' <<<"$LIST" || true)
[ "$TABLES" -gt 0 ] || die "в копии нет ни одной таблицы с данными — что-то не так"

# ── Шифрование ──────────────────────────────────────────────────────────────
# AES-256, пароль через файловый дескриптор — в списке процессов его не видно.
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$FILE"
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
  --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 \
  --compress-algo none --output "$OUT" "$DUMP" 3<<<"$BACKUP_PASSPHRASE"

# Контроль: расшифровываем обратно и сверяем с исходником.
ORIG_SUM=$(sha256sum < "$DUMP" | cut -d' ' -f1)
BACK_SUM=$(gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 \
  --decrypt "$OUT" 3<<<"$BACKUP_PASSPHRASE" | sha256sum | cut -d' ' -f1)
[ "$ORIG_SUM" = "$BACK_SUM" ] || die "зашифрованная копия не совпала с исходной"

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "backup: $FILE — $SIZE байт, таблиц с данными: $TABLES"

# ── Облако ──────────────────────────────────────────────────────────────────
WHERE="только локально: $OUT"
if [ -n "${S3_BUCKET:-}" ]; then
  command -v aws >/dev/null || die "нужен AWS CLI для загрузки в S3_BUCKET"
  # Новые версии AWS CLI по умолчанию шлют контрольные суммы, которые
  # понимают не все S3-совместимые хранилища (R2, B2 и др.).
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  S3=(aws)
  [ -n "${S3_ENDPOINT:-}" ] && S3+=(--endpoint-url "$S3_ENDPOINT")
  KEY="$PREFIX/$FILE"

  "${S3[@]}" s3 cp "$OUT" "s3://$S3_BUCKET/$KEY" --only-show-errors
  REMOTE=$("${S3[@]}" s3api head-object --bucket "$S3_BUCKET" --key "$KEY" \
    --query ContentLength --output text)
  [ "$REMOTE" = "$SIZE" ] || die "в облаке $REMOTE байт вместо $SIZE"
  WHERE="s3://$S3_BUCKET/$KEY"
  echo "backup: загружено в $WHERE"

  # Ротация: удаляем копии старше RETENTION_DAYS, но KEEP_MIN последних не
  # трогаем никогда — даже если бэкап месяцами падал, последние копии живы.
  CUTOFF=$(date -u -d "-$RETENTION_DAYS days" +%Y-%m-%dT%H:%M:%S 2>/dev/null \
    || date -u -v-"$RETENTION_DAYS"d +%Y-%m-%dT%H:%M:%S)
  mapfile -t ROWS < <("${S3[@]}" s3api list-objects-v2 --bucket "$S3_BUCKET" \
    --prefix "$PREFIX/$NAME-" --query 'sort_by(Contents,&LastModified)[].[Key,LastModified]' \
    --output text | grep '\.dump\.gpg' || true)
  TOTAL=${#ROWS[@]}
  DELETED=0
  for ((i = 0; i < TOTAL - KEEP_MIN; i++)); do
    read -r OLD_KEY OLD_DATE <<<"${ROWS[$i]}"
    if [[ "$OLD_DATE" < "$CUTOFF" ]]; then
      "${S3[@]}" s3 rm "s3://$S3_BUCKET/$OLD_KEY" --only-show-errors
      DELETED=$((DELETED + 1))
    fi
  done
  echo "backup: в облаке копий: $((TOTAL - DELETED)), удалено старых: $DELETED"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Резервная копия базы"
    echo "| | |"
    echo "|---|---|"
    echo "| Файл | \`$FILE\` |"
    echo "| Размер | $SIZE байт |"
    echo "| Таблиц с данными | $TABLES |"
    echo "| Postgres | $MAJOR |"
    echo "| Где | \`$WHERE\` |"
  } >> "$GITHUB_STEP_SUMMARY"
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "file=$OUT" >> "$GITHUB_OUTPUT"
fi
