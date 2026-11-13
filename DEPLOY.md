# Развёртывание сервера LegiON

Текущая схема (вариант A, demo-режим):

```
телефон ──HTTPS/WSS──▶ nginx (dev.myoffer.life:443, Let's Encrypt)
                          └──▶ 127.0.0.1:3000  pm2 «legion» → node server-dev.js
```

| Что | Где |
|---|---|
| Код | `/home/myoffer/projects/my_server_legion` (запуск прямо из репозитория) |
| Процесс | pm2, имя `legion`, пользователь `myoffer` |
| Node.js | v24 через nvm (`~/.nvm/versions/node/v24.14.1`) |
| Переменные окружения | `~/.config/legion/legion.env` (права `600`, **не в репозитории**) |
| Состояние | `~/.local/share/legion/state.json` |
| Логи | `pm2 logs legion` (`~/.pm2/logs/legion-*.log`) |
| Публичный адрес | `https://dev.myoffer.life` |

Без Firebase, Docker и Caddy: HTTPS даёт уже установленный nginx.

---

## 1. Зависимости

```bash
cd ~/projects/my_server_legion
grep -c "socket.emit('rtc:ready')" server-dev.js   # должно быть 1 (фикс сигналинга звонков)
npm ci --omit=dev --no-audit --no-fund
```

## 2. Переменные окружения

`~/.config/legion/legion.env`:

```ini
PORT=3000
STATE_FILE=/home/myoffer/.local/share/legion/state.json
ADMIN_USERNAME=admin
ADMIN_PASSWORD=длинный-случайный-пароль
STUN_URLS=stun:stun.l.google.com:19302
# TURN — только если поднят coturn (см. ниже)
# TURN_URLS=turn:dev.myoffer.life:3478?transport=udp,turns:dev.myoffer.life:5349?transport=tcp
# TURN_SHARED_SECRET=тот-же-секрет-что-в-turnserver.conf
AUTH_RATE_LIMIT=30
RTC_CALL_TIMEOUT_MS=60000
```

```bash
mkdir -p ~/.config/legion ~/.local/share/legion
chmod 600 ~/.config/legion/legion.env
openssl rand -base64 18 | tr -d '/+='   # сгенерировать пароль
```

Администратор создаётся при **первом** запуске, когда `state.json` ещё нет. Если потом
поменять `ADMIN_PASSWORD`, пароль уже созданного админа может остаться прежним.

## 3. Запуск через pm2

```bash
cd ~/projects/my_server_legion
pm2 start server-dev.js --name legion \
  --node-args="--env-file=/home/myoffer/.config/legion/legion.env" \
  --kill-timeout 10000          # время на сохранение state.json по SIGINT
pm2 save
```

Автозапуск после перезагрузки (один раз, нужен sudo):

```bash
pm2 startup systemd -u myoffer --hp /home/myoffer   # выведет команду с sudo — выполнить её
pm2 save
```

Проверка:

```bash
pm2 status legion                           # online
pm2 logs legion --lines 20 --nostream       # "LegiON demo server on 0.0.0.0:3000",
                                            # "admin: admin / (from ADMIN_PASSWORD)",
                                            # "state file: /home/myoffer/.local/share/legion/state.json"
curl -fsS http://127.0.0.1:3000/health      # {"status":"ok","demo":true,...}
```

## 4. nginx

Блок в `/etc/nginx/nginx.conf` уже есть, менять его не нужно. Обязательны заголовки
`Upgrade`/`Connection`: без них не работает WebSocket Socket.IO, а значит и звонки.

```nginx
server {
    listen 443 ssl;
    server_name dev.myoffer.life;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    ssl_certificate     /etc/letsencrypt/live/dev.myoffer.life/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dev.myoffer.life/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}
```

После правок: `sudo nginx -t && sudo systemctl reload nginx`.

Проверка снаружи:

```bash
curl -fsS https://dev.myoffer.life/health; echo
# {"status":"ok","demo":true,...}
curl -fsS "https://dev.myoffer.life/socket.io/?EIO=4&transport=polling" | head -c 40; echo
# 0{"sid":...
curl -si -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://dev.myoffer.life/socket.io/?EIO=4&transport=websocket" | head -1
# HTTP/1.1 101 Switching Protocols
```

## 5. Настройка приложения

На **каждом** телефоне: ☰ → «Настройки сети» → `https://dev.myoffer.life` → «Подключиться».
Вход администратора: `admin` / пароль из `ADMIN_PASSWORD`. Второму устройству выдать код
регистрации (Профиль → «Сгенерировать код»).

## 6. Обновление и бэкап

```bash
cd ~/projects/my_server_legion
cp ~/.local/share/legion/state.json ~/.local/share/legion/state-$(date +%F-%H%M).json  # бэкап
git pull
grep -c "socket.emit('rtc:ready')" server-dev.js   # 1
npm ci --omit=dev --no-audit --no-fund
pm2 restart legion
curl -fsS https://dev.myoffer.life/health
```

Состояние (пользователи, токены, устройства, сообщения) лежит вне репозитория и переживает
перезапуск и обновление кода.

Полезное:

```bash
pm2 logs legion            # логи в реальном времени
pm2 restart legion         # после правки legion.env
pm2 describe legion        # параметры запуска
```

---

## TURN: чтобы звонки работали через мобильные сети

Без TURN звонок проходит, только когда оба устройства в одной сети или за «удобным» NAT.

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
static-auth-secret=СЛУЧАЙНЫЙ_СЕКРЕТ_32+_СИМВОЛОВ   # openssl rand -hex 32
realm=dev.myoffer.life
external-ip=IP_СЕРВЕРА        # при NAT в облаке: ВНЕШНИЙ_IP/ПРИВАТНЫЙ_IP
min-port=49160
max-port=49200
cert=/etc/letsencrypt/live/dev.myoffer.life/fullchain.pem
pkey=/etc/letsencrypt/live/dev.myoffer.life/privkey.pem
no-cli
no-multicast-peers
no-loopback-peers
```

Сертификат nginx/certbot читается только root, а coturn работает от `turnserver`, поэтому
нужен доступ к ключу:

```bash
sudo setfacl -R -m u:turnserver:rX /etc/letsencrypt/live /etc/letsencrypt/archive
sudo systemctl enable --now coturn
```

Порты: в `ufw` (если включён) и в облачном firewall провайдера:

```bash
sudo ufw allow 3478/tcp && sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49200/udp && sudo ufw allow 49160:49200/tcp
```

В `~/.config/legion/legion.env` раскомментировать `TURN_URLS` и `TURN_SHARED_SECRET`
(тот же секрет), затем `pm2 restart legion`. В логе должно появиться `TURN: turn:dev.myoffer.life:3478...`
вместо `not configured`.

Проверка ICE: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
(в списке кандидатов должен быть `relay`). Временные учётные данные:

```bash
SECRET=$(grep '^TURN_SHARED_SECRET=' ~/.config/legion/legion.env | cut -d= -f2-)
U="$(( $(date +%s) + 3600 )):smoke"
P=$(printf '%s' "$U" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)
echo "URI: turn:dev.myoffer.life:3478   username: $U   password: $P"
```

---

## Вариант B. Production-стек (Docker + Firebase + PostgreSQL + Redis)

Только при наличии проекта Firebase (Email/Password + FCM) и service account JSON.
Перед запуском остановить demo: `pm2 delete legion && pm2 save` (оба слушают порт 3000).

```bash
cd ~/projects/my_server_legion
cp .env.example .env      # заполнить пароли, секреты, пути к секретам; TRUST_PROXY=1
docker compose up -d --build
curl http://127.0.0.1:3000/health/ready
```

nginx остаётся тем же (`proxy_pass http://127.0.0.1:3000`). Права администратора:

```bash
node scripts/set-firebase-claims.js <firebase-uid> grant admin
```

Подробности — в `README.md`.

---

## Чек-лист после деплоя

1. `https://dev.myoffer.life/health` → 200.
2. Регистрация двух устройств по коду администратора.
3. Чат: сообщение доходит за 3–5 секунд.
4. Карта: позиция второго устройства появляется.
5. Сбор: уведомление приходит, «Принял» работает.
6. Звонок: в одной Wi-Fi, затем через мобильную сеть (с TURN).
7. `pm2 logs legion` — видны запросы, ошибок нет.

## Неполадки

| Симптом | Что проверить |
|---|---|
| `/health` → 502 | `pm2 status legion`, `pm2 logs legion`; слушает ли 3000: `ss -ltnp \| grep 3000` |
| Порт 3000 занят | Другой процесс pm2 или старый запуск: `pm2 ls`, `ss -ltnp \| grep 3000` |
| Socket.IO не отвечает `0{"sid"` / нет `101` | В блоке nginx нет `proxy_http_version 1.1` или заголовков `Upgrade`/`Connection` |
| `http://dev.myoffer.life` → 404 вместо редиректа | В блоке `listen 80` после списка `server_name` не хватает `;` |
| После перезагрузки сервер не поднялся | Не выполнен `pm2 startup` или забыт `pm2 save` |
| Звонок висит на «Соединение…» | В `server-dev.js` нет `rtc:ready` → обновить код |
| «Сигналинг отклонил запрос: target_unreachable» | У собеседника не запущено приложение / нет сети (в demo нет push) |
| Звонок соединяется, но нет звука/видео через мобильную сеть | TURN: `systemctl status coturn`, порты 3478 и 49160–49200 (UDP!), `external-ip`, trickle-ice даёт `relay` |

## Ограничения demo-режима

- Нет FCM: уведомления и входящие звонки приходят, пока приложение живо (foreground-сервис
  опроса). Android может выгрузить приложение — не закрывайте его свайпом.
- Один процесс и файл состояния: не рассчитан на сотни пользователей.
- Демо-вход открыт: любой, кто знает адрес, может создать аккаунт. Для диплома
  приемлемо; для публичного сервиса — вариант B.
