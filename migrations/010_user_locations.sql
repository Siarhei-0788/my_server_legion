-- Последняя известная позиция пользователя (одна строка на пользователя).
-- Обновляется через POST /api/location и рассылается сокетом location:update.
CREATE TABLE IF NOT EXISTS user_locations (
    username text PRIMARY KEY,
    callsign text,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
