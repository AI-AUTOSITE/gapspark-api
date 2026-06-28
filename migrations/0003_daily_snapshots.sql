-- ダッシュボードの推移グラフ用: 1日1スナップショット
-- snapshot_date を主キーにして「日付でUPSERT」するので、6時間ごとに呼んでも
-- 1日1行（その日の最新値で上書き）になる。無料枠（1日10万行書き込み）に対して誤差レベル。
CREATE TABLE IF NOT EXISTS daily_snapshots (
  snapshot_date    TEXT PRIMARY KEY,          -- 'YYYY-MM-DD' (UTC)
  captured_at      TEXT NOT NULL,             -- ISO timestamp（最終更新時刻）
  total_reviews    INTEGER NOT NULL DEFAULT 0,
  analyzed_count   INTEGER NOT NULL DEFAULT 0,
  negative_count   INTEGER NOT NULL DEFAULT 0,
  positive_count   INTEGER NOT NULL DEFAULT 0,
  pain_point_count INTEGER NOT NULL DEFAULT 0,
  tracked_apps     INTEGER NOT NULL DEFAULT 0
);
