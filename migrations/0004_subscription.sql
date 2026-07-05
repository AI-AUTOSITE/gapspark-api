-- ============================================================
-- Migration 0004: サブスクリプション（GapSpark Pro）
-- users テーブルに Pro の有効期限と Apple の originalTransactionId を追加する。
--
-- 適用:
--   npx wrangler d1 execute gapspark-db --remote --file=./migrations/0004_subscription.sql
--
-- 判定ロジック:
--   Pro有効 = subscription_tier='pro' かつ subscription_expires_at > 現在時刻
--   （解約しても期間終了までは Pro を維持。期間が過ぎれば自動的に free 扱い）
-- ============================================================

-- Pro の有効期限（ISO8601 文字列）。NULL = 未加入
ALTER TABLE users ADD COLUMN subscription_expires_at TEXT;

-- Apple の originalTransactionId（照合・重複紐付け防止用）。NULL = 未加入
ALTER TABLE users ADD COLUMN original_transaction_id TEXT;

-- originalTransactionId から素早く引けるように
CREATE INDEX IF NOT EXISTS idx_users_original_txn
    ON users(original_transaction_id);
