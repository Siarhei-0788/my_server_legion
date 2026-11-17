-- Тактические знаки на карте (общие для всех) и значки, импортированные пользователями.
CREATE TABLE IF NOT EXISTS tactical_marks (
    id uuid PRIMARY KEY,
    type text NOT NULL,
    label text NOT NULL DEFAULT '',
    lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
    icon text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tactical_icons (
    id text PRIMARY KEY,
    name text NOT NULL,
    data text NOT NULL,
    created_by text NOT NULL
);
