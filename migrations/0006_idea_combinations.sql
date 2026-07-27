-- 0006: アイデア掛け合わせ機能
-- 複数アプリの不満を掛け合わせて新しいアプリのアイデアを生成し、結果をキャッシュする。

-- 生成されたアイデア（おまかせ=cron事前生成 / 手動=ユーザー生成、両方ここにキャッシュ）
CREATE TABLE IF NOT EXISTS idea_combinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    combo_key TEXT NOT NULL UNIQUE,      -- ソート済みpain_point_idを結合した一意キー "12,45,78"（キャッシュ検索用）
    pain_point_ids TEXT NOT NULL,        -- JSON配列 [12,45,78]（表示・参照用）
    mode TEXT NOT NULL DEFAULT 'auto',   -- 'auto'（おまかせ）/ 'manual'（手動）
    idea TEXT NOT NULL,                  -- Claudeの返答JSON（app_name, concept, differentiation, mvp_features, starter_prompt, buildability）
    model_used TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- 手動生成の1日使用回数（3回/日制限用。Deep Diveと同じ構造・別枠）
CREATE TABLE IF NOT EXISTS idea_gen_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    usage_date TEXT NOT NULL,            -- 'YYYY-MM-DD'
    count INTEGER DEFAULT 1,
    UNIQUE(user_id, usage_date)
);

-- おまかせ一覧を「新しい順」で引くための索引
CREATE INDEX IF NOT EXISTS idx_idea_combinations_mode_created
    ON idea_combinations(mode, created_at DESC);
