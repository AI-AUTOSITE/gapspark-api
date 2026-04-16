// Claude API Deep Dive — ペインポイントの詳細分析
// v2: JSONパース強化 + エラー詳細化 + system prompt追加

interface PainPoint {
  id: number
  category: string
  title: string
  summary: string
  severity_score: number
  sample_app_ids: string
  keywords: string
  related_topics: string
}

interface RelatedReview {
  title: string
  body: string
  rating: number
  app_name: string
}

interface DeepDiveResult {
  pain_point_id: number
  root_causes: {
    cause: string
    percentage: number
    explanation: string
  }[]
  market_opportunity: {
    size: string
    reasoning: string
    willingness_to_pay: string
  }
  competitors: {
    name: string
    weakness: string
  }[]
  app_concept: {
    name: string
    tagline: string
    description: string
    target_audience: string
    monetization: string
    mvp_features: string[]
  }
  summary: string
}

/**
 * Deep Dive 実行（キャッシュ優先）
 */
export async function getDeepDive(
  db: D1Database,
  claudeApiKey: string,
  painPointId: number
): Promise<{ result: DeepDiveResult; cached: boolean }> {
  
  const painPoint = await db.prepare(
    'SELECT * FROM pain_points WHERE id = ?'
  ).bind(painPointId).first<PainPoint>()

  if (!painPoint) {
    throw new Error('Pain point not found')
  }

  // キャッシュチェック
  const cached = await db.prepare(
    'SELECT analysis FROM deep_dives WHERE pain_point_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(painPointId).first<{ analysis: string }>()

  if (cached) {
    console.log(`Deep Dive cache hit for pain point ${painPointId}`)
    return { result: JSON.parse(cached.analysis), cached: true }
  }

  // 関連レビューを取得
  const appIds = JSON.parse(painPoint.sample_app_ids || '[]') as number[]
  let reviews: RelatedReview[] = []

  if (appIds.length > 0) {
    const placeholders = appIds.map(() => '?').join(',')
    const result = await db.prepare(`
      SELECT r.title, r.body, r.rating, ta.app_name
      FROM reviews r
      JOIN tracked_apps ta ON ta.id = r.tracked_app_id
      WHERE r.tracked_app_id IN (${placeholders})
        AND r.sentiment_label = 'NEGATIVE'
      ORDER BY r.sentiment_score ASC
      LIMIT 15
    `).bind(...appIds).all<RelatedReview>()
    reviews = result.results || []
  }

  if (reviews.length < 5) {
    const keywords = JSON.parse(painPoint.keywords || '[]') as string[]
    if (keywords.length > 0) {
      const keyword = keywords[0]
      const extra = await db.prepare(`
        SELECT r.title, r.body, r.rating, ta.app_name
        FROM reviews r
        JOIN tracked_apps ta ON ta.id = r.tracked_app_id
        WHERE r.sentiment_label = 'NEGATIVE'
          AND (r.title LIKE ? OR r.body LIKE ?)
        ORDER BY r.sentiment_score ASC
        LIMIT 10
      `).bind(`%${keyword}%`, `%${keyword}%`).all<RelatedReview>()
      reviews = [...reviews, ...(extra.results || [])]
    }
  }

  console.log(`Calling Claude API for pain point ${painPointId} with ${reviews.length} reviews`)
  const analysis = await callClaudeAPI(claudeApiKey, painPoint, reviews)

  // キャッシュ保存
  await db.prepare(
    'INSERT INTO deep_dives (pain_point_id, analysis, model_used) VALUES (?, ?, ?)'
  ).bind(painPointId, JSON.stringify(analysis), 'claude-haiku-4-5').run()

  console.log(`Deep Dive completed and cached for pain point ${painPointId}`)
  return { result: analysis, cached: false }
}


/**
 * Claude Haiku 4.5 API 呼び出し（v2: system prompt + 強化パーサー）
 */
async function callClaudeAPI(
  apiKey: string,
  painPoint: PainPoint,
  reviews: RelatedReview[]
): Promise<DeepDiveResult> {
  
  const reviewText = reviews
    .slice(0, 15)
    .map(r => `[${r.rating}★ ${r.app_name}] ${r.title}: ${r.body.substring(0, 150)}`)
    .join('\n')

  // v2: system prompt で JSON-only を強制
  const systemPrompt = `You are an expert app market analyst. You ALWAYS respond with valid JSON only. Never include markdown code blocks, explanations, or any text outside the JSON object. Your entire response must be parseable by JSON.parse().`

  const userPrompt = `Analyze this user pain point and related app reviews.

PAIN POINT: "${painPoint.title}"
CATEGORY: ${painPoint.category}
SUMMARY: ${painPoint.summary}
KEYWORDS: ${painPoint.keywords}

RELATED NEGATIVE REVIEWS (${reviews.length} reviews):
${reviewText}

Respond with this EXACT JSON structure:
{
  "root_causes": [
    {"cause": "Short cause title", "percentage": 40, "explanation": "Why this is a root cause"},
    {"cause": "Another cause", "percentage": 35, "explanation": "Explanation"},
    {"cause": "Third cause", "percentage": 25, "explanation": "Explanation"}
  ],
  "market_opportunity": {
    "size": "Small|Medium|Large|Massive",
    "reasoning": "2-3 sentences on why this is a viable market",
    "willingness_to_pay": "Estimated price range users would pay"
  },
  "competitors": [
    {"name": "Existing app or solution", "weakness": "Where it falls short"},
    {"name": "Another competitor", "weakness": "Its weakness"}
  ],
  "app_concept": {
    "name": "Suggested app name",
    "tagline": "One-line description",
    "description": "2-3 sentence app description",
    "target_audience": "Who would use this",
    "monetization": "How to make money",
    "mvp_features": ["Feature 1", "Feature 2", "Feature 3", "Feature 4"]
  },
  "summary": "2-3 sentence executive summary"
}

Rules:
- root_causes percentages must add up to 100
- Be specific and actionable, not generic
- Base analysis on the actual review data provided
- competitors should be real apps or common workarounds`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    console.error('Claude API error:', response.status, errorBody)
    throw new Error(`Claude API error: ${response.status} — ${errorBody.substring(0, 200)}`)
  }

  const data = await response.json() as {
    content: { type: string; text: string }[]
  }

  const text = data.content
    ?.filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('') || ''

  // デバッグ用: 最初の500文字をログに出す（パース失敗時の診断用）
  console.log(`Claude response preview (${text.length} chars):`, text.substring(0, 500))

  return parseDeepDiveResponse(text, painPoint.id)
}


/**
 * Claude レスポンスのJSONパース（v2: 強化版、複数パターン試行）
 */
function parseDeepDiveResponse(text: string, painPointId: number): DeepDiveResult {
  // クリーンアップ: markdown コードブロックを除去
  let cleaned = text.trim()
  
  // ```json ... ``` を除去
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  
  // 前後の余計な文章を除去: 最初の { から最後の } まで抽出
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1)
  }

  // パターン1: 直接パース
  try {
    const parsed = JSON.parse(cleaned)
    return { pain_point_id: painPointId, ...validateDeepDive(parsed) }
  } catch (e1) {
    console.log('Parse attempt 1 failed:', e1 instanceof Error ? e1.message : String(e1))
  }

  // パターン2: より寛容なJSON抽出（改行や余計な空白を削除）
  try {
    const normalized = cleaned.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ')
    const parsed = JSON.parse(normalized)
    return { pain_point_id: painPointId, ...validateDeepDive(parsed) }
  } catch (e2) {
    console.log('Parse attempt 2 failed:', e2 instanceof Error ? e2.message : String(e2))
  }

  // パターン3: 壊れたJSONの修復試行（末尾のカンマ削除）
  try {
    const fixed = cleaned
      .replace(/,(\s*[}\]])/g, '$1')  // 末尾カンマ削除
      .replace(/([{,]\s*)(\w+):/g, '$1"$2":')  // クォート無しキー追加
    const parsed = JSON.parse(fixed)
    return { pain_point_id: painPointId, ...validateDeepDive(parsed) }
  } catch (e3) {
    console.log('Parse attempt 3 failed:', e3 instanceof Error ? e3.message : String(e3))
  }

  // 全て失敗 — 詳細なエラーログ
  console.error('All parse attempts failed. Response text:')
  console.error(text.substring(0, 1000))
  throw new Error(`Failed to parse Claude response. Preview: ${text.substring(0, 150)}`)
}


/**
 * レスポンスのバリデーション
 */
function validateDeepDive(data: any): Omit<DeepDiveResult, 'pain_point_id'> {
  return {
    root_causes: Array.isArray(data.root_causes)
      ? data.root_causes.slice(0, 5).map((rc: any) => ({
          cause: String(rc.cause || 'Unknown'),
          percentage: Number(rc.percentage) || 0,
          explanation: String(rc.explanation || ''),
        }))
      : [],
    market_opportunity: {
      size: String(data.market_opportunity?.size || 'Unknown'),
      reasoning: String(data.market_opportunity?.reasoning || ''),
      willingness_to_pay: String(data.market_opportunity?.willingness_to_pay || 'Unknown'),
    },
    competitors: Array.isArray(data.competitors)
      ? data.competitors.slice(0, 5).map((c: any) => ({
          name: String(c.name || 'Unknown'),
          weakness: String(c.weakness || ''),
        }))
      : [],
    app_concept: {
      name: String(data.app_concept?.name || 'Untitled'),
      tagline: String(data.app_concept?.tagline || ''),
      description: String(data.app_concept?.description || ''),
      target_audience: String(data.app_concept?.target_audience || ''),
      monetization: String(data.app_concept?.monetization || ''),
      mvp_features: Array.isArray(data.app_concept?.mvp_features)
        ? data.app_concept.mvp_features.map(String).slice(0, 6)
        : [],
    },
    summary: String(data.summary || ''),
  }
}


/**
 * Deep Dive 使用回数チェック（1日3回制限）
 */
export async function checkDeepDiveLimit(
  db: D1Database,
  userId: number
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const today = new Date().toISOString().split('T')[0]
  const limit = 3

  const usage = await db.prepare(
    'SELECT count FROM deep_dive_usage WHERE user_id = ? AND usage_date = ?'
  ).bind(userId, today).first<{ count: number }>()

  const used = usage?.count || 0
  return { allowed: used < limit, used, limit }
}


/**
 * Deep Dive 使用回数を記録
 */
export async function recordDeepDiveUsage(
  db: D1Database,
  userId: number
): Promise<void> {
  const today = new Date().toISOString().split('T')[0]

  await db.prepare(`
    INSERT INTO deep_dive_usage (user_id, usage_date, count) 
    VALUES (?, ?, 1)
    ON CONFLICT(user_id, usage_date) 
    DO UPDATE SET count = count + 1
  `).bind(userId, today).run()
}
