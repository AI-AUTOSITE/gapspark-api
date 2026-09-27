-- ============================================================
-- GapSpark API — Error Streak (Migration 0011)
-- ============================================================
-- 目的: 生成時の「エラー」と「読んだけど0件」を区別する。
--
-- 【背景】
-- 生成が例外で落ちたとき、recordGenerationAttempt(created=0) を呼んでいた。
-- これは「この窓は空だった」と同じ扱いで、窓が次へ進む。
-- Workers AI が一時的に落ちただけでも、その50件は飛ばされ、
-- 回転が1周するまで（大きいアプリでは1ヶ月）戻ってこなかった。
-- Mastodon で指摘を受けて修正（GapSpark-dev #4 への返信）。
--
-- 【対策】
-- エラー時は窓を進めず、待機（last_attempted_at）だけ記録して同じ窓を再試行。
-- ただし同じ窓で2回連続で落ちたら、その窓は飛ばす（永久ループ防止）。
--
-- 追加のみ。IF NOT EXISTS 相当の冪等性は ALTER TABLE には無いので、
-- 2回目以降の実行は "duplicate column" エラーになるが、実害はない。
--
-- 適用:
--   npx wrangler d1 execute gapspark-db --remote --file=./migrations/0011_error_streak.sql
-- ============================================================

-- 同じ窓で連続してエラーになった回数。成功または窓の移動で 0 に戻る
ALTER TABLE app_generation_state
    ADD COLUMN error_streak INTEGER NOT NULL DEFAULT 0;
