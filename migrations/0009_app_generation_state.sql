-- ============================================================
-- GapSpark API — App Generation State (Migration 0009)
-- ============================================================
-- 目的: ペインポイント生成の「空振り」を記録し、成果の出ないアプリを
--       次回以降スキップする（指数バックオフ）。
--
-- 【背景】
-- 候補選定は ORDER BY pain_point_count ASC。
-- 掘っても何も生まれないアプリは pain_point_count が増えないため、
-- 3時間cronのたびに同じ5アプリが最優先で選ばれ続けていた。
--   実測: 11回起動 / 47アプリ処理 / 新規ペインポイント 0〜2件
--   Llama 呼び出し約280回がほぼ全て無駄になっていた。
--
-- 【対策】
-- アプリごとに「最後に試した時刻」と「連続空振り回数」を持つ。
-- 待ち時間 = 6時間 × 2^(連続空振り回数)、最大16日で頭打ち。
--   0回 →  6時間 / 1回 → 12時間 / 2回 → 24時間 / 3回 →  2日
--   4回 →  4日   / 5回 →  8日   / 6回以上 → 16日
-- 成果が出たら連続空振り回数は0にリセットされ、すぐ再挑戦の対象に戻る。
--
-- 追加のみ。既存データ・スキーマは一切変更しない。IF NOT EXISTS で冪等。
-- 全アプリが未記録の状態から始まるので、初回は全アプリが候補になる。
--
-- 適用:
--   npx wrangler d1 execute gapspark-db --remote --file=./migrations/0009_app_generation_state.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS app_generation_state (
    -- tracked_apps.id と 1対1
    app_id            INTEGER PRIMARY KEY,

    -- 最後にペインポイント生成を試みた時刻（成否を問わず記録）
    last_attempted_at TEXT,

    -- 最後に実際にペインポイントが生まれた時刻（NULL = 一度も生まれていない）
    last_created_at   TEXT,

    -- 連続で0件だった回数。成果が出たら0にリセット
    empty_streak      INTEGER NOT NULL DEFAULT 0,

    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
