#!/bin/bash
# Поднимает демо и рабочий режим на временных базах и запускает проверку в браузере.
cd "$(dirname "$0")/.."
# Путь к Electron задаётся переменной ELECTRON, при необходимости вместе с LD_LIBRARY_PATH.
OUT=${1:-/tmp/tr_e2e_out}
rm -rf /tmp/tr_e2e_db; mkdir -p /tmp/tr_e2e_db "$OUT"
DEMO=1 PORT=8811 DB_FILE=/tmp/tr_e2e_db/demo.sqlite node --disable-warning=ExperimentalWarning cases/01_zadachi/app/server.js > /tmp/tr_e2e_db/demo.log 2>&1 &
A=$!
DEMO= PORT=8812 ADMIN_LOGIN=boss ADMIN_PASSWORD=adminpass1 DB_FILE=/tmp/tr_e2e_db/work.sqlite node --disable-warning=ExperimentalWarning cases/01_zadachi/app/server.js > /tmp/tr_e2e_db/work.log 2>&1 &
B=$!
sleep 2.5
timeout 120 "${ELECTRON:-electron}" --ozone-platform=headless --ozone-override-screen-size=1600,1000 --no-sandbox tools/e2e_zadachi.js http://127.0.0.1:8811/ http://127.0.0.1:8812/ "$OUT" 2>&1 | grep -vE 'dbus|GPU|gl_|ERROR:|WARNING:|GLib|^$'
kill $A $B
echo '--- server logs'; cat /tmp/tr_e2e_db/demo.log /tmp/tr_e2e_db/work.log | tail -n 8
