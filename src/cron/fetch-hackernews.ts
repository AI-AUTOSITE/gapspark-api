// Hacker News からアプリ言及コメントを取得してD1に保存（Apple RSS とは別の鉱脈）
//
// HN Algolia Search API で各トラッキングアプリのブランド名を検索し、
// マッチしたコメントを reviews テーブルに region='hackernews' で保存する。
// その後は既存の sentiment / pain-point パイプラインがそのまま処理する
//   （analyze-sentiment も generate-pain-points も region で絞っていないため追加コード不要）。
//
// reviews は region で複数ソースを区別する設計（UNIQUE(tracked_app_id, review_id, region)）
// なので、'hackernews' を入れても App Store 分（'us'）と衝突しない。マイグレーション不要。
//
// ★手動・チャンク実行★（deep-fetch と同じ方式）: Cloudflare の subrequest 上限に配慮し
//   1回で少数アプリだけ処理して next_offset を返す。呼び出し側は done まで offset を進める。

interface TrackedApp {
  id: number
  apple_id: string
  app_name: string
}

interface HNComment {
  objectID: string
  author: string
  text: string
  storyTitle: string
  createdAt: string
}

const HN_CHUNK = 5 // 1リクエストで処理するアプリ数（subrequest上限対策）
const HITS_PER_APP = 20 // 1アプリあたり取得するHNコメント上限

// アプリのストア名からブランド名（先頭語）を取り出す
// 例: "Notion: Notes, Tasks, AI" → "Notion" / "Evernote - Notes Organizer" → "Evernote"
function brandName(appName: string): string {
  return appName.split(/[:\-–—|(]/)[0].trim()
}

// HTMLタグ除去 + 主要エンティティのデコード（HNのコメントはHTML）
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ')
    .trim()
}

// HN Algolia でコメントを検索
async function searchHackerNews(brand: string, hits: number): Promise<HNComment[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(
    brand
  )}&tags=comment&hitsPerPage=${hits}`

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'GapSpark/1.0' } })
    if (!res.ok) {
      console.error(`  HN HTTP ${res.status} for "${brand}"`)
      return []
    }
    const json: any = await res.json()
    const results: HNComment[] = []
    for (const hit of json?.hits ?? []) {
      const raw = hit.comment_text
      if (!hit.objectID || !raw) continue
      const text = stripHtml(raw)
      if (text.length < 20) continue // 短すぎるコメントは除外
      results.push({
        objectID: String(hit.objectID),
        author: hit.author || 'anonymous',
        text,
        storyTitle: hit.story_title || '',
        createdAt: hit.created_at || new Date().toISOString(),
      })
    }
    return results
  } catch (e) {
    console.error(`  HN fetch error for "${brand}":`, e)
    return []
  }
}

export async function fetchHackerNewsMentions(
  db: D1Database,
  offset: number = 0
): Promise<{
  total: number
  offset: number
  processed: number
  newComments: number
  done: boolean
  next_offset: number
}> {
  const totalRow = await db
    .prepare('SELECT COUNT(*) as cnt FROM tracked_apps')
    .first<{ cnt: number }>()
  const total = totalRow?.cnt || 0

  const apps = await db
    .prepare('SELECT id, apple_id, app_name FROM tracked_apps ORDER BY id LIMIT ? OFFSET ?')
    .bind(HN_CHUNK, offset)
    .all<TrackedApp>()
  const rows = apps.results || []

  // HNコメントは星評価が無い → rating は中立の 3 を置き、感情はテキストから判定させる
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO reviews 
     (tracked_app_id, review_id, author, rating, title, body, app_version, region, review_date)
     VALUES (?, ?, ?, 3, ?, ?, '', 'hackernews', ?)`
  )

  // 実際の新規挿入数は INSERT OR IGNORE 前後の行数差で正確に測る
  // （D1 の batch() の meta.changes は挿入行数と一致しないため使わない）
  const beforeRow = await db
    .prepare("SELECT COUNT(*) as cnt FROM reviews WHERE region = 'hackernews'")
    .first<{ cnt: number }>()
  const before = beforeRow?.cnt || 0

  for (const app of rows) {
    const brand = brandName(app.app_name)
    if (brand.length < 2) {
      await new Promise((r) => setTimeout(r, 100))
      continue
    }

    const comments = await searchHackerNews(brand, HITS_PER_APP)
    // ブランド名が本文に実際に含まれるものだけ採用（無関係ヒットのノイズ低減）
    const relevant = comments.filter((c) => c.text.toLowerCase().includes(brand.toLowerCase()))

    if (relevant.length > 0) {
      const batch = relevant.map((c) =>
        insertStmt.bind(
          app.id,
          `hn-${c.objectID}`,
          c.author,
          c.storyTitle.slice(0, 200),
          c.text.slice(0, 4000),
          c.createdAt
        )
      )
      await db.batch(batch)
    }
    console.log(`  HN "${brand}": ${relevant.length} relevant matches`)

    // HN Algolia へのレート配慮
    await new Promise((r) => setTimeout(r, 700))
  }

  const afterRow = await db
    .prepare("SELECT COUNT(*) as cnt FROM reviews WHERE region = 'hackernews'")
    .first<{ cnt: number }>()
  const newComments = (afterRow?.cnt || 0) - before

  const processed = rows.length
  const next_offset = offset + processed
  const done = next_offset >= total || processed === 0

  console.log(
    `HN backfill: offset=${offset} processed=${processed} newComments=${newComments} total=${total} done=${done}`
  )
  return { total, offset, processed, newComments, done, next_offset }
}


// cron用: monitor_state の 'hn_offset' を使って全アプリを巡回しながら少しずつHN取得する。
// 6時間ごとに HN_CHUNK 件ずつ進み、末尾に達したら 0 に巻き戻す（54アプリなら約3日で一巡）。
// マイグレーション不要（monitor_state の key-value を再利用）。
export async function runHackerNewsCron(
  db: D1Database
): Promise<{ offset: number; nextOffset: number; newComments: number; done: boolean }> {
  // 現在の巡回位置を取得
  const stateRow = await db
    .prepare("SELECT value FROM monitor_state WHERE key = 'hn_offset'")
    .first<{ value: string }>()
  const offset = parseInt(stateRow?.value || '0') || 0

  const result = await fetchHackerNewsMentions(db, offset)

  // 次の位置（末尾=done なら 0 に巻き戻して巡回を継続）
  const nextOffset = result.done ? 0 : result.next_offset
  await db
    .prepare(
      "INSERT INTO monitor_state (key, value, updated_at) VALUES ('hn_offset', ?, datetime('now')) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    .bind(String(nextOffset))
    .run()

  console.log(`HN cron: offset=${offset} -> next=${nextOffset} newComments=${result.newComments}`)
  return { offset, nextOffset, newComments: result.newComments, done: result.done }
}
