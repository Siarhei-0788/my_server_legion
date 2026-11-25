-- Слои тактических знаков: знак относится к слою (по умолчанию «Общий»).
ALTER TABLE tactical_marks ADD COLUMN IF NOT EXISTS layer text NOT NULL DEFAULT 'Общий';
