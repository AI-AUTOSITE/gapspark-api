// ダッシュボード用: 日次スナップショット記録 + 集計データ取得
// - recordDailySnapshot: 現在のカウントを「今日の行」にUPSERT（推移グラフ用）
// - getDashboardData: ダッシュボードHTMLが取得する集計JSONを組み立てる
//
// monitor.ts と同じ「6時間Cronに相乗り（Cronは増やさない）」の方針。
//
// 【2026-09-12 変更】
// getCounts() が reviews を4周フルスキャンしていた（1回あたり約82万行）。
// ダッシュボードHTMLは5分ごとに自動更新するため、タブを開きっぱなしにすると
// 1日2億行超を読む恐れがあった。集計は stats.ts に移し、ここは1行読むだけにした。

import { readCachedStats, type Counts } from './stats'

/**
 * 今日のスナップショットを記録（日付でUPSERT。6時間ごとに呼んでも1日1行）
 */
// counts: Cron が refreshStatsCache() で計算した値を渡す（省略時はキャッシュを読む）
export async function recordDailySnapshot(
  db: D1Database,
  counts?: Counts
): Promise<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
  const c = counts ?? (await readCachedStats(db)).counts

  // キャッシュがまだ無いときはゼロで上書きしない（推移グラフが谷になるのを防ぐ）
  if (c.total === 0) {
    return { date: today, skipped: 'stats cache is empty' }
  }

  await db.prepare(`
    INSERT INTO daily_snapshots
      (snapshot_date, captured_at, total_reviews, analyzed_count,
       negative_count, positive_count, pain_point_count, tracked_apps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date) DO UPDATE SET
      captured_at      = excluded.captured_at,
      total_reviews    = excluded.total_reviews,
      analyzed_count   = excluded.analyzed_count,
      negative_count   = excluded.negative_count,
      positive_count   = excluded.positive_count,
      pain_point_count = excluded.pain_point_count,
      tracked_apps     = excluded.tracked_apps
  `).bind(
    today,
    new Date().toISOString(),
    c.total, c.analyzed, c.negative, c.positive, c.pain_points, c.tracked_apps
  ).run()

  return { date: today, total: c.total, analyzed: c.analyzed, pain_points: c.pain_points }
}

/**
 * ダッシュボード用の集計データを1回でまとめて返す
 * - summary: 現在のサマリー（総数・分析%・ネガポジ・PP数・アプリ数）
 * - trend: 直近90日の推移（推移グラフ用）
 * - categories: カテゴリ別ペインポイント数（分布グラフ用）
 * - recent_pain_points: 最近追加されたペインポイント（一覧用）
 */
export async function getDashboardData(db: D1Database): Promise<Record<string, unknown>> {
  // キャッシュを1行読むだけ。何回呼ばれてもコストは一定（以前は毎回82万行スキャン）
  const { counts: c, updated_at: statsUpdatedAt } = await readCachedStats(db)

  const trend = await db.prepare(`
    SELECT snapshot_date, total_reviews, analyzed_count,
           pain_point_count, negative_count, positive_count
    FROM daily_snapshots
    WHERE snapshot_date >= date('now', '-90 day')
    ORDER BY snapshot_date ASC
  `).all()

  const categories = await db.prepare(`
    SELECT category, COUNT(*) AS count
    FROM pain_points
    GROUP BY category
    ORDER BY count DESC
  `).all()

  const recent = await db.prepare(`
    SELECT id, title, category, severity_score, created_at
    FROM pain_points
    ORDER BY created_at DESC, id DESC
    LIMIT 12
  `).all()

  return {
    updated: Date.now(),
    // サマリー数値がいつ時点のものか（Cronが最後に集計した時刻・UTC）
    stats_updated_at: statsUpdatedAt,
    summary: {
      total_reviews: c.total,
      analyzed: c.analyzed,
      analyzed_pct: c.total > 0 ? Math.round((c.analyzed / c.total) * 100) : 0,
      negative: c.negative,
      positive: c.positive,
      pain_points: c.pain_points,
      tracked_apps: c.tracked_apps,
      deep_dives: c.deep_dives,
    },
    trend: trend.results ?? [],
    categories: categories.results ?? [],
    recent_pain_points: recent.results ?? [],
  }
}
