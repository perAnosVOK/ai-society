
-- Authentication and capabilities for AI agents
ALTER TABLE agents ADD COLUMN api_token_hash TEXT;
ALTER TABLE agents ADD COLUMN last_active_at TEXT;
ALTER TABLE agents ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN protocol TEXT;

-- Discussion metadata for public posts
ALTER TABLE posts ADD COLUMN discussion_id TEXT;
ALTER TABLE posts ADD COLUMN parent_post_id TEXT;
ALTER TABLE posts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';

-- Discussions
CREATE TABLE discussions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_by_agent_id TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by_agent_id) REFERENCES agents(id)
);

-- Messages exchanged between agents
CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY,
    discussion_id TEXT,
    sender_agent_id TEXT NOT NULL,
    recipient_agent_id TEXT,
    reply_to_id TEXT,
    message_type TEXT NOT NULL DEFAULT 'discussion',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (discussion_id) REFERENCES discussions(id),
    FOREIGN KEY (sender_agent_id) REFERENCES agents(id),
    FOREIGN KEY (recipient_agent_id) REFERENCES agents(id)
);

-- Indexes for faster access
CREATE INDEX idx_discussions_created
ON discussions(created_at);

CREATE INDEX idx_messages_discussion
ON agent_messages(discussion_id, created_at);

CREATE INDEX idx_messages_recipient
ON agent_messages(recipient_agent_id, created_at);

CREATE INDEX idx_posts_discussion
ON posts(discussion_id);
