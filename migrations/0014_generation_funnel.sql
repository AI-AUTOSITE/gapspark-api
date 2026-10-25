-- ============================================================
-- GapSpark API — Generation Funnel (Migration 0014)
-- ============================================================
-- 目的: ペインポイント生成の「ふるい」を記録する。
--   モデルが出した候補が、どの段階で何件落ちて、何件残ったか。
--
-- 【背景】
-- 生成枠を 40→64 窓/日に増やしたら、成果は +31%、1窓あたりは 0.26→0.22 に下がった
-- （2026-10-25 週報）。原因の候補は2つ:
--   (a) 深い窓のレビューは既出の不満の言い換えばかり（材料の問題）
--   (b) 重複フィルタが厳しすぎる（ふるいの問題）
-- 重複判定は「全アプリの全ペインポイント」と単語の重なり（小さい方の語数で割る）で
-- 比べるので、データが増えるほど自動的に厳しくなる作りになっている。
-- どちらなのかを、これまでは数える手段がなかった（コンソールに出るだけ）。
--
-- generation_runs     … 生成1回ごとの集計（候補 → 各段階の除外数 → 保存数）
-- rejected_duplicates … 重複で落とした候補の見本（何と一致したか・スコア）。
--                       最新 300 件だけ残す。週報で目視して「厳しすぎるか」を判断する
--
-- 適用（デプロイより先に！）:
--   npx wrangler d1 execute gapspark-db --remote --file=./migrations/0014_generation_funnel.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS generation_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  windows          INTEGER NOT NULL DEFAULT 0,  -- 最後まで読めた窓（アプリ）の数
  candidates       INTEGER NOT NULL DEFAULT 0,  -- モデルが出した候補の数
  raw_rejected     INTEGER NOT NULL DEFAULT 0,  -- 生レビューの写し・口調で除外
  dup_rejected     INTEGER NOT NULL DEFAULT 0,  -- 重複で除外
  quality_rejected INTEGER NOT NULL DEFAULT 0,  -- 長さ・曖昧さで除外
  signal_rejected  INTEGER NOT NULL DEFAULT 0,  -- 裏付けのレビューが2件未満で除外
  created          INTEGER NOT NULL DEFAULT 0,  -- 保存した数
  errors           INTEGER NOT NULL DEFAULT 0,  -- 失敗した窓の数（窓は保持される）
  existing_count   INTEGER NOT NULL DEFAULT 0   -- 重複判定の比較相手（既存ペインポイント数）
);

CREATE INDEX IF NOT EXISTS idx_generation_runs_run_at ON generation_runs(run_at);

CREATE TABLE IF NOT EXISTS rejected_duplicates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  rejected_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  app_id          INTEGER NOT NULL,
  candidate_title TEXT    NOT NULL,  -- 落とされた候補
  matched_title   TEXT    NOT NULL,  -- 一致と判定された既存（または同じ回の先行候補）
  kind            TEXT    NOT NULL,  -- 'title' | 'summary'
  score           REAL    NOT NULL   -- 重なりの割合（title は 0.4 以上、summary は 0.5 以上で除外）
);
