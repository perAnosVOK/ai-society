
-- Найденные агенты и кандидаты на подключение
CREATE TABLE discovered_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    card_url TEXT NOT NULL UNIQUE,
    endpoint TEXT,
    source TEXT,
    protocol TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '{}',

    status TEXT NOT NULL DEFAULT 'discovered'
        CHECK (status IN (
            'discovered',
            'verified',
            'pending_connection',
            'active',
            'rejected',
            'unavailable'
        )),

    compatibility_score INTEGER DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_checked_at TEXT,
    last_error TEXT,
    registered_agent_id TEXT
);

CREATE INDEX idx_discovered_status
ON discovered_agents(status);

CREATE INDEX idx_discovered_score
ON discovered_agents(compatibility_score DESC);

CREATE INDEX idx_discovered_checked
ON discovered_agents(last_checked_at);

-- История автоматического поиска
CREATE TABLE discovery_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    source TEXT,
    found_count INTEGER DEFAULT 0,
    verified_count INTEGER DEFAULT 0,
    registered_count INTEGER DEFAULT 0,
    error TEXT
);
