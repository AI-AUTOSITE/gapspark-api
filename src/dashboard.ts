// ダッシュボード用: 日次スナップショット記録 + 集計データ取得
// - recordDailySnapshot: 現在のカウントを「今日の行」にUPSERT（推移グラフ用）
// - getDashboardData: ダッシュボードHTMLが取得する集計JSONを組み立てる
//
// monitor.ts と同じ「6時間Cronに相乗り（Cronは増やさない）」の方針。

type Counts = {
  total: number
  analyzed: number
  negative: number
  positive: number
  pain_points: number
  apps: number
}

// reviews / pain_points / tracked_apps の現在のカウントを1往復で取得
// （health・monitor と同じ定義: analyzed = sentiment_score IS NOT NULL）
async function getCounts(db: D1Database): Promise<Counts> {
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM reviews) AS total,
      (SELECT COUNT(*) FROM reviews WHERE sentiment_score IS NOT NULL) AS analyzed,
      (SELECT COUNT(*) FROM reviews WHERE sentiment_label = 'NEGATIVE') AS negative,
      (SELECT COUNT(*) FROM reviews WHERE sentiment_label = 'POSITIVE') AS positive,
      (SELECT COUNT(*) FROM pain_points) AS pain_points,
      (SELECT COUNT(*) FROM tracked_apps) AS apps
  `).first<Record<string, number>>()
  return {
    total: row?.total ?? 0,
    analyzed: row?.analyzed ?? 0,
    negative: row?.negative ?? 0,
    positive: row?.positive ?? 0,
    pain_points: row?.pain_points ?? 0,
    apps: row?.apps ?? 0,
  }
}

/**
 * 今日のスナップショットを記録（日付でUPSERT。6時間ごとに呼んでも1日1行）
 */
export async function recordDailySnapshot(
  db: D1Database
): Promise<{ date: string; total: number; analyzed: number; pain_points: number }> {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
  const c = await getCounts(db)

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
    c.total, c.analyzed, c.negative, c.positive, c.pain_points, c.apps
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
  const c = await getCounts(db)

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
    summary: {
      total_reviews: c.total,
      analyzed: c.analyzed,
      analyzed_pct: c.total > 0 ? Math.round((c.analyzed / c.total) * 100) : 0,
      negative: c.negative,
      positive: c.positive,
      pain_points: c.pain_points,
      tracked_apps: c.apps,
    },
    trend: trend.results ?? [],
    categories: categories.results ?? [],
    recent_pain_points: recent.results ?? [],
  }
}
