#!/usr/bin/env bash
#
# LegiON — установка coturn, чтобы звонки работали через мобильные сети и NAT.
# Запускать на том же сервере после install.sh, от root:
#   sudo bash deploy/install-turn.sh
#
# Переменные:
#   DOMAIN=legion.example.com   по умолчанию берётся из /etc/caddy/Caddyfile
#   TURN_SECRET=...             по умолчанию генерируется
#
set -euo pipefail

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Запустите от root"

DOMAIN="${DOMAIN:-}"
if [[ -z "$DOMAIN" && -f /etc/caddy/Caddyfile ]]; then
    DOMAIN="$(awk 'NF && $1 !~ /^#/ {print $1; exit}' /etc/caddy/Caddyfile)"
fi
[[ -n "$DOMAIN" ]] || die "Не удалось определить домен. Задайте DOMAIN=..."

TURN_SECRET="${TURN_SECRET:-$(openssl rand -hex 32)}"
IP="$(curl -fsS https://api.ipify.org || true)"
[[ -n "$IP" ]] || die "Не удалось определить внешний IP"

export DEBIAN_FRONTEND=noninteractive
log "Установка coturn"
apt-get update -qq
apt-get install -y -qq coturn >/dev/null
sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn

log "Конфигурация /etc/turnserver.conf"
cat > /etc/turnserver.conf <<CONF
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=${DOMAIN}
server-name=${DOMAIN}
external-ip=${IP}
min-port=49160
max-port=49200
no-cli
no-multicast-peers
no-loopback-peers
CONF
chmod 640 /etc/turnserver.conf

systemctl enable coturn >/dev/null
systemctl restart coturn

log "Порты"
ufw allow 3478/tcp >/dev/null
ufw allow 3478/udp >/dev/null
ufw allow 49160:49200/udp >/dev/null
ufw allow 49160:49200/tcp >/dev/null

TURN_URLS="turn:${DOMAIN}:3478?transport=udp,turn:${DOMAIN}:3478?transport=tcp"
if [[ -f /etc/legion.env ]]; then
    log "Прописываю TURN в /etc/legion.env"
    sed -i '/^TURN_URLS=/d;/^TURN_SHARED_SECRET=/d' /etc/legion.env
    {
        echo "TURN_URLS=${TURN_URLS}"
        echo "TURN_SHARED_SECRET=${TURN_SECRET}"
    } >> /etc/legion.env
    systemctl restart legion || true
fi

echo
log "Готово"
echo "  TURN:   ${TURN_URLS}"
echo "  Секрет: ${TURN_SECRET}"
echo
echo "Проверка: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/"
echo "В списке кандидатов должен появиться тип relay."
echo "Логи coturn: journalctl -u coturn -f"
