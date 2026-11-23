-- ============================================================
-- GapSpark API — Generation Error Samples (Migration 0015)
-- ============================================================
-- 目的: ペインポイント生成で失敗した窓の「理由」を残す。
--
-- 【背景】
-- 週報の「失敗した窓」が 10 → 18 → 38 → 40 件/週と増え続けている（2026-11）。
-- 窓は保持されるのでデータは失われないが、1窓の失敗でモデルを最大4回呼ぶので
-- 枠を無駄にしている。何で失敗したかはコンソールに出るだけで、記録がなかった。
--
-- 生成1回の終わりに、その回で失敗した窓のエラー内容をまとめて書く。
-- 最新 200 件だけ残す。週報で「理由ごとの件数」を出す。
--
-- 適用（デプロイより先に！）:
--   npx wrangler d1 execute gapspark-db --remote --file=./migrations/0015_generation_errors.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS generation_errors (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT    NOT NULL DEFAULT (datetime('now')),
  app_id   INTEGER NOT NULL,
  message  TEXT    NOT NULL   -- エラー内容（先頭 300 文字）
);

CREATE INDEX IF NOT EXISTS idx_generation_errors_at ON generation_errors(at);
