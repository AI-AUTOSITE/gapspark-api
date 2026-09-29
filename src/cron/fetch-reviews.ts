// iTunes RSS APIからレビューを取得してD1に保存
//
// 【2026-09-29 変更】取得エラーと「0件」を区別する
// 以前は HTTP エラーも例外も [] を返し、呼び出し側は「空だった」として
// last_fetched_at を更新していた。403（レート制限）も成功扱いになり、
// App Store から消えたアプリがあっても永久に気づけなかった。
// 今は失敗を tracked_apps.fetch_error_streak に記録し、週報で名前が出る。
// レート制限（403/429）を受けたら、その回は残りのアプリを叩かずに止める。

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
// 取得結果。「空だった」（ok:true, reviews:[]）と「失敗した」（ok:false）を区別する
type FetchResult =
  | { ok: true; reviews: RawReview[] }
  | { ok: false; status: number | null; message: string }

// レート制限の判定。
//   429 は「多すぎる」の明示なので1回で確定。
//   403 は「レート制限」と「そのアプリが個別に禁止（ストアから消えた等）」の
//   どちらでも返るため、1回では判断できない。連続で来たときだけ制限とみなす。
//   単発の403で全体を止めると、死んだアプリが先頭に来るたびに取得が丸ごと無駄になる。
const HARD_RATE_LIMIT_STATUSES = new Set([429])
const SOFT_RATE_LIMIT_STATUSES = new Set([403])
const CONSECUTIVE_FAILURES_TO_STOP = 3

async function fetchAppReviews(appleId: string, page: number = 1): Promise<FetchResult> {
  const url = `https://itunes.apple.com/us/rss/customerreviews/page=${page}/id=${appleId}/sortBy=mostRecent/json`

  try {
    // ブラウザのUser-Agentを付ける。これが無いと Apple がサーバー(Worker)からの
    // リクエストに空フィードを返すことがある（Mac/curl では取れるのに Worker では空、の対策）。
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'application/json',
      },
    })
    if (!res.ok) {
      console.error(`  HTTP ${res.status} for app ${appleId}`)
      return { ok: false, status: res.status, message: `HTTP ${res.status}` }
    }
    const json = await res.json()
    return { ok: true, reviews: parseReviews(json) }
  } catch (e) {
    console.error(`  Fetch error for app ${appleId}:`, e)
    return { ok: false, status: null, message: String(e).substring(0, 200) }
  }
}

// 成功（0件を含む）: last_fetched_at を進め、エラー記録をクリア
async function markFetched(db: D1Database, appId: number): Promise<void> {
  await db.prepare(
    "UPDATE tracked_apps SET last_fetched_at = datetime('now'), fetch_error_streak = 0, last_fetch_error = NULL WHERE id = ?"
  ).bind(appId).run()
}

// 失敗: last_fetched_at は進める（ローテーションは時間ベースなので、
// 壊れたアプリが枠を独占することはない。次の周回で自然に再試行される）。
// 連続回数と内容を残し、週報で名前つきで見えるようにする。
async function markFetchFailed(db: D1Database, appId: number, message: string): Promise<void> {
  await db.prepare(
    "UPDATE tracked_apps SET last_fetched_at = datetime('now'), fetch_error_streak = fetch_error_streak + 1, last_fetch_error = ? WHERE id = ?"
  ).bind(message, appId).run()
}
// 全トラッキングアプリのレビューを取得してD1に保存
export async function fetchAndStoreReviews(db: D1Database): Promise<{
  appsProcessed: number
  newReviews: number
  errors: number
  rateLimited: boolean
}> {
  let appsProcessed = 0
  let newReviews = 0
  let errors = 0
  let rateLimited = false
  let consecutiveFailures = 0

  // トラッキング対象アプリを取得
  const apps = await db.prepare(
    'SELECT id, apple_id, app_name FROM tracked_apps ORDER BY last_fetched_at ASC NULLS FIRST LIMIT 20'
  ).all<TrackedApp>()

  if (!apps.results || apps.results.length === 0) {
    console.log('No tracked apps found')
    return { appsProcessed: 0, newReviews: 0, errors: 0, rateLimited: false }
  }

  console.log(`Processing ${apps.results.length} apps...`)

  for (const app of apps.results) {
    try {
      console.log(`  Fetching: ${app.app_name} (${app.apple_id})`)

      // レビュー取得（1ページ目のみ、最大50件）
      const result = await fetchAppReviews(app.apple_id)

      if (!result.ok) {
        // 失敗。「空だった」とは別物として記録する
        await markFetchFailed(db, app.id, result.message)
        errors++
        consecutiveFailures++
        console.log(`    Fetch failed (${result.message}) — recorded`)

        const status = result.status
        const hard = status != null && HARD_RATE_LIMIT_STATUSES.has(status)
        const soft = status != null && SOFT_RATE_LIMIT_STATUSES.has(status)

        // 429 は1回で確定。403 は連続したときだけレート制限とみなす。
        // 止めた場合、残りは last_fetched_at が古いままなので次回の先頭に来る。
        if (hard || (soft && consecutiveFailures >= CONSECUTIVE_FAILURES_TO_STOP)) {
          console.warn(`    Rate limited by Apple (HTTP ${status}, ${consecutiveFailures} in a row) — stopping this run`)
          rateLimited = true
          break
        }
        await new Promise(r => setTimeout(r, 1500))
        continue
      }

      // 成功したので連続失敗はリセット
      consecutiveFailures = 0
      const reviews = result.reviews
      console.log(`    Found ${reviews.length} reviews`)

      if (reviews.length === 0) {
        // 本当に空（App Store 側にレビューが無い）。成功扱い
        await markFetched(db, app.id)
        appsProcessed++
        await new Promise(r => setTimeout(r, 1500))
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

      await markFetched(db, app.id)
      appsProcessed++

      // Rate limit: 1.5秒待機
      await new Promise(r => setTimeout(r, 1500))

    } catch (e) {
      // DB 側の例外。取得自体は成功している可能性があるので streak には数えない
      console.error(`  Error processing ${app.app_name}:`, e)
      errors++
    }
  }

  return { appsProcessed, newReviews, errors, rateLimited }
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
        const result = await fetchAppReviews(app.apple_id, page)
        if (!result.ok) {
          // 深掘りは一度きりの補完なので、失敗したページは飛ばして次のアプリへ
          console.warn(`  ${app.app_name} p${page}: ${result.message} — skipping app`)
          break
        }
        const reviews = result.reviews
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
