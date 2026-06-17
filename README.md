# GapSpark API — 感情分析を高速化（バックログ消化）

## 何が問題だったか（遅さの正体）
感情分析Cronが1回で **500件を一気に** 処理しようとしていた。しかし Workers AI の
レート制限（約48件で頭打ち→60秒待ちが必要）に当たり、

- 最初の約48件だけ成功
- 残り約452件はエラーで捨てられ、次のCronで再試行→また48件で頭打ち…

の繰り返し。実効スループットは **約48件 × 1日4回 ≒ 192件/日**。
（実データ: 2ヶ月で11,923件 ≒ 192×62日 とほぼ一致）

## 何を直したか
「一度に大量投下してレート制限に当たる」のをやめ、
**「制限に当たらない少量（40件）を高頻度（15分ごと）に」** 処理する方式に変更。

- 40件はレート制限（約48件）の内側 → ほぼ全件成功
- 40件 × 96回/日 ≒ **3,840件/日**（今の約20倍）
- 各実行は約10秒で完了 → 無料枠でも安全

感情分析の中身（analyze-sentiment.ts）は無変更。**呼び方だけ**変えた。

### 変更点
1. `wrangler.jsonc`: Cronを2本に
   - `"0 */6 * * *"`（従来）= フルパイプライン（取得→分析→ペインポイント）
   - `"*/15 * * * *"`（新規）= 感情分析ファストレーン（40件だけ）
2. `src/index.ts`: scheduled ハンドラを「どのCronが起動したか」で分岐
   - 15分Cron → 感情分析40件のみ
   - 6時間Cron → 従来のフルパイプライン（感情分析は500→40に縮小）

※ 無料枠のCronトリガーは3本まで。今回2本目を使用（まだ1本余裕）。

## やること（2ステップ）

### 1. 2ファイルを差し替え
- `~/Projects/gapspark-api/wrangler.jsonc`
- `~/Projects/gapspark-api/src/index.ts`

### 2. デプロイ
```bash
cd ~/Projects/gapspark-api
npx wrangler deploy --minify
```
デプロイ後、出力の `schedule:` に **2本** 表示されればOK
（`0 */6 * * *` と `*/15 * * * *`）。

## 効果の確認（翌日）
ブラウザで /api/health を開いて `reviews_analyzed` の数を見る:
```
https://gapspark-api.pricedrop-app.workers.dev/api/health
```
今日: 11,923 → 翌日: 数千件単位で増えていれば成功（理想は +2,000〜3,000/日）。
数日で「分析済み」が大きく伸び、それに連れてペインポイントも増えていく。

## 正直な注意（神経予算 = ニューロン）
Workers AI 無料枠は **1日10,000ニューロン**（毎日00:00 UTCにリセット、全モデル共通）。
感情分析40件×96回/日 ≒ 約1,800ニューロン/日なので感情分析自体は軽い。
ただし **ペインポイント生成（Llama）と予算を共有** している。先日アプリ網羅性を
直したことで生成対象アプリが増え、ニューロン消費も増える。

→ もし翌日に `reviews_analyzed` が **あまり増えていなかったら**、1日の
   ニューロン予算を使い切っているサイン。その場合の次の一手:
   - ペインポイント生成の頻度を下げる（6時間→24時間。生成は毎時間やる必要はない）
   - もしくは Workers 有料プラン（$5/月）でニューロン上限を引き上げ

まずはこのまま1日様子を見るのが安全。数字を見てから次を判断。

## リスク / 戻し方
- 各実行が短く（約10秒）レート制限内なので安全。
- 元に戻すには wrangler.jsonc のcronを1本に戻し、index.tsを前の版に戻して再デプロイ。
- iOSアプリ・App Store審査に影響なし（バックエンド内部のみ）。

## Git コミット用メッセージ（任意）
Summary:
    perf(cron): add 15-min sentiment fast lane to clear analysis backlog

Description:
    Sentiment analysis fired 500 calls per 6h cron but Workers AI rate
    limits (~48/window) meant only ~48 succeeded and ~452 errored and
    were retried next run — effective throughput ~192/day. Added a
    dedicated */15 cron that analyzes a rate-limit-safe batch (40) each
    run (~3,840/day), gated in scheduled() via controller.cron. The 6h
    full pipeline now uses a 40 batch too. analyze-sentiment.ts unchanged.
