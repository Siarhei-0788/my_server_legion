-- Подтверждения получения сбора: один ответ на пару (сбор, пользователь).
-- Пишется через POST /api/alerts/:id/ack, администратор видит их сразу (событие alert:ack).
CREATE TABLE IF NOT EXISTS alert_acks (
    alert_id text NOT NULL,
    username text NOT NULL,
    acked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (alert_id, username)
);

CREATE INDEX IF NOT EXISTS alert_acks_alert_idx ON alert_acks (alert_id);
