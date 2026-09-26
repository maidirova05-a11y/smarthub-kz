#!/bin/sh
# Включает TLS в Postgres из compose.yaml. Выполняется один раз — при создании
# пустой базы (docker-entrypoint-initdb.d).
#
# Зачем: приложения в проде подключаются к базе только по TLS и не делают
# исключения для «своей» базы. Сертификат самоподписанный и свой у каждой
# установки; база наружу не открыта, так что проверять его некому.
set -eu

KEY="$PGDATA/server.key"
CRT="$PGDATA/server.crt"

if command -v openssl >/dev/null 2>&1; then
  openssl req -new -x509 -days 3650 -nodes -subj "/CN=db" \
    -newkey rsa:2048 -keyout "$KEY" -out "$CRT" 2>/dev/null
elif [ -f /etc/ssl/private/ssl-cert-snakeoil.key ]; then
  cp /etc/ssl/certs/ssl-cert-snakeoil.pem "$CRT"
  cp /etc/ssl/private/ssl-cert-snakeoil.key "$KEY"
else
  echo "10-tls.sh: нет openssl — TLS не включён" >&2
  exit 1
fi
chmod 600 "$KEY"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "ALTER SYSTEM SET ssl = on"
