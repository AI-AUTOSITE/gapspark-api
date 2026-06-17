# GapSpark API — パフォーマンス改善 #1: インデックス追加

## 何が問題だったか
スキーマに二次インデックスが1つも無く、レビュー85,603件に対して以下が
**フルスキャン**になっていた（EXPLAIN QUERY PLAN で確認済み）:

- 感情分析Cron（6時間ごと）: 未分析レビュー抽出 → 85k行を全スキャン
- ペインポイント生成Cron（6時間ごと）: アプリ別ネガティブ集計 → 85k行を全スキャン
- Deep Diveキャッシュ参照（リクエスト毎）: deep_dives 全スキャン
- 保存アイデア / リクエスト一覧（ログインユーザー毎）: 全スキャン＋ソート

## 何をしたか
追加のみの安全なマイグレーション（既存データ・構造は無変更）。

| クエリ | 適用前 | 適用後 |
|---|---|---|
| 感情分析Cron 未分析抽出 | reviews 全スキャン(85k) | 部分インデックス（未分析行のみ・分析が進むほど縮小） |
| PP生成 アプリ別ネガ集計 | reviews 全スキャン(85k) | カバリングインデックス（本体に触れない） |
| PP生成 アプリ別ネガ取得 | スキャン＋ソート | インデックス検索・ソート消滅 |
| Deep Diveキャッシュ参照 | deep_dives 全スキャン | インデックス検索・ソート消滅 |
| 保存アイデア取得 | saved_ideas 全スキャン | インデックス検索 |
| リクエスト一覧 | app_requests 全スキャン | インデックス検索 |

## 適用手順（本番D1）
```bash
cd ~/Projects/gapspark-api
# migrations/ フォルダにこのSQLを置いてから:
npx wrangler d1 execute gapspark-db --remote --file=./migrations/0001_add_indexes.sql
```
※ `--remote` が本番。付け忘れるとローカルDBに当たるので注意。

## 適用後の確認（任意）
インデックスが使われているか本番で確認:
```bash
npx wrangler d1 execute gapspark-db --remote \
  --command="EXPLAIN QUERY PLAN SELECT id,title,body FROM reviews WHERE sentiment_score IS NULL ORDER BY id LIMIT 500;"
```
作成済みインデックス一覧:
```bash
npx wrangler d1 execute gapspark-db --remote \
  --command="SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%';"
```

## リスク
- **なし**（追加のみ・冪等 `IF NOT EXISTS`）。
- iOSアプリ・App Store審査には一切影響しない（バックエンド内部のみ）。
- 書き込みコストはレビュー挿入時に微増（1件あたりインデックス更新数件、6時間で約1,000件 → 無視できる）。
- 読み取りの大幅高速化が圧倒的に上回る。

## 期待効果
- Cronパイプラインの所要時間・D1読み取り行数を大幅削減（85k全スキャン → インデックス参照）。
- レビューが増えるほど効果が拡大（現状はまだ伸び続けている）。
- ログインユーザーの「保存アイデア」「リクエスト一覧」表示がデータ増加に対してスケールする。

## ファイル
- `migrations/0001_add_indexes.sql` … 本番D1に実行するマイグレーション
- `schema.sql` … インデックス込みの完全スキーマ（新規DB構築用・既存DBには不要）
