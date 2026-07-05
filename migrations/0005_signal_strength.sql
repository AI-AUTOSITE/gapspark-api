-- 0005_signal_strength.sql
-- 案B: 信号強度バッジ「15件中◯件が言及」用のカラムを pain_points に追加する。
--
--   mention_count: Deep Diveの分析窓(最大15件)のうち、このペインに言及しているレビュー数 (0〜15)
--                  deep-dive.ts の Stage 1 と同じ照合（keywords + タイトル語, OR, 最大6語）で数える。
--   sample_size:   母数。通常15。対象アプリのネガティブレビューが15未満ならその実数。
--
-- どちらも 0 のとき = 未計算（検索語なし等）→ アプリ側はバッジを非表示にできる。
-- 既存の frequency は用途が別（severity計算）なので変更しない（上位互換）。

ALTER TABLE pain_points ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pain_points ADD COLUMN sample_size INTEGER NOT NULL DEFAULT 0;
