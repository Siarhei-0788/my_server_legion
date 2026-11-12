# Развёртывание сервера LegiON в облаке

Два варианта. Для диплома и демонстрации на телефонах — **вариант A** (30–40 минут,
без Firebase и Docker). Вариант B — «взрослый» стек, если нужен настоящий продакшен.

---

## Вариант A. Демо-сервер за Caddy (рекомендуется)

Что нужно: VPS с Ubuntu 22.04/24.04 (1 CPU, 1 ГБ RAM достаточно), домен или поддомен,
доступ по SSH с sudo.

### 1. DNS

A-запись `legion.example.com` → IP сервера. Проверка: `ping legion.example.com`.

### 2. Подготовка сервера

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl ufw
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

Node.js 24:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # v24.x
```

Caddy (даёт бесплатный HTTPS автоматически):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### 3. Код и зависимости

Скопируйте папку `my-server` на сервер (scp/rsync/git), затем:

```bash
sudo useradd --system --create-home --home-dir /opt/legion legion
sudo chown -R legion:legion /opt/legion
cd /opt/legion
sudo -u legion npm ci --omit=dev
sudo mkdir -p /var/lib/legion && sudo chown legion:legion /var/lib/legion
```

### 4. Переменные окружения

`/etc/legion.env` (права `600`, владелец root):

```ini
PORT=3000
STATE_FILE=/var/lib/legion/state.json
ADMIN_USERNAME=admin
ADMIN_PASSWORD=замените-на-длинный-пароль
STUN_URLS=stun:stun.l.google.com:19302
# TURN — только если подняли coturn (см. раздел ниже)
# TURN_URLS=turn:legion.example.com:3478?transport=udp,turns:legion.example.com:5349?transport=tcp
# TURN_SHARED_SECRET=тот-же-секрет-что-в-turnserver.conf
AUTH_RATE_LIMIT=30
```

### 5. systemd

`/etc/systemd/system/legion.service`:

```ini
[Unit]
Description=LegiON relay
After=network.target

[Service]
Type=simple
User=legion
WorkingDirectory=/opt/legion
EnvironmentFile=/etc/legion.env
ExecStart=/usr/bin/node /opt/legion/server-dev.js
Restart=always
RestartSec=3
# корректное завершение: состояние сохраняется по SIGTERM
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now legion
sudo systemctl status legion
journalctl -u legion -n 50 --no-pager
```

В логе должно быть: `LegiON demo server on 0.0.0.0:3000`, `state file: /var/lib/legion/state.json`.

### 6. Caddy и HTTPS

`/etc/caddy/Caddyfile`:

```
legion.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl restart caddy
curl https://legion.example.com/health
```

Ожидаемый ответ: `{"status":"ok","demo":true,...}`. Сертификат Caddy получит сам.

### 7. Настройка приложения

На **каждом** устройстве: ☰ → «Настройки сети» → `https://legion.example.com` →
«Подключиться». Вход администратора: `admin` / пароль из `ADMIN_PASSWORD`.

> Сборка приложения: release требует HTTPS (так и есть), debug допускает и HTTP —
> для облака это не важно, но `https://` обязателен.

### 8. Обновление и бэкап

```bash
# обновление
sudo -u legion rsync -a --delete ./ /opt/legion/   # с локальной машины
sudo systemctl restart legion

# бэкап состояния
sudo cp /var/lib/legion/state.json /var/lib/legion/state-$(date +%F).json
```

Состояние (пользователи, токены, устройства, сообщения) хранится в `state.json`
и переживает перезапуск и повторный деплой.

---

## TURN: чтобы звонки работали через мобильные сети

Без TURN звонок проходит только когда оба устройства в одной сети или за «удобным» NAT.

```bash
sudo apt install -y coturn
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

`/etc/turnserver.conf`:

```ini
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=СЛУЧАЙНЫЙ_СЕКРЕТ_32+_СИМВОЛОВ
realm=legion.example.com
external-ip=IP_СЕРВЕРА
min-port=49160
max-port=49200
cert=/etc/letsencrypt/live/legion.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/legion.example.com/privkey.pem
no-cli
no-multicast-peers
no-loopback-peers
```

```bash
sudo systemctl enable --now coturn
sudo ufw allow 3478/tcp && sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49200/udp && sudo ufw allow 49160:49200/tcp
```

В `/etc/legion.env` раскомментируйте `TURN_URLS` и `TURN_SHARED_SECRET` (тот же секрет),
перезапустите `legion`. Проверка ICE — на https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
(в списке должен появиться `relay`).

---

## Вариант B. Production-стек (Docker + Firebase + PostgreSQL + Redis)

Нужны: Docker и Docker Compose на VPS, проект Firebase (Email/Password + FCM),
service account JSON, домен, сертификаты для coturn.

```bash
cd /opt/legion
cp .env.example .env      # заполнить пароли, секреты, пути к секретам
docker compose up -d --build
curl http://127.0.0.1:3000/health/ready
```

Дальше — Caddy перед портом 3000 (как в варианте A) и выдача прав администратора:

```bash
node scripts/set-firebase-claims.js <firebase-uid> grant admin
```

Подробности — в `README.md`.

---

## Чек-лист после деплоя

1. `https://legion.example.com/health` → 200.
2. Регистрация двух устройств по коду администратора.
3. Чат: сообщение доходит за 3–5 секунд.
4. Карта: позиция второго устройства появляется.
5. Сбор: уведомление приходит, «Принял» работает.
6. Звонок: в одной Wi-Fi, затем через мобильную сеть (с TURN).
7. `journalctl -u legion -f` — видны запросы, ошибок нет.

## Ограничения варианта A

- Нет FCM: уведомления приходят, пока приложение живо (foreground-сервис опроса).
  Android может выгрузить приложение — для «сбора по тревоге» это риск.
- Один процесс и файл состояния: не рассчитан на сотни пользователей.
- Демо-вход открыт: любой, кто знает адрес, может создать аккаунт. Для диплома
  приемлемо; для публичного сервиса используйте вариант B.
