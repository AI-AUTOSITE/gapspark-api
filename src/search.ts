// 統合検索 — 1つのクエリで Topics / Apps / Pain Points を同時検索
// Section 7: Unified Search System

// ========================================
// 型定義
// ========================================

export interface UnifiedSearchResult {
  query: string
  topics: TopicResult[]
  apps: AppResult[]
  pain_points: PainPointResult[]
}

export interface TopicResult {
  topic: string
  pain_point_count: number
  app_count: number
}

interface AppResult {
  id: number
  app_name: string
  category: string
  tags: string       // JSON array
  icon_url: string | null
  average_rating: number | null
  pain_point_count: number
}

interface PainPointResult {
  id: number
  category: string
  title: string
  summary: string
  severity_score: number
  frequency: number
  keywords: string        // JSON array
  related_topics: string  // JSON array
  ai_generated_idea: string
}

// ========================================
// メイン: 統合検索
// ========================================

/**
 * 統合検索 — apps/topics/pain-points を同時検索
 * 
 * Topics: tracked_apps.tags + pain_points.related_topics からマッチ
 * Apps: app_name, category, tags でマッチ
 * Pain Points: title, summary, keywords, related_topics でマッチ
 */
export async function unifiedSearch(
  db: D1Database,
  query: string
): Promise<UnifiedSearchResult> {
  const q = query.trim().toLowerCase()
  if (!q) {
    return { query: '', topics: [], apps: [], pain_points: [] }
  }

  const likePattern = `%${q}%`

  // 3つの検索を並列実行
  const [topics, apps, keywordPainPoints] = await Promise.all([
    searchTopics(db, q),
    searchApps(db, likePattern),
    searchPainPoints(db, likePattern),
  ])

  // マッチしたアプリの関連ペインポイントも取得
  // 例: "Notion"検索 → Notionアプリがヒット → Notionに紐づくペインポイントも含める
  let painPoints = keywordPainPoints
  if (apps.length > 0) {
    const appIds = apps.map(a => a.id)
    const appPainPoints = await searchPainPointsByAppIds(db, appIds)

    // キーワード検索結果とマージ（IDで重複除去）
    const seenIds = new Set(keywordPainPoints.map(pp => pp.id))
    for (const pp of appPainPoints) {
      if (!seenIds.has(pp.id)) {
        painPoints.push(pp)
        seenIds.add(pp.id)
      }
    }

    // severity順で再ソート
    painPoints.sort((a, b) => b.severity_score - a.severity_score || b.frequency - a.frequency)
    painPoints = painPoints.slice(0, 20)
  }

  return { query: q, topics, apps, pain_points: painPoints }
}


// ========================================
// Topics 検索
// ========================================

/**
 * tracked_apps.tags と pain_points.related_topics の両方から
 * マッチするトピックを抽出し、件数付きで返す
 */
async function searchTopics(
  db: D1Database,
  query: string
): Promise<TopicResult[]> {
  const likePattern = `%${query}%`

  // tracked_apps.tags からマッチするトピックを集計
  const appTopics = await db.prepare(`
    SELECT LOWER(json_each.value) as topic, COUNT(DISTINCT ta.id) as app_count
    FROM tracked_apps ta, json_each(ta.tags)
    WHERE LOWER(json_each.value) LIKE ?
    GROUP BY LOWER(json_each.value)
  `).bind(likePattern).all<{ topic: string; app_count: number }>()

  // pain_points.related_topics からマッチするトピックを集計
  const ppTopics = await db.prepare(`
    SELECT LOWER(json_each.value) as topic, COUNT(DISTINCT pp.id) as pain_point_count
    FROM pain_points pp, json_each(pp.related_topics)
    WHERE LOWER(json_each.value) LIKE ?
    GROUP BY LOWER(json_each.value)
  `).bind(likePattern).all<{ topic: string; pain_point_count: number }>()

  // 2つの結果をマージ
  const topicMap = new Map<string, TopicResult>()

  for (const t of (appTopics.results || [])) {
    topicMap.set(t.topic, {
      topic: t.topic,
      app_count: t.app_count,
      pain_point_count: 0,
    })
  }

  for (const t of (ppTopics.results || [])) {
    const existing = topicMap.get(t.topic)
    if (existing) {
      existing.pain_point_count = t.pain_point_count
    } else {
      topicMap.set(t.topic, {
        topic: t.topic,
        app_count: 0,
        pain_point_count: t.pain_point_count,
      })
    }
  }

  // 関連度が高い順（ペインポイント数 + アプリ数）でソート
  return Array.from(topicMap.values())
    .sort((a, b) => (b.pain_point_count + b.app_count) - (a.pain_point_count + a.app_count))
    .slice(0, 10)
}


// ========================================
// Apps 検索
// ========================================

/**
 * app_name, category, tags でアプリを検索
 * 各アプリの関連ペインポイント数も返す
 */
async function searchApps(
  db: D1Database,
  likePattern: string
): Promise<AppResult[]> {
  const result = await db.prepare(`
    SELECT 
      ta.id, ta.app_name, ta.category, ta.tags, 
      ta.icon_url, ta.average_rating,
      (
        SELECT COUNT(*) FROM pain_points pp
        WHERE EXISTS (
          SELECT 1 FROM json_each(pp.sample_app_ids) 
          WHERE json_each.value = ta.id
        )
      ) as pain_point_count
    FROM tracked_apps ta
    WHERE ta.app_name LIKE ?1
      OR ta.category LIKE ?1
      OR EXISTS (
        SELECT 1 FROM json_each(ta.tags) 
        WHERE LOWER(json_each.value) LIKE ?1
      )
    ORDER BY pain_point_count DESC, ta.app_name ASC
    LIMIT 10
  `).bind(likePattern).all()

  return (result.results || []).map((r: any) => ({
    id: r.id,
    app_name: r.app_name,
    category: r.category,
    tags: r.tags,
    icon_url: r.icon_url,
    average_rating: r.average_rating,
    pain_point_count: r.pain_point_count || 0,
  }))
}


// ========================================
// Pain Points 検索
// ========================================

/**
 * title, summary, keywords, related_topics でペインポイントを検索
 */
async function searchPainPoints(
  db: D1Database,
  likePattern: string
): Promise<PainPointResult[]> {
  const result = await db.prepare(`
    SELECT 
      id, category, title, summary, severity_score, 
      frequency, keywords, related_topics, ai_generated_idea
    FROM pain_points
    WHERE title LIKE ?1
      OR summary LIKE ?1
      OR keywords LIKE ?1
      OR related_topics LIKE ?1
    ORDER BY severity_score DESC, frequency DESC
    LIMIT 20
  `).bind(likePattern).all()

  return (result.results || []).map((r: any) => ({
    id: r.id,
    category: r.category,
    title: r.title,
    summary: r.summary,
    severity_score: r.severity_score,
    frequency: r.frequency,
    keywords: r.keywords,
    related_topics: r.related_topics,
    ai_generated_idea: r.ai_generated_idea,
  }))
}


/**
 * マッチしたアプリIDに紐づくペインポイントを取得
 * "Notion"検索 → Notionアプリヒット → そのペインポイントも返す
 */
async function searchPainPointsByAppIds(
  db: D1Database,
  appIds: number[]
): Promise<PainPointResult[]> {
  if (appIds.length === 0) return []

  // EXISTS パターン（searchApps のサブクエリと同じ方式 — 動作実績あり）
  const placeholders = appIds.map(() => '?').join(',')
  const result = await db.prepare(`
    SELECT 
      pp.id, pp.category, pp.title, pp.summary, pp.severity_score,
      pp.frequency, pp.keywords, pp.related_topics, pp.ai_generated_idea
    FROM pain_points pp
    WHERE EXISTS (
      SELECT 1 FROM json_each(pp.sample_app_ids)
      WHERE json_each.value IN (${placeholders})
    )
    ORDER BY pp.severity_score DESC, pp.frequency DESC
    LIMIT 20
  `).bind(...appIds).all()

  return (result.results || []).map((r: any) => ({
    id: r.id,
    category: r.category,
    title: r.title,
    summary: r.summary,
    severity_score: r.severity_score,
    frequency: r.frequency,
    keywords: r.keywords,
    related_topics: r.related_topics,
    ai_generated_idea: r.ai_generated_idea,
  }))
}


// ========================================
// Popular Topics（検索バー空欄時の表示用）
// ========================================

/**
 * 全トピックをペインポイント数 + アプリ数が多い順に返す
 * iOS側: 検索バーが空でフォーカス時にチップ表示
 */
export async function getPopularTopics(
  db: D1Database
): Promise<TopicResult[]> {
  // tracked_apps.tags から全トピック集計
  const appTopics = await db.prepare(`
    SELECT LOWER(json_each.value) as topic, COUNT(DISTINCT ta.id) as app_count
    FROM tracked_apps ta, json_each(ta.tags)
    GROUP BY LOWER(json_each.value)
    ORDER BY app_count DESC
    LIMIT 30
  `).all<{ topic: string; app_count: number }>()

  // pain_points.related_topics から全トピック集計
  const ppTopics = await db.prepare(`
    SELECT LOWER(json_each.value) as topic, COUNT(DISTINCT pp.id) as pain_point_count
    FROM pain_points pp, json_each(pp.related_topics)
    GROUP BY LOWER(json_each.value)
    ORDER BY pain_point_count DESC
    LIMIT 30
  `).all<{ topic: string; pain_point_count: number }>()

  // マージ
  const topicMap = new Map<string, TopicResult>()

  for (const t of (appTopics.results || [])) {
    topicMap.set(t.topic, { topic: t.topic, app_count: t.app_count, pain_point_count: 0 })
  }

  for (const t of (ppTopics.results || [])) {
    const existing = topicMap.get(t.topic)
    if (existing) {
      existing.pain_point_count = t.pain_point_count
    } else {
      topicMap.set(t.topic, { topic: t.topic, app_count: 0, pain_point_count: t.pain_point_count })
    }
  }

  return Array.from(topicMap.values())
    .sort((a, b) => (b.pain_point_count + b.app_count) - (a.pain_point_count + a.app_count))
    .slice(0, 15)
}


// ========================================
// Topic Detail — 特定トピックのアプリ・ペインポイント
// ========================================

/**
 * 特定トピックに関連するアプリを取得
 */
export async function getAppsByTopic(
  db: D1Database,
  topic: string
): Promise<AppResult[]> {
  const result = await db.prepare(`
    SELECT 
      ta.id, ta.app_name, ta.category, ta.tags, 
      ta.icon_url, ta.average_rating,
      (
        SELECT COUNT(*) FROM pain_points pp
        WHERE EXISTS (
          SELECT 1 FROM json_each(pp.sample_app_ids) 
          WHERE json_each.value = ta.id
        )
      ) as pain_point_count
    FROM tracked_apps ta
    WHERE EXISTS (
      SELECT 1 FROM json_each(ta.tags)
      WHERE LOWER(json_each.value) = LOWER(?)
    )
    ORDER BY pain_point_count DESC, ta.app_name ASC
  `).bind(topic).all()

  return (result.results || []).map((r: any) => ({
    id: r.id,
    app_name: r.app_name,
    category: r.category,
    tags: r.tags,
    icon_url: r.icon_url,
    average_rating: r.average_rating,
    pain_point_count: r.pain_point_count || 0,
  }))
}

/**
 * 特定トピックに関連するペインポイントを取得
 */
export async function getPainPointsByTopic(
  db: D1Database,
  topic: string
): Promise<PainPointResult[]> {
  const result = await db.prepare(`
    SELECT 
      id, category, title, summary, severity_score,
      frequency, keywords, related_topics, ai_generated_idea
    FROM pain_points
    WHERE EXISTS (
      SELECT 1 FROM json_each(related_topics)
      WHERE LOWER(json_each.value) = LOWER(?)
    )
    ORDER BY severity_score DESC, frequency DESC
    LIMIT 30
  `).bind(topic).all()

  return (result.results || []).map((r: any) => ({
    id: r.id,
    category: r.category,
    title: r.title,
    summary: r.summary,
    severity_score: r.severity_score,
    frequency: r.frequency,
    keywords: r.keywords,
    related_topics: r.related_topics,
    ai_generated_idea: r.ai_generated_idea,
  }))
}