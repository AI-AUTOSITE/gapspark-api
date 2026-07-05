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


// ========================================
// 深掘りバックフィル（過去分レビューの一度きりキャッチアップ）
// ========================================
//
// 通常の fetchAndStoreReviews は各アプリ page 1（最新50件）のみ取得する。
// 新着レビューは page 1 に出るのでそれで十分だが、過去に取りこぼした
// pages 2 以降のレビューは永遠に取得されない。この関数はそれを一度だけ埋める。
//
// ★手動・チャンク実行★（signal backfill と同じ方式）
//   Cloudflare Worker の subrequest 上限に配慮し、1回で少数アプリだけ処理して
//   next_offset を返す。呼び出し側は done=true まで offset を進めて繰り返す（Pythonループ）。
//
//   page 1 は通常cronが担当するので、ここは pages 2..MAX_PAGES を取得する。
//   「新規挿入0（=既にキャッチアップ済み）」または「空/最終ページ」でそのアプリを打ち切る
//   → 2回目以降の実行は即終了で軽い（再取得の無駄が最小）。

const MAX_PAGES = 10          // iTunes RSS の実質上限（1ページ≈50件 → 最大約500件/アプリ）
const DEEP_FETCH_CHUNK = 2    // 1リクエストで深掘りするアプリ数（subrequest上限対策・小さめ）

export async function deepBackfillReviews(
  db: D1Database,
  offset: number = 0
): Promise<{
  total: number
  offset: number
  processed: number
  newReviews: number
  done: boolean
  next_offset: number
}> {
  // 全トラッキングアプリ数（進捗表示用）
  const totalRow = await db.prepare(
    'SELECT COUNT(*) as cnt FROM tracked_apps'
  ).first<{ cnt: number }>()
  const total = totalRow?.cnt || 0

  // このチャンク分のアプリを取得（id昇順で安定ページング）
  const apps = await db.prepare(
    'SELECT id, apple_id, app_name FROM tracked_apps ORDER BY id LIMIT ? OFFSET ?'
  ).bind(DEEP_FETCH_CHUNK, offset).all<TrackedApp>()

  const rows = apps.results || []
  let newReviews = 0

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO reviews 
     (tracked_app_id, review_id, author, rating, title, body, app_version, region, review_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'us', ?)`
  )

  for (const app of rows) {
    try {
      // pages 2..MAX_PAGES を取得（page 1 は通常cron担当）
      for (let page = 2; page <= MAX_PAGES; page++) {
        const reviews = await fetchAppReviews(app.apple_id, page)
        if (reviews.length === 0) break // Apple側にもうレビューが無い

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
        const batchResults = await db.batch(batch)
        const inserted = batchResults.reduce((sum, r) => sum + (r.meta?.changes || 0), 0)
        newReviews += inserted

        console.log(`  ${app.app_name} p${page}: +${inserted} new (${reviews.length - inserted} dup)`)

        // 全部重複 = このアプリは既にキャッチアップ済み → 打ち切り
        if (inserted === 0) break
        // 満杯でない = 最終ページ → 次のアプリへ
        if (reviews.length < 45) break

        // Apple へのレート制限配慮（ページ間）
        await new Promise((r) => setTimeout(r, 400))
      }
    } catch (e) {
      console.error(`  Deep fetch error for ${app.app_name}:`, e)
      // このアプリは飛ばして次へ
    }

    // アプリ間の待機
    await new Promise((r) => setTimeout(r, 1000))
  }

  const processed = rows.length
  const next_offset = offset + processed
  const done = next_offset >= total || processed === 0

  console.log(
    `Deep backfill: offset=${offset} processed=${processed} newReviews=${newReviews} total=${total} done=${done}`
  )
  return { total, offset, processed, newReviews, done, next_offset }
}
