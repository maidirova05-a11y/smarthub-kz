#!/usr/bin/env bash
# =============================================================================
# Восстановление базы из зашифрованной копии.
#
#   backup/restore.sh <файл.dump.gpg | latest>                 → в базу docker compose
#   backup/restore.sh <файл.dump.gpg | latest> postgres://…    → в любую базу по адресу
#
# latest — скачать самую свежую копию из облака (нужны те же S3_* и AWS_*
# переменные, что у backup.sh). Пароль берётся из BACKUP_PASSPHRASE, а если
# его нет — спрашивается.
#
# Существующие таблицы с теми же именами ЗАМЕНЯЮТСЯ содержимым копии. Для
# адреса не на localhost нужно подтверждение (или RESTORE_CONFIRM=yes).
# =============================================================================
set -euo pipefail

die() { echo "restore: $*" >&2; exit 1; }

SRC=${1:-}
TARGET=${2:-}
[ -n "$SRC" ] || die "укажите файл копии или latest (см. начало скрипта)"
command -v gpg >/dev/null || die "нужен gpg (apt install gnupg)"

WORK=$(mktemp -d)
export GNUPGHOME="$WORK/gnupg"
mkdir -m 700 "$GNUPGHOME"
trap 'rm -rf "$WORK"' EXIT

# ── Откуда ──────────────────────────────────────────────────────────────────
if [ "$SRC" = latest ]; then
  : "${S3_BUCKET:?restore: для latest нужен S3_BUCKET}"
  command -v aws >/dev/null || die "для latest нужен AWS CLI"
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  S3=(aws)
  [ -n "${S3_ENDPOINT:-}" ] && S3+=(--endpoint-url "$S3_ENDPOINT")
  PREFIX=${S3_PREFIX:-${BACKUP_NAME:-db}}
  KEY=$("${S3[@]}" s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$PREFIX/" \
    --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
  [[ "$KEY" == *.dump.gpg ]] || die "в s3://$S3_BUCKET/$PREFIX/ нет копий"
  echo "restore: беру s3://$S3_BUCKET/$KEY"
  SRC="$WORK/$(basename "$KEY")"
  "${S3[@]}" s3 cp "s3://$S3_BUCKET/$KEY" "$SRC" --only-show-errors
fi
[ -f "$SRC" ] || die "нет файла $SRC"

# Версия Postgres, на которой снята копия, записана в имени файла (…-pg17.dump.gpg).
DUMP_MAJOR=$(basename "$SRC" | sed -nE 's/.*-pg([0-9]+)\.dump\.gpg$/\1/p')
DUMP_MAJOR=${DUMP_MAJOR:-0}

# ── Расшифровка ─────────────────────────────────────────────────────────────
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  read -rsp "Пароль шифрования копий: " BACKUP_PASSPHRASE; echo
fi
DUMP="$WORK/db.dump"
gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 \
  --decrypt --output "$DUMP" "$SRC" 3<<<"$BACKUP_PASSPHRASE" \
  || die "не удалось расшифровать — неверный пароль или повреждённый файл"

# --clean --if-exists: объекты из копии сначала удаляются, если они уже есть
# (например, их успело создать приложение), так что повторный запуск безопасен.
# Владельцы и права не восстанавливаются: роли в новой базе другие.
OPTS=(--clean --if-exists --no-owner --no-privileges)

COUNT_SQL="SELECT table_schema || '.' || table_name AS table,
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I',
    table_schema, table_name), false, true, '')))[1]::text::bigint AS rows
FROM information_schema.tables
WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1;"

# ── Куда ────────────────────────────────────────────────────────────────────
if [ -z "$TARGET" ]; then
  # База из compose.yaml этого проекта.
  command -v docker >/dev/null || die "нужен Docker (или укажите адрес базы вторым аргументом)"
  SERVICE=${COMPOSE_DB_SERVICE:-db}
  docker compose up -d --wait "$SERVICE" >/dev/null
  # Имя базы и пользователя — те, с которыми создан контейнер.
  DB_USER=$(docker compose exec -T "$SERVICE" printenv POSTGRES_USER)
  DB_NAME=$(docker compose exec -T "$SERVICE" printenv POSTGRES_DB)
  HAVE=$(docker compose exec -T "$SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -XAtqc 'show server_version_num')
  HAVE=$((HAVE / 10000))
  [ "$HAVE" -ge "$DUMP_MAJOR" ] || die "копия с Postgres $DUMP_MAJOR, а в compose $HAVE — задайте POSTGRES_MAJOR=$DUMP_MAJOR в docker.env и пересоздайте db"
  # Приложение на время восстановления останавливаем, чтобы оно не писало
  # в базу посреди процесса, и потом запускаем снова.
  mapfile -t RUNNING < <(docker compose ps --services --status running | grep -vx "$SERVICE" || true)
  [ "${#RUNNING[@]}" -eq 0 ] || docker compose stop "${RUNNING[@]}"
  echo "restore: восстанавливаю в сервис $SERVICE (Postgres $HAVE)…"
  set +e
  docker compose exec -T "$SERVICE" pg_restore -U "$DB_USER" -d "$DB_NAME" "${OPTS[@]}" < "$DUMP"
  RC=$?
  set -e
  echo
  docker compose exec -T "$SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -Xqc "$COUNT_SQL"
  [ "${#RUNNING[@]}" -eq 0 ] || docker compose start "${RUNNING[@]}"
else
  HOST=$(sed -nE 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#p' <<<"$TARGET")
  if [[ "$HOST" != localhost && "$HOST" != 127.0.0.1 && "${RESTORE_CONFIRM:-}" != yes ]]; then
    echo "restore: ВНИМАНИЕ — данные в базе на $HOST будут заменены копией."
    read -rp "Введите имя хоста ($HOST), чтобы продолжить: " ANSWER
    [ "$ANSWER" = "$HOST" ] || die "отменено"
  fi
  export PGURL=$TARGET
  run() { # run <tool> [args…] — местный клиент, если он не старее копии, иначе Docker
    local tool=$1; shift
    local have; have=$("$tool" --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/' || true)
    if [ -n "$have" ] && [ "$have" -ge "$DUMP_MAJOR" ]; then
      "$tool" -d "$PGURL" "$@"
    elif command -v docker >/dev/null; then
      docker run --rm -i --network host -e PGURL "postgres:$((DUMP_MAJOR > 0 ? DUMP_MAJOR : 17))-alpine" \
        sh -c 'exec "$0" -d "$PGURL" "$@"' "$tool" "$@"
    else
      die "нужен $tool версии $DUMP_MAJOR+ или Docker"
    fi
  }
  echo "restore: восстанавливаю в $HOST…"
  set +e
  run pg_restore "${OPTS[@]}" < "$DUMP"
  RC=$?
  set -e
  echo
  run psql -Xqc "$COUNT_SQL"
fi

# pg_restore возвращает 1 и при безвредных предупреждениях; сами сообщения
# выше, а таблицы и число строк — последнее, что напечатано.
if [ "$RC" -ne 0 ]; then
  echo "restore: pg_restore сообщил об ошибках (см. выше). Проверьте, что нужные таблицы и строки на месте." >&2
  exit "$RC"
fi
echo "restore: готово"
