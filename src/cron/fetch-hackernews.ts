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
export async function searchHackerNews(brand: string, hits: number): Promise<HNComment[] | null> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(
    brand
  )}&tags=comment&hitsPerPage=${hits}`

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'GapSpark/1.0' } })
    if (!res.ok) {
      // HTTP エラーも「該当なし」ではなく「検索できなかった」
      console.error(`  HN HTTP ${res.status} for "${brand}"`)
      return null
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
    // 【2026-09-30 変更】失敗を [] で返さず null で返す。
    // [] は「検索したが該当なし」、null は「検索できなかった」。
    // 呼び出し側は null のとき offset を進めず、次回同じ5アプリを再試行する。
    console.error(`  HN fetch error for "${brand}":`, e)
    return null
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
  fetchErrors: number
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

  // 【2026-09-30 変更】新規挿入数の数え方を変更。
  // 以前は INSERT 前後で COUNT(*) WHERE region='hackernews' を2回実行していたが、
  // region に索引が無いため reviews 全件（約23万行）のフルスキャン×2。
  // 6時間cronで1日4回 = 約190万行/日で、D1読み取りの最大の消費源だった。
  // 今は「これから入れるIDのうち、既に存在する数」を UNIQUE 索引で引く（1アプリ数十行）。
  let newComments = 0
  let fetchErrors = 0

  for (const app of rows) {
    const brand = brandName(app.app_name)
    if (brand.length < 2) {
      await new Promise((r) => setTimeout(r, 100))
      continue
    }

    const comments = await searchHackerNews(brand, HITS_PER_APP)
    if (comments === null) {
      // 検索できなかった（Algolia のエラー等）。「該当なし」とは別物。
      fetchErrors++
      await new Promise((r) => setTimeout(r, 700))
      continue
    }
    // ブランド名が本文に実際に含まれるものだけ採用（無関係ヒットのノイズ低減）
    const relevant = comments.filter((c) => c.text.toLowerCase().includes(brand.toLowerCase()))

    if (relevant.length > 0) {
      // UNIQUE(tracked_app_id, review_id, region) の索引で、既存分だけ数える
      const ids = relevant.map((c) => `hn-${c.objectID}`)
      const placeholders = ids.map(() => '?').join(',')
      const existingRow = await db
        .prepare(
          `SELECT COUNT(*) as cnt FROM reviews
           WHERE tracked_app_id = ? AND region = 'hackernews' AND review_id IN (${placeholders})`
        )
        .bind(app.id, ...ids)
        .first<{ cnt: number }>()
      const existing = existingRow?.cnt || 0

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
      newComments += relevant.length - existing
    }
    console.log(`  HN "${brand}": ${relevant.length} relevant matches`)

    // HN Algolia へのレート配慮
    await new Promise((r) => setTimeout(r, 700))
  }

  const processed = rows.length

  // 全部失敗 = Algolia 側の障害。offset を進めず、次回同じ5アプリを再試行する。
  // 一部だけ失敗 = そのアプリ固有の問題の可能性。進める（次の周回で戻ってくる）。
  // 「全部失敗でも進める」と障害中の5アプリを飛ばし、「1つでも失敗で止める」と
  // 壊れた1アプリで巡回全体が止まる。その中間を取る。
  const allFailed = processed > 0 && fetchErrors === processed
  const next_offset = allFailed ? offset : offset + processed
  const done = !allFailed && (next_offset >= total || processed === 0)

  console.log(
    `HN backfill: offset=${offset} processed=${processed} newComments=${newComments} fetchErrors=${fetchErrors} total=${total} done=${done}`
  )
  return { total, offset, processed, newComments, done, next_offset, fetchErrors }
}


// cron用: monitor_state の 'hn_offset' を使って全アプリを巡回しながら少しずつHN取得する。
// 6時間ごとに HN_CHUNK 件ずつ進み、末尾に達したら 0 に巻き戻す（54アプリなら約3日で一巡）。
// マイグレーション不要（monitor_state の key-value を再利用）。
export async function runHackerNewsCron(
  db: D1Database
): Promise<{ offset: number; nextOffset: number; newComments: number; done: boolean; fetchErrors: number }> {
  // 現在の巡回位置を取得
  const stateRow = await db
    .prepare("SELECT value FROM monitor_state WHERE key = 'hn_offset'")
    .first<{ value: string }>()
  const offset = parseInt(stateRow?.value || '0') || 0

  const result = await fetchHackerNewsMentions(db, offset)

  // 【2026-09-30 追加】失敗数を残す。数えるだけでログに埋もれると、
  // 毎回1本だけ失敗するアプリが永久に飛ばされても誰も気づかない。週報が読む。
  await db.prepare(`
    INSERT INTO monitor_state (key, value, updated_at) VALUES ('hn_last_fetch_errors', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).bind(String(result.fetchErrors)).run()

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
  return { offset, nextOffset, newComments: result.newComments, done: result.done, fetchErrors: result.fetchErrors }
}
