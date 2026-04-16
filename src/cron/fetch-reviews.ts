// iTunes RSS APIからレビューを取得してD1に保存

interface TrackedApp {
  id: number
  apple_id: string
  app_name: string
}

interface RawReview {
  reviewId: string
  author: string
  rating: number
  title: string
  body: string
  appVersion: string
  reviewDate: string
}

// iTunes RSS JSONからレビューをパース
function parseReviews(json: any): RawReview[] {
  const reviews: RawReview[] = []

  if (!json?.feed?.entry) return reviews

  const entries = json.feed.entry
  // 最初のエントリはアプリメタデータ → スキップ
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i]
    try {
      reviews.push({
        reviewId: entry.id?.label || `unknown-${i}`,
        author: entry.author?.name?.label || 'Anonymous',
        rating: parseInt(entry['im:rating']?.label || '0', 10),
        title: entry.title?.label || '',
        body: entry.content?.label || '',
        appVersion: entry['im:version']?.label || '',
        reviewDate: entry.updated?.label || '',
      })
    } catch (e) {
      console.error(`  Parse error at entry ${i}:`, e)
    }
  }

  return reviews
}

// 1つのアプリのレビューを取得（1ページ = 最大50件）
async function fetchAppReviews(appleId: string, page: number = 1): Promise<RawReview[]> {
  const url = `https://itunes.apple.com/us/rss/customerreviews/page=${page}/id=${appleId}/sortBy=mostRecent/json`

  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`  HTTP ${res.status} for app ${appleId}`)
      return []
    }
    const json = await res.json()
    return parseReviews(json)
  } catch (e) {
    console.error(`  Fetch error for app ${appleId}:`, e)
    return []
  }
}

// 全トラッキングアプリのレビューを取得してD1に保存
export async function fetchAndStoreReviews(db: D1Database): Promise<{
  appsProcessed: number
  newReviews: number
  errors: number
}> {
  let appsProcessed = 0
  let newReviews = 0
  let errors = 0

  // トラッキング対象アプリを取得
  const apps = await db.prepare(
    'SELECT id, apple_id, app_name FROM tracked_apps ORDER BY last_fetched_at ASC NULLS FIRST LIMIT 20'
  ).all<TrackedApp>()

  if (!apps.results || apps.results.length === 0) {
    console.log('No tracked apps found')
    return { appsProcessed: 0, newReviews: 0, errors: 0 }
  }

  console.log(`Processing ${apps.results.length} apps...`)

  for (const app of apps.results) {
    try {
      console.log(`  Fetching: ${app.app_name} (${app.apple_id})`)

      // レビュー取得（1ページ目のみ、最大50件）
      const reviews = await fetchAppReviews(app.apple_id)
      console.log(`    Found ${reviews.length} reviews`)

      if (reviews.length === 0) {
        // last_fetched_at を更新（空でもフェッチ済みとする）
        await db.prepare(
          "UPDATE tracked_apps SET last_fetched_at = datetime('now') WHERE id = ?"
        ).bind(app.id).run()
        appsProcessed++
        continue
      }

      // レビューをD1にバッチ挿入
      const insertStmt = db.prepare(
        `INSERT OR IGNORE INTO reviews 
         (tracked_app_id, review_id, author, rating, title, body, app_version, region, review_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'us', ?)`
      )

      const batch = reviews.map(r =>
        insertStmt.bind(
          app.id,
          r.reviewId,
          r.author,
          r.rating,
          r.title,
          r.body,
          r.appVersion,
          r.reviewDate
        )
      )

      // D1 batch API で一括挿入
      const batchResults = await db.batch(batch)
      const inserted = batchResults.reduce((sum, r) => sum + (r.meta?.changes || 0), 0)
      newReviews += inserted
      console.log(`    Inserted ${inserted} new reviews (${reviews.length - inserted} duplicates skipped)`)

      // last_fetched_at を更新
      await db.prepare(
        "UPDATE tracked_apps SET last_fetched_at = datetime('now') WHERE id = ?"
      ).bind(app.id).run()

      appsProcessed++

      // Rate limit: 1.5秒待機
      await new Promise(r => setTimeout(r, 1500))

    } catch (e) {
      console.error(`  Error processing ${app.app_name}:`, e)
      errors++
    }
  }

  return { appsProcessed, newReviews, errors }
}
