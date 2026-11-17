-- Структурированный профиль пользователя: позывной, должность, подразделение.
CREATE TABLE IF NOT EXISTS user_profiles (
    username text PRIMARY KEY,
    callsign text,
    position text,
    unit text,
    updated_at timestamptz NOT NULL DEFAULT now()
);
