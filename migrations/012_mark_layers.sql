-- Слои тактических знаков как отдельная сущность (раньше слой был просто строкой у знака).
-- Слой может существовать без знаков; список слоёв общий для подразделения.
-- Migrate.js применяет все файлы при каждом запуске, поэтому скрипт идемпотентен.
CREATE TABLE IF NOT EXISTS tactical_layers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    "order" integer NOT NULL DEFAULT 0,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Слой по умолчанию: в него попадают знаки без выбранного слоя и знаки удаляемых слоёв.
INSERT INTO tactical_layers (name, "order", created_by)
VALUES ('Общий', -1, 'system')
ON CONFLICT (name) DO NOTHING;

-- Слои, которые уже встречаются у знаков, становятся самостоятельными слоями.
INSERT INTO tactical_layers (name, "order", created_by)
SELECT DISTINCT m.layer, 0, 'system' FROM tactical_marks m
WHERE btrim(m.layer) <> ''
ON CONFLICT (name) DO NOTHING;

