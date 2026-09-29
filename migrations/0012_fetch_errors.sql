-- ============================================================
-- GapSpark API — Fetch Error Tracking (Migration 0012)
-- ============================================================
-- 目的: レビュー取得の「エラー」と「0件だった」を区別して記録する。
--
-- 【背景】
-- fetchAppReviews() は HTTP エラー（403/429/500）でも例外でも [] を返していた。
-- 呼び出し側は [] を「取得済み・空だった」として last_fetched_at を更新するので、
--   - Apple のレート制限で 403 が返っても、成功と同じ扱いでローテーションの最後尾へ
--   - App Store から消えたアプリがあっても、永久に気づけない
--   - errors カウンタは DB 例外しか数えず、取得失敗は 0 のまま
-- ペインポイント生成で直したのと同じ形（「乾いている」と「壊れている」の混同）。
-- Mastodon の指摘（GapSpark-dev #4 スレッド）を受けて、走査で発見。
--
-- 【対策】
-- 取得失敗を tracked_apps に記録し、週報で名前つきで見えるようにする。
-- ローテーション自体は変えない（時間ベースなので、壊れたアプリが枠を
-- 独占することはない）。一時的な失敗は次の周回で自然に回復する。
--
-- 適用:
--   npx wrangler d1 execute gapspark-db --remote --file=./migrations/0012_fetch_errors.sql
-- ============================================================

-- 連続して取得に失敗した回数。成功（0件を含む）で 0 に戻る
ALTER TABLE tracked_apps
    ADD COLUMN fetch_error_streak INTEGER NOT NULL DEFAULT 0;

-- 直近の失敗内容（例: "HTTP 403", "TypeError: fetch failed"）。成功で NULL に戻る
ALTER TABLE tracked_apps
    ADD COLUMN last_fetch_error TEXT;
