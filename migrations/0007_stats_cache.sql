-- ============================================================
-- GapSpark API — Stats Cache (Migration 0007)
-- ============================================================
-- 目的: 全体カウント（総レビュー数・分析済み・ネガポジ・ペインポイント数など）を
--       1行のJSONとして保存し、API/監視はここを読むだけにする。
--
-- 【背景】
-- monitor.ts と dashboard.ts が
--   (SELECT COUNT(*) FROM reviews) を4本並べたクエリを直接実行していた。
-- reviews を4周フルスキャンするため 1回あたり約82万行を読み、
-- reviews が10万行を超えたあたりから D1 無料枠（5,000,000 rows_read/日）を
-- 静かに超過するようになった。コストが行数に正比例するのが根本原因。
--
-- 【対策】
--   書き込み（重い集計）: Cron からのみ
--   読み取り（API・監視）: このテーブルから1行読むだけ（常に定数コスト）
--
-- 追加のみ。既存データ・スキーマは一切変更しない。IF NOT EXISTS で冪等。
--
-- 適用:
--   npx wrangler d1 execute gapspark-db --remote --file=./migrations/0007_stats_cache.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS stats_cache (
    -- 常に1行だけ。CHECK で id=1 以外の挿入を防ぐ
    id         INTEGER PRIMARY KEY CHECK (id = 1),

    -- Counts オブジェクトを JSON 文字列で保存
    -- 例: {"total":204340,"analyzed":202242,"negative":...,"pain_points":416,...}
    payload    TEXT NOT NULL,

    -- 最終更新日時（ダッシュボードで「いつ時点の数字か」を表示するのに使う）
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
