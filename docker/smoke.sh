#!/usr/bin/env bash
# Проверка Docker-версии: собрать, поднять и убедиться, что сайт, API заявок
# и админка работают. Запускается в CI (.github/workflows/docker.yml), можно
# и руками на сервере после восстановления.
#
#   docker/smoke.sh          собрать, поднять, проверить
#   docker/smoke.sh check    только проверить уже запущенное
set -euo pipefail
cd "$(dirname "$0")/.."

BASE=http://127.0.0.1:${APP_PORT:-3105}
CI_PASSWORD=ci-admin-password-123
CI_MARK="# создан docker/smoke.sh — тестовые секреты"
FAIL=0

if [ "${1:-}" != check ]; then
  if [ ! -f docker.env ]; then
    # Тестовые секреты — только для проверки, не для боевого запуска.
    {
      echo "$CI_MARK"
      grep -vE '^(ADMIN_PASSWORD|ADMIN_SECRET)=' docker.env.example
      echo "ADMIN_PASSWORD=$CI_PASSWORD"
      echo "ADMIN_SECRET=$(openssl rand -hex 32)"
    } > docker.env
  fi
  docker compose up -d --build
fi

for _ in $(seq 1 90); do
  curl -sf -o /dev/null "$BASE/robots.txt" && break
  sleep 2
done

ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAIL=1; }
expect() { # expect <код> <путь> [curl-аргументы…]
  local want=$1 path=$2; shift 2
  local got; got=$(curl -s -o /dev/null -w '%{http_code}' "$@" "$BASE$path")
  [ "$got" = "$want" ] && ok "$path → $got" || bad "$path → $got (ожидалось $want)"
}

echo "smarthub: $BASE"
for p in / /en /kz /privacy /oferta /admin /robots.txt /sitemap.xml /assets/logo.png; do expect 200 "$p"; done
expect 308 /en/
expect 308 /privacy.html
# Код функций и служебные файлы по URL недоступны.
for p in /api/lead.js /lib/store.js /package.json /vercel.json; do expect 404 "$p"; done
[ -n "$(curl -sI "$BASE/" | grep -i '^content-security-policy:')" ] && ok "заголовки из vercel.json" || bad "нет CSP из vercel.json"

NAME="Проверка Докер $RANDOM"
expect 200 /api/lead -X POST -H "Origin: $BASE" -H 'Content-Type: application/json' \
  -H "X-Real-IP: 198.51.100.$((RANDOM % 250))" \
  --data "{\"name\":\"$NAME\",\"phone\":\"+7 701 555 44 33\",\"consent\":true,\"elapsed\":5000}"

if [ -n "${SMOKE_ADMIN_PASSWORD:-}" ] || grep -qx "$CI_MARK" docker.env; then
  COOKIE=$(curl -s -D - -o /dev/null -X POST "$BASE/api/login" -H "Origin: $BASE" -H 'Content-Type: application/json' \
    -H "X-Real-IP: 203.0.113.$((RANDOM % 250))" --data "{\"password\":\"${SMOKE_ADMIN_PASSWORD:-$CI_PASSWORD}\"}" \
    | sed -nE 's/^[Ss]et-[Cc]ookie: ([^;]+).*/\1/p' | tr -d '\r')
  [ -n "$COOKIE" ] && ok "вход в админку" || bad "вход в админку не удался"
  grep -q "$NAME" <<<"$(curl -s "$BASE/api/leads" -H "Cookie: $COOKIE")" && ok "заявка видна в админке" || bad "заявки нет в списке"
fi

if [ "$FAIL" -ne 0 ]; then
  docker compose ps -a
  docker compose logs --tail 80
  exit 1
fi
echo "smarthub: всё работает"
