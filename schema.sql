-- Apps being tracked for review analysis
CREATE TABLE IF NOT EXISTS tracked_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    apple_id TEXT NOT NULL UNIQUE,
    app_name TEXT NOT NULL,
    category TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    icon_url TEXT,
    average_rating REAL,
    total_ratings INTEGER,
    last_fetched_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Raw reviews (never exposed to users)
CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracked_app_id INTEGER NOT NULL,
    review_id TEXT NOT NULL,
    author TEXT,
    rating INTEGER NOT NULL,
    title TEXT,
    body TEXT,
    app_version TEXT,
    region TEXT NOT NULL DEFAULT 'us',
    review_date TEXT,
    sentiment_score REAL,
    sentiment_label TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (tracked_app_id) REFERENCES tracked_apps(id),
    UNIQUE(tracked_app_id, review_id, region)
);

-- Pre-analyzed pain points (user-facing)
CREATE TABLE IF NOT EXISTS pain_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    severity_score REAL DEFAULT 0.0,
    frequency INTEGER DEFAULT 1,
    sample_app_ids TEXT,
    keywords TEXT,
    related_topics TEXT,
    ai_generated_idea TEXT,
    ai_model_used TEXT DEFAULT 'workers-ai-llama-3.2-1b',
    last_updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
);

-- Deep Dive analysis cache (Claude API responses)
CREATE TABLE IF NOT EXISTS deep_dives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pain_point_id INTEGER NOT NULL,
    analysis TEXT NOT NULL,
    model_used TEXT DEFAULT 'claude-haiku-4-5',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (pain_point_id) REFERENCES pain_points(id)
);

-- Daily usage tracking for Deep Dive limits
CREATE TABLE IF NOT EXISTS deep_dive_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    usage_date TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, usage_date)
);

-- Users (Sign in with Apple)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    apple_user_id TEXT NOT NULL UNIQUE,
    email TEXT,
    display_name TEXT,
    subscription_tier TEXT DEFAULT 'free',
    created_at TEXT DEFAULT (datetime('now')),
    last_login_at TEXT
);

-- Saved ideas per user
CREATE TABLE IF NOT EXISTS saved_ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    pain_point_id INTEGER,
    idea_title TEXT NOT NULL,
    idea_description TEXT,
    idea_prompt TEXT,
    source TEXT DEFAULT 'workers_ai',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (pain_point_id) REFERENCES pain_points(id)
);

-- User-requested apps for tracking
CREATE TABLE IF NOT EXISTS app_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    app_name TEXT NOT NULL,
    app_store_url TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Full-text search (MUST use lowercase fts5)
CREATE VIRTUAL TABLE IF NOT EXISTS reviews_fts USING fts5(
    title, body,
    content=reviews, content_rowid=id,
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS reviews_ai AFTER INSERT ON reviews BEGIN
    INSERT INTO reviews_fts(rowid, title, body)
    VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS reviews_ad AFTER DELETE ON reviews BEGIN
    INSERT INTO reviews_fts(reviews_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;
