# Развёртывание на VPS

Всё, что нужно с вашей стороны — создать сервер и запустить две команды.
Скрипт сам поставит Node.js 24, Caddy, systemd-сервис, настроит HTTPS и firewall.

## Что нужно от вас

1. **VPS с Ubuntu 22.04 или 24.04** (1 CPU, 1 ГБ RAM, 10 ГБ диска) и его IP.
   Подойдёт любой провайдер: Timeweb, Beget, REG.RU, Hetzner, Aeza и т.п.
2. **SSH-доступ root** (пароль или ключ) — выдаётся провайдером.
3. *(необязательно)* **домен**. Если домена нет, скрипт возьмёт
   `legion.<IP>.sslip.io` — это имя уже указывает на ваш IP, и Let's Encrypt
   выдаст на него сертификат. Покупать домен для диплома не обязательно.

## Шаг 1. Собрать архив (на Windows)

```powershell
cd F:\Diplom\my-server
deploy\bundle.cmd
```

Скрипт создаст `legion-server.tar.gz` рядом с папкой и напечатает две команды.

## Шаг 2. Скопировать и установить

```powershell
scp legion-server.tar.gz root@<IP>:/root/
ssh root@<IP> "mkdir -p /root/legion && tar -xzf /root/legion-server.tar.gz -C /root/legion && bash /root/legion/deploy/install.sh"
```

Если домен есть, добавьте его и почту:

```powershell
ssh root@<IP> "DOMAIN=legion.example.com EMAIL=you@example.com bash /root/legion/deploy/install.sh"
```

Если нужен свой пароль администратора:

```powershell
ssh root@<IP> "ADMIN_PASSWORD=МойДлинныйПароль bash /root/legion/deploy/install.sh"
```

Установка занимает 3–5 минут. В конце скрипт печатает URL, логин, пароль и путь
к файлу состояния. Если HTTPS сразу не ответил — подождите минуту и проверьте
`journalctl -u caddy -n 50 --no-pager` (Let's Encrypt иногда отвечает не с первой попытки).

## Шаг 3. Проверить

```powershell
curl https://legion.<IP>.sslip.io/health
```

Ожидается `{"status":"ok","demo":true,...}`.

В приложении на каждом телефоне: **☰ → Настройки сети** → `https://legion.<IP>.sslip.io`
→ «Подключиться». Вход: `admin` и пароль, который напечатал скрипт.

Дальше: Профиль → «Сгенерировать код» → на втором устройстве «Регистрация».

## Шаг 4 (по желанию). TURN для звонков через мобильную сеть

```powershell
ssh root@<IP> "bash /root/legion/deploy/install-turn.sh"
```

Скрипт поставит coturn, откроет порты 3478 и 49160–49200, прописывает
`TURN_URLS`/`TURN_SHARED_SECRET` в `/etc/legion.env` и перезапускает сервис.
Проверка — https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
(должен появиться кандидат типа `relay`).

## Обслуживание

```bash
systemctl status legion        # состояние
journalctl -u legion -f        # логи в реальном времени
systemctl restart legion       # перезапуск (состояние сохраняется)
cp /var/lib/legion/state.json /root/state-$(date +%F).json   # бэкап
```

Обновление после изменений кода:

```powershell
deploy\bundle.cmd
scp legion-server.tar.gz root@<IP>:/root/
ssh root@<IP> "tar -xzf /root/legion-server.tar.gz -C /root/legion && bash /root/legion/deploy/install.sh"
```

`install.sh` идемпотентен: переустанавливает зависимости, обновляет юнит и Caddyfile,
не трогает `/var/lib/legion/state.json` (данные сохраняются).

## Что скрипт не делает

- не создаёт VPS и не настраивает DNS — это делает провайдер и вы;
- не покупает домен (но умеет работать без него через `sslip.io`);
- не настраивает FCM: в демо-режиме push-уведомлений нет, сбор доставляется
  опросом, пока приложение живо. Для FCM нужен production-вариант (`README.md`,
  раздел Docker Compose).
