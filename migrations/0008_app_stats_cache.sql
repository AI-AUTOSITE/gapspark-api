-- ============================================================
-- GapSpark API — Per-App Stats Cache (Migration 0008)
-- ============================================================
-- 目的: 「どのアプリを次に掘るか」の判定材料（アプリ別ネガレビュー数・
--       アプリ別ペインポイント数）を事前計算して保存する。
--
-- 【背景】
-- generate-pain-points.ts の候補選定クエリが 1回あたり約53万行を読んでいた。
--   - tracked_apps と reviews を JOIN してアプリ別ネガ数を集計
--   - さらに相関サブクエリで pain_points × json_each をアプリ数ぶん繰り返す
-- これが3時間cron（1日8回）で回るため、単独で約4.25M行/日。
-- 無料枠 5M/日 のほぼ全部をこの1クエリが食べていた。
--
-- 【対策】0007 と同じ方針
--   書き込み（重い集計）: 6時間cron からのみ → refreshAppStatsCache()
--   読み取り（3時間cron）: このテーブルを101行読むだけ
--
-- 集計の実行回数が 8回/日 → 4回/日 に減り、
-- 候補選定そのものは 53万行 → 約200行 になる。
--
-- 追加のみ。既存データ・スキーマは一切変更しない。IF NOT EXISTS で冪等。
--
-- 適用:
--   npx wrangler d1 execute gapspark-db --remote --file=./migrations/0008_app_stats_cache.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS app_stats_cache (
    -- tracked_apps.id と 1対1
    app_id           INTEGER PRIMARY KEY,

    -- そのアプリのネガティブレビュー総数（HAVING >= 5 の判定に使う）
    negative_count   INTEGER NOT NULL DEFAULT 0,

    -- そのアプリに紐づく既存ペインポイント数（少ない順に優先して掘る）
    pain_point_count INTEGER NOT NULL DEFAULT 0,

    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 候補選定の ORDER BY pain_point_count ASC, negative_count DESC を支える
CREATE INDEX IF NOT EXISTS idx_app_stats_priority
    ON app_stats_cache(pain_point_count, negative_count);
