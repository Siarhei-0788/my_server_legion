#!/usr/bin/env bash
#
# LegiON — установка демонстрационного сервера на Ubuntu 22.04/24.04.
#
# Запускать на сервере от root из корня папки my-server:
#   sudo bash deploy/install.sh
#
# Переменные (все необязательные):
#   DOMAIN=legion.example.com   домен; если не задан — определится IP и возьмётся
#                               legion.<IP>.sslip.io (сертификат Let's Encrypt
#                               выпустится без покупки домена)
#   EMAIL=you@example.com       для Let's Encrypt (необязательно)
#   ADMIN_PASSWORD=...          пароль администратора; если не задан — сгенерируется
#   PORT=3000                   локальный порт приложения
#   TURN_URLS / TURN_SHARED_SECRET — если coturn уже установлен (см. install-turn.sh)
#
set -euo pipefail

APP_DIR=/opt/legion
DATA_DIR=/var/lib/legion
SERVICE_NAME=legion
SERVICE_USER=legion
PORT="${PORT:-3000}"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
TURN_URLS="${TURN_URLS:-}"
TURN_SHARED_SECRET="${TURN_SHARED_SECRET:-}"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Запустите от root: sudo bash deploy/install.sh"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$SRC_DIR/server-dev.js" ]] || die "server-dev.js не найден в $SRC_DIR"
[[ -f "$SRC_DIR/package.json" ]] || die "package.json не найден в $SRC_DIR"

export DEBIAN_FRONTEND=noninteractive

log "Базовые пакеты"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg ufw rsync openssl >/dev/null

log "Node.js 24"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [[ "$NODE_MAJOR" -ge 24 ]] && NEED_NODE=0
fi
if [[ $NEED_NODE -eq 1 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
fi
log "node $(node --version), npm $(npm --version)"

log "Caddy"
if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
fi
log "caddy $(caddy version | head -n1)"

log "Пользователь и каталоги"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/legion "$SERVICE_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete \
    --exclude node_modules --exclude data --exclude .git --exclude '*.log' \
    "$SRC_DIR"/ "$APP_DIR"/
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR" "$DATA_DIR"

log "Зависимости"
( cd "$APP_DIR" && sudo -u "$SERVICE_USER" npm ci --omit=dev --no-audit --no-fund >/dev/null )
log "установлено пакетов: $(ls "$APP_DIR/node_modules" | wc -l)"

if [[ -z "$DOMAIN" ]]; then
    IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me || true)"
    [[ -n "$IP" ]] || die "Не удалось определить внешний IP. Задайте DOMAIN=..."
    DOMAIN="legion.${IP}.sslip.io"
    warn "Домен не задан, использую $DOMAIN (DNS уже указывает на этот IP)"
fi

if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)"
    warn "Пароль администратора сгенерирован: ${ADMIN_PASSWORD}"
fi

log "Конфигурация /etc/legion.env"
cat > /etc/legion.env <<ENV
PORT=${PORT}
STATE_FILE=${DATA_DIR}/state.json
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=${TURN_URLS}
TURN_SHARED_SECRET=${TURN_SHARED_SECRET}
AUTH_RATE_LIMIT=30
RTC_CALL_TIMEOUT_MS=60000
ENV
chmod 600 /etc/legion.env

log "systemd-юнит"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<UNIT
[Unit]
Description=LegiON relay server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/legion.env
ExecStart=/usr/bin/node ${APP_DIR}/server-dev.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

log "Caddyfile"
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:${PORT}
}
CADDY
systemctl enable caddy >/dev/null
systemctl restart caddy

log "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
if [[ -n "$TURN_URLS" ]]; then
    ufw allow 3478/tcp >/dev/null
    ufw allow 3478/udp >/dev/null
    ufw allow 49160:49200/udp >/dev/null
    ufw allow 49160:49200/tcp >/dev/null
fi
ufw --force enable >/dev/null

log "Ожидание HTTPS (Let's Encrypt, до 90 секунд)"
OK=0
for _ in $(seq 1 30); do
    if curl -fsS "https://${DOMAIN}/health" >/tmp/legion-health.json 2>/dev/null; then
        OK=1
        break
    fi
    sleep 3
done

echo
if [[ $OK -eq 1 ]]; then
    log "Готово"
    echo "  URL:      https://${DOMAIN}"
    echo "  Health:   $(cat /tmp/legion-health.json)"
else
    warn "HTTPS ещё не отвечает. Проверьте: journalctl -u caddy -n 50 --no-pager"
fi
echo "  Логин:    ${ADMIN_USERNAME}"
echo "  Пароль:   ${ADMIN_PASSWORD}"
echo "  Состояние: ${DATA_DIR}/state.json"
echo "  Логи:     journalctl -u ${SERVICE_NAME} -f"
echo
echo "Дальше: в приложении «Настройки сети» → https://${DOMAIN} → Подключиться."
