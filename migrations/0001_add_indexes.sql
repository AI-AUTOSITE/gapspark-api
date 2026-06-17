-- ============================================================
-- GapSpark API — Performance Indexes (Migration 0001)
-- ============================================================
-- 追加のみ（既存データ・スキーマ構造は一切変更しない）。
-- 本番D1に安全に適用できる。IF NOT EXISTS で冪等。
--
-- 適用:
--   npx wrangler d1 execute gapspark-db --remote --file=./migrations/0001_add_indexes.sql
-- ============================================================

-- 【最優先】reviews テーブル（85,000行超）— Cronパイプラインが毎回触る
--------------------------------------------------------------

-- ① 感情分析Cron: 未分析レビューの抽出を高速化
--    対象クエリ: WHERE sentiment_score IS NULL ORDER BY id LIMIT 500
--    部分インデックスなので「未分析の行だけ」を保持 → 分析が進むほど縮小して常に小さい
CREATE INDEX IF NOT EXISTS idx_reviews_unanalyzed
    ON reviews(id)
    WHERE sentiment_score IS NULL;

-- ② ペインポイント生成Cron + Deep Dive: アプリ別×感情でのフィルタ＆並べ替えを高速化
--    対象: WHERE tracked_app_id=? AND sentiment_label='NEGATIVE' ORDER BY sentiment_score
--    アプリ別ネガ集計(JOIN)もこのインデックスでネストループ化される
CREATE INDEX IF NOT EXISTS idx_reviews_app_sentiment
    ON reviews(tracked_app_id, sentiment_label, sentiment_score);

-- 【高】Deep Dive キャッシュ参照（リクエスト毎に1回）
--------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_deep_dives_pain_point
    ON deep_dives(pain_point_id, created_at);

-- 【高】ユーザー単位テーブル
--------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_saved_ideas_user
    ON saved_ideas(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_app_requests_user
    ON app_requests(user_id);

-- Cronが将来 pending リクエストを拾う処理用（v1.3+ で効く）
CREATE INDEX IF NOT EXISTS idx_app_requests_status
    ON app_requests(status);

-- 【将来対策】pain_points（現在117行 = 今は効果薄。数千件に育つと効く。追加コストはほぼゼロ）
--------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_pain_points_severity
    ON pain_points(severity_score);

CREATE INDEX IF NOT EXISTS idx_pain_points_category
    ON pain_points(category);
