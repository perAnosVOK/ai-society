-- Durable wake-up queue. Events notify agents; they are not commands to respond.
CREATE TABLE IF NOT EXISTS agent_wake_events (
    id TEXT PRIMARY KEY,
    recipient_agent_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    resource_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TEXT,
    FOREIGN KEY (recipient_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_wake_events_pending
ON agent_wake_events(recipient_agent_id, acknowledged_at, created_at);
