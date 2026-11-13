# Runbook: развёртывание сервера LegiON (для Claude Code на сервере)

Этот файл — пошаговая инструкция для агента, который запущен **на целевом сервере**
(Ubuntu 22.04/24.04) в папке `my_server_legion`. Выполняй шаги по порядку, проверяй
ожидаемый результат каждого шага и не переходи дальше, если он не совпал.

## 0. Что выбрать и что спросить у пользователя

**Режим.** По умолчанию разворачивай **demo-режим** (`server-dev.js`, без Firebase/Docker):
Node.js + systemd + Caddy (HTTPS) + coturn (TURN для звонков). Это то, с чем работает
Android-приложение без дополнительной настройки. Production-стек (Docker + Firebase +
PostgreSQL + Redis) — только если пользователь явно просит и у него есть service
account Firebase; см. раздел «Вариант B» в конце.

Перед началом спроси одним сообщением (только то, что пользователь ещё не сообщил):

1. **Домен** — есть ли A-запись, указывающая на этот сервер? Если нет — используется
   `legion.<IP>.sslip.io` автоматически, это нормально.
2. **Email** для Let's Encrypt (необязательно).
3. **Пароль администратора** — задать свой или сгенерировать.
4. **TURN** — ставить ли coturn. Рекомендуй «да»: без TURN звонки работают только
   в одной Wi-Fi сети, через мобильный интернет — без звука/видео.

## 1. Предварительные проверки (стоп-условия)

```bash
cat /etc/os-release | grep -E '^(ID|VERSION_ID)='     # ubuntu, 22.04 или 24.04
sudo -n true && echo sudo-ok                           # нужны права root/sudo
sudo ss -ltnp | grep -E ':(80|443|3000)\s'             # порты должны быть свободны
                                                       # (или заняты caddy/legion от прошлой установки)
curl -fsS https://api.ipify.org; echo                  # внешний IP
getent hosts <DOMAIN>                                  # если домен свой: должен вернуть внешний IP
```

**Остановись и спроси пользователя**, если:
- ОС не Ubuntu 22.04/24.04;
- порты 80/443 заняты **не** Caddy (например, nginx/apache с другими сайтами);
- `/etc/caddy/Caddyfile` уже существует и содержит **другие** сайты —
  `install.sh` **полностью перезаписывает** этот файл;
- свой домен не резолвится во внешний IP сервера (Let's Encrypt не выдаст сертификат).

Также напомни пользователю: если у провайдера есть **облачный firewall / security group**
(AWS, Yandex Cloud, Selectel, Hetzner Cloud Firewall и т.п.), в нём нужно открыть
TCP 22, 80, 443, а для TURN ещё UDP+TCP 3478 и UDP+TCP 49160–49200. `ufw` на сервере
скрипты настроят сами, облачный firewall — нет.

## 2. Проверка кода перед установкой

Убедись, что в коде есть исправление сигналинга звонков (без него звонки висят на
«Соединение…»):

```bash
grep -c "socket.emit('rtc:ready')" server-dev.js       # ожидается 1
```

Если `0` — код устаревший, остановись и сообщи пользователю.

Тесты (необязательно, требуют Node.js ≥ 24; если Node ещё нет — выполни после шага 3):

```bash
TMP=$(mktemp -d) && cp -r . "$TMP" && cd "$TMP" && rm -rf node_modules data \
  && npm ci --no-audit --no-fund && node --test test/rtc-signaling.test.js test/demo-server.test.js; cd - ; rm -rf "$TMP"
```

Ожидается `pass 6, fail 0`.

## 3. Установка сервера

Из папки `my_server_legion` (подставь только заданные пользователем значения):

```bash
sudo DOMAIN=legion.example.com EMAIL=you@example.com ADMIN_PASSWORD='...' bash deploy/install.sh
```

Без домена и пароля достаточно `sudo bash deploy/install.sh`.

Скрипт: ставит Node.js 24 и Caddy, копирует код в `/opt/legion`, пишет
`/etc/legion.env`, создаёт systemd-юнит `legion` (запускает `server-dev.js`),
настраивает Caddy (HTTPS → 127.0.0.1:3000) и `ufw`. Длится 3–5 минут.

**Ожидается** в конце: `==> Готово`, строка `URL: https://...` и `Health: {"status":"ok","demo":true,...}`.
Если вместо этого «HTTPS ещё не отвечает» — подожди 1–2 минуты и смотри
`journalctl -u caddy -n 50 --no-pager` (см. «Неполадки»).

Запомни из вывода URL, логин и пароль — они нужны для финального отчёта.

## 4. Установка TURN (coturn)

```bash
sudo bash deploy/install-turn.sh
```

Скрипт ставит coturn, пишет `/etc/turnserver.conf`, открывает порты в `ufw`,
дописывает `TURN_URLS` и `TURN_SHARED_SECRET` в `/etc/legion.env` и перезапускает `legion`.

**Важно для облаков с NAT** (AWS, GCP, Yandex Cloud и др., где на сетевом интерфейсе
приватный IP): проверь

```bash
ip -4 addr show scope global | grep inet
```

Если внешний IP (из шага 1) **не** виден на интерфейсе, исправь в `/etc/turnserver.conf`
строку на формат `external-ip=<ВНЕШНИЙ_IP>/<ПРИВАТНЫЙ_IP>` и выполни
`sudo systemctl restart coturn`. Иначе TURN будет выдавать недостижимые адреса.

## 5. Проверка

```bash
DOMAIN=$(awk 'NF && $1 !~ /^#/ {print $1; exit}' /etc/caddy/Caddyfile)
systemctl is-active legion caddy coturn                      # все: active
curl -fsS https://$DOMAIN/health; echo                       # {"status":"ok","demo":true,...}
curl -fsS "https://$DOMAIN/socket.io/?EIO=4&transport=polling" | head -c 60; echo
                                                             # начинается с 0{"sid":  — Socket.IO доступен через Caddy
sudo journalctl -u legion -n 30 --no-pager | grep -E 'demo server|TURN:'
                                                             # "TURN: turn:<домен>:3478..." (не "not configured")
grep -c "socket.emit('rtc:ready')" /opt/legion/server-dev.js # 1
sudo ss -lnup | grep 3478                                    # coturn слушает UDP 3478
sudo ufw status | grep -E '443|3478|49160'
```

Проверка TURN снаружи (делает пользователь в браузере). Сгенерируй временные
учётные данные и передай их пользователю:

```bash
SECRET=$(sudo grep '^TURN_SHARED_SECRET=' /etc/legion.env | cut -d= -f2-)
U="$(( $(date +%s) + 3600 )):smoke"
P=$(printf '%s' "$U" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)
echo "URI: turn:$DOMAIN:3478   username: $U   password: $P"
```

Пользователь открывает https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/,
добавляет этот сервер, жмёт «Gather candidates» — в списке должен быть тип **relay**.
Учётные данные действуют 1 час.

## 6. Финальный отчёт пользователю

Сообщи:
- URL сервера (`https://<домен>`), логин `admin` и пароль;
- статус TURN (настроен / нет, результат проверок);
- что сделать в приложении: на **каждом** телефоне ☰ → «Настройки сети» →
  `https://<домен>` → «Подключиться»; войти; второму устройству выдать код
  регистрации (Профиль → «Сгенерировать код»);
- что в demo-режиме нет FCM: входящий звонок приходит, только пока приложение
  запущено (работает фоновая служба), поэтому не стоит закрывать его свайпом;
- как проверить звонок: сначала оба телефона в одной Wi-Fi, затем один — через мобильную сеть.

Не записывай пароли и секреты в файлы репозитория и не коммить их.

## Обновление (повторный деплой)

```bash
cd <папка с новым кодом my_server_legion>
grep -c "socket.emit('rtc:ready')" server-dev.js   # 1
sudo bash deploy/install.sh
```

`install.sh` идемпотентен: сохраняет из прежних `/etc/legion.env` и `/etc/caddy/Caddyfile`
пароль администратора, настройки TURN и домен (если они не переданы явно) и не трогает
данные `/var/lib/legion/state.json`. **Не** запускай повторно `install-turn.sh` без
необходимости — он сгенерирует новый секрет (это не ломает работу, но лишнее).

Перед обновлением сделай бэкап:

```bash
sudo cp /var/lib/legion/state.json /root/state-$(date +%F-%H%M).json
```

## Неполадки

| Симптом | Что проверить |
|---|---|
| HTTPS не отвечает | `journalctl -u caddy -n 50 --no-pager`; DNS домена → IP сервера; порты 80/443 открыты в облачном firewall; лимиты Let's Encrypt |
| `legion` не active | `journalctl -u legion -n 50 --no-pager`. `Set TURN_URLS and TURN_SHARED_SECRET together` → в `/etc/legion.env` задан только один из них |
| `/health` 502 | `legion` упал или слушает не тот порт: `ss -ltnp \| grep 3000` |
| Socket.IO-проверка не `0{"sid"` | Caddyfile должен быть `reverse_proxy 127.0.0.1:3000` без лишних правил |
| Звонок висит на «Соединение…» | В `/opt/legion/server-dev.js` нет `rtc:ready` → обнови код |
| «Сигналинг отклонил запрос: target_unreachable» | У собеседника не запущено приложение / нет сети (в demo нет push) |
| Звонок соединяется, но нет звука/видео через мобильную сеть | TURN: `systemctl status coturn`, порты 3478 и 49160–49200 (UDP!) в облачном firewall, `external-ip` (см. шаг 4), trickle-ice должен давать `relay` |
| Логи coturn | `journalctl -u coturn -f` |

Полезное: `systemctl restart legion`, `journalctl -u legion -f`, конфиг — `/etc/legion.env`
(после правки — `systemctl restart legion`).

## Вариант B: production (только по явной просьбе)

Нужно от пользователя: JSON service account Firebase, `FIREBASE_PROJECT_ID`, домен,
TLS-сертификаты для coturn (`fullchain.pem`, `privkey.pem`).

```bash
sudo apt-get install -y docker.io docker-compose-v2
cp .env.example .env            # заполнить все значения, секреты — длинные случайные (openssl rand -hex 32)
mkdir -p secrets                # firebase-service-account.json, fullchain.pem, privkey.pem
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/health/ready      # {"status":"ready"}
```

Особенности:
- `TURN_EXTERNAL_IP` в формате `<ВНЕШНИЙ_IP>/172.30.0.10` (второй адрес — IP контейнера coturn в compose);
- перед портом 3000 поставь Caddy, как в шаге 3 (`reverse_proxy 127.0.0.1:3000`), и задай `TRUST_PROXY=1`;
- права пользователям: `node scripts/set-firebase-claims.js <uid> grant user|admin`;
- Android-сборка должна содержать `LEGION_FIREBASE_*` в `gradle.properties`, иначе FCM-push входящих звонков не работает.
