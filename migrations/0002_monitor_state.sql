-- 運用監視の状態を記録する小さなテーブル
-- 用途: 週報/アラートの重複送信防止、前回比の計算、ストール検知
CREATE TABLE IF NOT EXISTS monitor_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
