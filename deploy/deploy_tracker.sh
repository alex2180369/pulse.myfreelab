#!/usr/bin/env bash
# Публикует демо трекеров. Запуск на сервере:
#   sudo bash /home/mylab/apps/tracker/deploy/deploy_tracker.sh
# Можно запускать повторно: обновит приложение, настройки сайта не трогает.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo" >&2; exit 1; }

APP=/home/mylab/apps/tracker
cd "$APP/deploy"

# Токен бота вводится здесь, на экране не показывается и в чат не попадает.
touch .env
chmod 600 .env
if ! grep -q '^BOT_TOKEN=.' .env; then
  read -rsp "Токен бота от BotFather (символы не видны, вставьте и нажмите Enter): " TOKEN
  echo
  NAME=$(curl -sS -m 15 "https://api.telegram.org/bot${TOKEN}/getMe" | grep -o '"username":"[^"]*"' | cut -d'"' -f4 || true)
  [ -n "$NAME" ] || { echo "Telegram не принял токен, проверьте его и запустите скрипт ещё раз" >&2; exit 1; }
  echo "BOT_TOKEN=$TOKEN" > .env
  echo "Бот найден: @$NAME"
fi

echo "== Собираю контейнер, это пара минут"
docker compose up -d --build
for port in 8801 8802 8803; do
  for i in $(seq 1 30); do
    curl -sf -m 3 "http://127.0.0.1:$port/health" >/dev/null && break
    sleep 2
  done
  curl -sS -m 5 "http://127.0.0.1:$port/health"; echo
done

site() {
  local HOST=$1 PORT=$2 MAX=${3:-1m} CONF=/etc/nginx/sites-available/$1
  if [ ! -e "$CONF" ]; then
    cat > "$CONF" <<NGINX
server {
    listen 80;
    server_name $HOST;
    client_max_body_size $MAX;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
    ln -sf "$CONF" "/etc/nginx/sites-enabled/$HOST"
    nginx -t
    systemctl reload nginx
  fi
  if [ ! -d "/etc/letsencrypt/live/$HOST" ]; then
    # Почта берётся из учётной записи certbot, уже настроенной на сервере.
    certbot --nginx -d "$HOST" --non-interactive --agree-tos --redirect
    nginx -t
    systemctl reload nginx
  fi
  printf "https://%s/ -> " "$HOST"
  curl -sS -o /dev/null -w "%{http_code}\n" -m 10 "https://$HOST/" || true
}

site pulse.myfreelab.ru 8801
site seriya.myfreelab.ru 8802
site prorab.myfreelab.ru 8803 4m

docker compose ps
echo "Готово"
