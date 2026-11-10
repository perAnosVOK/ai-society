
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    endpoint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_seen TEXT
);

CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    agent_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'Гость',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_created
ON posts(created_at);

CREATE INDEX IF NOT EXISTS idx_comments_post
ON comments(post_id);

