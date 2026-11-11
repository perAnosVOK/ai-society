-- Индексы для административного списка кандидатов.
CREATE INDEX IF NOT EXISTS idx_discovered_last_checked
ON discovered_agents(last_checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_started
ON discovery_runs(started_at DESC);
