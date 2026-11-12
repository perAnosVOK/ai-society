-- Collective multi-model discussions and Telegram control plane.
-- Credentials are deliberately NOT stored in D1; use Cloudflare Worker Secrets.

CREATE TABLE IF NOT EXISTS ai_provider_configs (
  provider_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  integration_type TEXT NOT NULL,
  model_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO ai_provider_configs
  (provider_key, display_name, integration_type, model_id, enabled)
VALUES
  ('openai', 'ChatGPT', 'openai_responses', NULL, 0),
  ('gemini', 'Google Gemini', 'gemini_generate_content', NULL, 0),
  ('groq', 'Groq', 'openai_compatible', NULL, 0),
  ('anthropic', 'Claude', 'anthropic_messages', NULL, 0),
  ('microsoft_copilot', 'Microsoft Copilot', 'copilot_studio_direct_line', NULL, 0);

CREATE TABLE IF NOT EXISTS telegram_authorized_chats (
  chat_id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  username TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY,
  telegram_chat_id TEXT,
  telegram_user_id TEXT,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'collecting_initial', 'debating', 'finalizing', 'completed', 'needs_human_review', 'failed', 'cancelled')),
  consensus_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (consensus_status IN ('pending', 'reached', 'partial', 'not_reached')),
  current_round INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 5,
  final_answer TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_conversation_participants (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  model_id TEXT,
  participation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (participation_status IN ('pending', 'responded', 'unavailable', 'withdrawn')),
  latest_stance TEXT
    CHECK (latest_stance IS NULL OR latest_stance IN ('agree', 'disagree', 'qualified', 'uncertain')),
  latest_position_summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_debate_rounds (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  round_type TEXT NOT NULL
    CHECK (round_type IN ('independent', 'critique', 'revision', 'consensus_check', 'final')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  summary TEXT,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (conversation_id, round_number, round_type),
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_discussion_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  round_id TEXT,
  participant_id TEXT,
  provider_key TEXT,
  message_type TEXT NOT NULL
    CHECK (message_type IN ('initial_answer', 'critique', 'revision', 'consensus_vote', 'moderator_note', 'final_answer', 'error')),
  target_message_id TEXT,
  stance TEXT
    CHECK (stance IS NULL OR stance IN ('agree', 'disagree', 'qualified', 'uncertain')),
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES ai_debate_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (participant_id) REFERENCES ai_conversation_participants(id) ON DELETE SET NULL,
  FOREIGN KEY (target_message_id) REFERENCES ai_discussion_messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS telegram_update_receipts (
  update_id TEXT PRIMARY KEY,
  chat_id TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS telegram_outbox (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  chat_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  telegram_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_status
  ON ai_conversations(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_participants_conversation
  ON ai_conversation_participants(conversation_id, provider_key);
CREATE INDEX IF NOT EXISTS idx_ai_rounds_conversation
  ON ai_debate_rounds(conversation_id, round_number);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation
  ON ai_discussion_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_outbox_pending
  ON telegram_outbox(delivery_status, created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_chats_user
  ON telegram_authorized_chats(telegram_user_id, enabled);
