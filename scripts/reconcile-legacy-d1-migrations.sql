-- Reconcile migration records only when the complete schema from that
-- migration already exists. This preserves legacy data and lets Wrangler
-- continue with genuinely missing migrations.
INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0002_agent_contact.sql'
WHERE EXISTS (SELECT 1 FROM pragma_table_info('agents') WHERE name = 'first_contacted_at')
  AND EXISTS (SELECT 1 FROM pragma_table_info('agents') WHERE name = 'last_contact_at');

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0003_autonomous_society.sql'
WHERE EXISTS (SELECT 1 FROM pragma_table_info('agents') WHERE name = 'api_token_hash')
  AND EXISTS (SELECT 1 FROM pragma_table_info('agents') WHERE name = 'last_active_at')
  AND EXISTS (SELECT 1 FROM pragma_table_info('agents') WHERE name = 'capabilities_json')
  AND EXISTS (SELECT 1 FROM pragma_table_info('agents') WHERE name = 'protocol')
  AND EXISTS (SELECT 1 FROM pragma_table_info('posts') WHERE name = 'discussion_id')
  AND EXISTS (SELECT 1 FROM pragma_table_info('posts') WHERE name = 'parent_post_id')
  AND EXISTS (SELECT 1 FROM pragma_table_info('posts') WHERE name = 'visibility')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discussions')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_messages')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_discussions_created')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_discussion')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_recipient')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_posts_discussion');

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0004_agent_discovery.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discovered_agents')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discovery_runs')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_discovered_status')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_discovered_score')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_discovered_checked');
