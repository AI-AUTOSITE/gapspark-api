// Claude API Deep Dive — ペインポイントの詳細分析
// v2: JSONパース強化 + エラー詳細化 + system prompt追加
// v3: Pro（サブスク）は Deep Dive 無制限（checkDeepDiveLimit が isUserPro を参照）
// v4: 出力を「市場参入ギャップ重視」に刷新。
//     - 旧形式の全フィールドを維持（公開中の v1.0 アプリを壊さない上位互換）
//     - 新セクション: verdict / evidence_quotes / market_gap / willingness_to_pay / next_step
//     - すべての主張に basis: "evidence"（レビュー由来） | "hypothesis"（仮説）ラベル
//     - キャッシュは model_used のバージョンタグで世代管理（旧キャッシュと混ぜない）

import { isUserPro } from './subscription'

// キャッシュ世代タグ。出力形式やレビュー取得ロジックを変えたらここを上げる。
// 旧タグのキャッシュは読まれず、新形式が必要時に自動で再生成される。
// dd-v2: 市場参入ギャップ重視の出力構造
// dd-v3: レビュー取得を「キーワード一致優先」に刷新（分析の的中率向上）
// dd-v4: starter_prompt（AIコーディング用プロンプト）を追加
// dd-v5: Stage1の照合から汎用語("app"等)を除外し的中率を向上（バッジと同じ除外ロジック）
const DEEP_DIVE_FORMAT_TAG = 'claude-haiku-4-5:dd-v5'

// 汎用語（ほぼ全ネガレビューに出る語）— Stage 1 の照合から除外して的中率を上げる。
// ※ generate-pain-points.ts の GENERIC_TERMS と同じ内容に保つこと（バッジと挙動を揃える）。
const GENERIC_TERMS = new Set([
  'app', 'apps', 'application', 'applications',
  'ios', 'android', 'iphone', 'iphones', 'ipad', 'ipads',
  'phone', 'phones', 'device', 'devices', 'mobile', 'tablet',
  'version', 'versions', 'update', 'updates', 'updated', 'upgrade', 'upgrades',
  'work', 'works', 'working', 'worked', 'use', 'used', 'uses', 'using',
  'please', 'fix', 'fixed', 'fixes', 'get', 'gets', 'getting', 'got',
  'thing', 'things', 'time', 'times', 'way', 'ways',
  'want', 'wants', 'need', 'needs', 'make', 'makes', 'made',
  'really', 'even', 'back', 'still', 'since', 'every', 'always', 'never',
  'this', 'that', 'with', 'from', 'have', 'just', 'they', 'your', 'when', 'what',
])

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

// DBから取る際は重複除去のため review_id も持つ（Claudeへは RelatedReview に落として渡す）
interface RelatedReviewRow extends RelatedReview {
  review_id: string
}

function toReview(row: RelatedReviewRow): RelatedReview {
  return { title: row.title, body: row.body, rating: row.rating, app_name: row.app_name }
}

// ===== 出力構造（v4） =====
// 旧クライアント互換: root_causes / market_opportunity / competitors / app_concept / summary
// （Swift の Codable は未知のキーを無視するため、新フィールドを足しても旧アプリは壊れない）

interface DeepDiveResult {
  pain_point_id: number

  // --- 新: 結論ファースト ---
  verdict: {
    recommendation: 'build' | 'investigate' | 'skip'
    one_line_pitch: string
    confidence: 'high' | 'medium' | 'low'
    confidence_reason: string
  }

  // --- 旧互換（+ basis ラベル追加）---
  root_causes: {
    cause: string
    percentage: number
    basis: 'evidence' | 'hypothesis'
    explanation: string
  }[]

  // --- 新: レビューからの生引用（信頼性の担保）---
  evidence_quotes: string[]

  // --- 旧互換 ---
  market_opportunity: {
    size: string
    reasoning: string
    willingness_to_pay: string
  }

  // --- 新: 市場参入ギャップ（このDeep Diveの主役セクション）---
  market_gap: {
    why_unfixed: {
      hypothesis: string
      type:
        | 'innovators_dilemma'
        | 'business_model_conflict'
        | 'tech_debt'
        | 'enterprise_focus'
        | 'platform_constraint'
        | 'low_priority'
      solo_exploitable: boolean
      reasoning: string
    }[]
    gap_type: 'open' | 'protected' | 'contested'
    why_now: string
    differentiation_wedge: string
  }

  // --- 旧互換 ---
  competitors: {
    name: string
    weakness: string
  }[]

  // --- 新: 競合の読み（competition is validation）---
  competition_read: 'validation' | 'crowded' | 'greenfield_risk'

  // --- 旧互換（+ build_estimate / cut_list 追加）---
  app_concept: {
    name: string
    tagline: string
    description: string
    target_audience: string
    monetization: string
    mvp_features: string[]
    build_estimate: string
    cut_list: string[]
  }

  // --- 新: 支払い意思のシグナル ---
  willingness_to_pay: {
    signal: 'strong' | 'moderate' | 'weak' | 'unknown'
    evidence: string
  }

  // --- 新: 作る前の最安の検証と撤退基準 ---
  next_step: {
    cheapest_test: string
    kill_criteria: string
  }

  // --- 新: AIコーディング用スタータープロンプト（Pro限定でUI表示）---
  starter_prompt: string

  // --- 旧互換 ---
  summary: string
}

/**
 * キャッシュ済みDeep Diveを取得（現行フォーマットのみ）。無ければ null。
 * Claude呼び出しも回数記録もしない。UIの「分析済み」判定・再表示に使う。
 */
export async function getCachedDeepDive(
  db: D1Database,
  painPointId: number
): Promise<DeepDiveResult | null> {
  const cached = await db.prepare(
    'SELECT analysis FROM deep_dives WHERE pain_point_id = ? AND model_used = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(painPointId, DEEP_DIVE_FORMAT_TAG).first<{ analysis: string }>()

  if (!cached) return null
  try {
    return JSON.parse(cached.analysis) as DeepDiveResult
  } catch {
    return null
  }
}

/**
 * 現行フォーマットで Deep Dive 済みのペインポイントID一覧。
 * Discover のカードに「Analyzed」バッジを出すのに使う（認証不要）。
 */
export async function getDeepDivedPainPointIds(db: D1Database): Promise<number[]> {
  const rows = await db.prepare(
    'SELECT DISTINCT pain_point_id FROM deep_dives WHERE model_used = ?'
  ).bind(DEEP_DIVE_FORMAT_TAG).all<{ pain_point_id: number }>()
  return (rows.results || []).map(r => r.pain_point_id)
}

/**
 * Deep Dive 実行（キャッシュ優先・世代タグ付き）
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

  // キャッシュチェック（現行フォーマットのみ。getCachedDeepDive と同じロジック）
  const cachedResult = await getCachedDeepDive(db, painPointId)
  if (cachedResult) {
    console.log(`Deep Dive cache hit for pain point ${painPointId}`)
    return { result: cachedResult, cached: true }
  }

  // 関連レビューを取得
  //
  // v4改善: 「ペインポイントに関連するレビュー」を最優先で集める。
  //   旧ロジックは "アプリのネガティブ上位15件" を先に取っていたため、
  //   ニッチなペインだと無関係なレビュー（価格・UI等）ばかり集まっていた。
  //   新ロジック:
  //     Stage 1: このペインの keywords / タイトル語に一致するネガレビューを優先収集
  //     Stage 2: 15件に満たない分だけ、対象アプリのネガティブ上位で補完
  //   これで分析対象がペインの本題に寄り、的中率が上がる。

  const TARGET = 15
  const appIds = JSON.parse(painPoint.sample_app_ids || '[]') as number[]
  const keywords = JSON.parse(painPoint.keywords || '[]') as string[]

  // タイトルからも検索語を補う（例: "Sync failures across devices" → sync, failures, devices）
  const titleTerms = painPoint.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4)

  // 検索語 = keywords（3文字以上）+ タイトル語、重複除去 → 汎用語を除外 → 最大6語
  // ※ generate-pain-points.ts の deriveSearchTerms と同じロジック（バッジと的中対象を揃える）
  const allTerms = Array.from(
    new Set([
      ...keywords.map(k => k.toLowerCase()).filter(k => k.length >= 3),
      ...titleTerms,
    ])
  )
  const distinctive = allTerms.filter(t => !GENERIC_TERMS.has(t))
  const searchTerms = (distinctive.length > 0 ? distinctive : allTerms).slice(0, 6)

  const byId = new Map<string, RelatedReview>()   // 重複除去（review_id 単位）
  const keyOf = (r: RelatedReviewRow) => `${r.review_id}`

  // --- Stage 1: キーワード一致のネガレビューを優先収集 ---
  if (searchTerms.length > 0) {
    const likeClauses = searchTerms.map(() => '(r.title LIKE ? OR r.body LIKE ?)').join(' OR ')
    const likeParams = searchTerms.flatMap(t => [`%${t}%`, `%${t}%`])

    // 対象アプリがあれば、その中を優先（無ければ全体から）
    const appFilter = appIds.length > 0
      ? `AND r.tracked_app_id IN (${appIds.map(() => '?').join(',')})`
      : ''

    const stage1 = await db.prepare(`
      SELECT r.review_id, r.title, r.body, r.rating, ta.app_name
      FROM reviews r
      JOIN tracked_apps ta ON ta.id = r.tracked_app_id
      WHERE r.sentiment_label = 'NEGATIVE'
        AND (${likeClauses})
        ${appFilter}
      ORDER BY r.sentiment_score ASC
      LIMIT ${TARGET}
    `).bind(...likeParams, ...appIds).all<RelatedReviewRow>()

    for (const row of (stage1.results || [])) {
      if (!byId.has(keyOf(row))) byId.set(keyOf(row), toReview(row))
    }
  }

  // --- Stage 2: 不足分を対象アプリのネガティブ上位で補完 ---
  if (byId.size < TARGET && appIds.length > 0) {
    const remaining = TARGET - byId.size
    const placeholders = appIds.map(() => '?').join(',')
    const stage2 = await db.prepare(`
      SELECT r.review_id, r.title, r.body, r.rating, ta.app_name
      FROM reviews r
      JOIN tracked_apps ta ON ta.id = r.tracked_app_id
      WHERE r.tracked_app_id IN (${placeholders})
        AND r.sentiment_label = 'NEGATIVE'
      ORDER BY r.sentiment_score ASC
      LIMIT ${TARGET}
    `).bind(...appIds).all<RelatedReviewRow>()

    for (const row of (stage2.results || [])) {
      if (byId.size >= TARGET) break
      if (!byId.has(keyOf(row))) byId.set(keyOf(row), toReview(row))
      void remaining
    }
  }

  const reviews: RelatedReview[] = Array.from(byId.values())

  const matchedCount = reviews.length
  console.log(`Calling Claude API for pain point ${painPointId} with ${matchedCount} reviews (search terms: ${searchTerms.join(', ') || 'none'})`)
  const analysis = await callClaudeAPI(claudeApiKey, painPoint, reviews)

  // キャッシュ保存（世代タグ付き）
  await db.prepare(
    'INSERT INTO deep_dives (pain_point_id, analysis, model_used) VALUES (?, ?, ?)'
  ).bind(painPointId, JSON.stringify(analysis), DEEP_DIVE_FORMAT_TAG).run()

  console.log(`Deep Dive completed and cached for pain point ${painPointId}`)
  return { result: analysis, cached: false }
}


/**
 * Claude Haiku 4.5 API 呼び出し（v4: 市場参入ギャップ重視プロンプト）
 */
async function callClaudeAPI(
  apiKey: string,
  painPoint: PainPoint,
  reviews: RelatedReview[]
): Promise<DeepDiveResult> {

  const reviewText = reviews
    .slice(0, 15)
    .map(r => `[${r.rating}★ ${r.app_name}] ${r.title}: ${r.body.substring(0, 200)}`)
    .join('\n')

  const systemPrompt = `You are an expert app market analyst advising solo indie developers and "vibe coders" (non-programmers who build apps with AI tools like Claude and Cursor). Your job is to turn App Store review pain into a concrete build / investigate / skip decision — never generic advice. You ALWAYS respond with valid JSON only. Never include markdown code blocks, explanations, or any text outside the JSON object. Your entire response must be parseable by JSON.parse().`

  const userPrompt = `Analyze this user pain point and related app reviews for a solo indie developer deciding what to build next.

PAIN POINT: "${painPoint.title}"
CATEGORY: ${painPoint.category}
SUMMARY: ${painPoint.summary}
KEYWORDS: ${painPoint.keywords}

RELATED NEGATIVE REVIEWS (${reviews.length} reviews):
${reviewText}

Respond with this EXACT JSON structure:
{
  "verdict": {
    "recommendation": "build|investigate|skip",
    "one_line_pitch": "The app to build, in one specific sentence",
    "confidence": "high|medium|low",
    "confidence_reason": "Why this confidence level, based on how much evidence the reviews provide"
  },
  "root_causes": [
    {"cause": "Short cause title", "percentage": 45, "basis": "evidence|hypothesis", "explanation": "Why, grounded in the reviews"},
    {"cause": "Another cause", "percentage": 35, "basis": "evidence|hypothesis", "explanation": "Explanation"},
    {"cause": "Third cause", "percentage": 20, "basis": "evidence|hypothesis", "explanation": "Explanation"}
  ],
  "evidence_quotes": ["short verbatim quote copied from a review above", "another verbatim quote"],
  "market_opportunity": {
    "size": "Small|Medium|Large|Massive",
    "reasoning": "2-3 sentences on why this is a viable market",
    "willingness_to_pay": "Estimated price range users would pay"
  },
  "market_gap": {
    "why_unfixed": [
      {"hypothesis": "Why the incumbent has NOT fixed this despite knowing about it", "type": "innovators_dilemma|business_model_conflict|tech_debt|enterprise_focus|platform_constraint|low_priority", "solo_exploitable": true, "reasoning": "1-2 sentences grounding this hypothesis"}
    ],
    "gap_type": "open|protected|contested",
    "why_now": "The timing catalyst — why this window exists right now",
    "differentiation_wedge": "The ONE specific thing a new app should do differently to win"
  },
  "competitors": [
    {"name": "Real app or common workaround", "weakness": "Where it falls short"},
    {"name": "Another competitor", "weakness": "Its weakness"}
  ],
  "competition_read": "validation|crowded|greenfield_risk",
  "app_concept": {
    "name": "Suggested app name",
    "tagline": "One-line description",
    "description": "2-3 sentence app description",
    "target_audience": "Who would use this",
    "monetization": "How to make money",
    "mvp_features": ["Feature 1", "Feature 2", "Feature 3", "Feature 4"],
    "build_estimate": "weekend|1-2 weeks|1-2 months",
    "cut_list": ["Feature to deliberately NOT build in v1", "Another feature to cut"]
  },
  "willingness_to_pay": {
    "signal": "strong|moderate|weak|unknown",
    "evidence": "Quotes or workaround costs from the reviews suggesting people would pay"
  },
  "next_step": {
    "cheapest_test": "The cheapest way to validate demand BEFORE building",
    "kill_criteria": "What result should make the developer walk away"
  },
  "starter_prompt": "A complete, copy-paste-ready prompt the developer can paste into an AI coding assistant (Claude, Cursor) to START building this app. Write it as a direct instruction to the AI, 120-200 words. Include: what to build, the core screens, the suggested tech stack for a solo developer, and the first feature to implement. Make it specific to THIS app concept, not generic.",
  "summary": "2-3 sentence executive summary"
}

Rules:
- basis labels: "evidence" = directly supported by the provided reviews; "hypothesis" = your reasoned speculation. NEVER present a hypothesis as fact.
- why_unfixed types: innovators_dilemma (this segment is too small to matter for the incumbent's growth), business_model_conflict (fixing it would hurt their revenue, e.g. ads or upsells), tech_debt (legacy architecture makes the fix expensive), enterprise_focus (roadmap serves big customers, not this pain), platform_constraint (OS or platform rules block a fix), low_priority (known but deprioritized).
- gap_type: "open" = incumbents are structurally unwilling to fix this AND a solo developer can realistically enter; "protected" = the gap exists but network effects, proprietary data, or regulation block small players; "contested" = evidence is too thin or many small players already attack it.
- solo_exploitable: true only if a solo developer using AI coding tools could realistically exploit this specific opening.
- evidence_quotes: 2-3 SHORT quotes copied VERBATIM from the reviews above. Never invent or paraphrase quotes.
- root_causes percentages must add up to 100.
- app_concept.cut_list: features to deliberately NOT build in v1 (ruthless de-scoping for a solo developer).
- Be specific to THIS pain point and THESE reviews. Advice that could apply to any app is a failure.
- starter_prompt: write it so a non-expert could paste it into Claude or Cursor and immediately start building. Name concrete screens and the first feature. If recommendation is "skip", still provide a starter_prompt for the reframed/alternative concept.
- Output raw JSON only.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3500,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
        // prefill: 応答を "{" で始めさせ、JSON以外の前置き/markdownフェンスを防ぐ
        { role: 'assistant', content: '{' }
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

  const rawText = data.content
    ?.filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('') || ''

  // prefill で assistant を "{" で開始させているため、応答本文には先頭の "{" が
  // 含まれない。補ってからパースする（既に "{" で始まっていれば二重付与しない）。
  const text = rawText.trimStart().startsWith('{') ? rawText : '{' + rawText

  // デバッグ用: 最初の500文字をログに出す（パース失敗時の診断用）
  console.log(`Claude response preview (${text.length} chars):`, text.substring(0, 500))

  return parseDeepDiveResponse(text, painPoint.id)
}


/**
 * Claude レスポンスのJSONパース（v2から継続: 強化版、複数パターン試行）
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

  // パターン3: 壊れたJSONの修復試行（末尾カンマ・クォート無しキー）
  try {
    const fixed = cleaned
      .replace(/,(\s*[}\]])/g, '$1')  // 末尾カンマ削除
      .replace(/([{,]\s*)(\w+):/g, '$1"$2":')  // クォート無しキー追加
    const parsed = JSON.parse(fixed)
    return { pain_point_id: painPointId, ...validateDeepDive(parsed) }
  } catch (e3) {
    console.log('Parse attempt 3 failed:', e3 instanceof Error ? e3.message : String(e3))
  }

  // パターン4: 文字列値の中の「生の制御文字（改行・タブ等）」をエスケープして修復
  // Claude が長い説明文に生の改行を入れてJSONを壊すケースへの対処。
  try {
    const repaired = escapeControlCharsInStrings(cleaned)
    const parsed = JSON.parse(repaired)
    return { pain_point_id: painPointId, ...validateDeepDive(parsed) }
  } catch (e4) {
    console.log('Parse attempt 4 failed:', e4 instanceof Error ? e4.message : String(e4))
  }

  // パターン5: 最終手段 — 途中で壊れている場合、壊れた地点までで JSON を打ち切って
  // 閉じ括弧を補い、取れるフィールドだけでも救う。
  try {
    const salvaged = salvageTruncatedJson(cleaned)
    const parsed = JSON.parse(salvaged)
    console.log('Parse attempt 5 (salvage) succeeded')
    return { pain_point_id: painPointId, ...validateDeepDive(parsed) }
  } catch (e5) {
    console.log('Parse attempt 5 failed:', e5 instanceof Error ? e5.message : String(e5))
  }

  // 全て失敗 — 詳細なエラーログ
  console.error('All parse attempts failed. Response text:')
  console.error(text.substring(0, 1000))
  throw new Error(`Failed to parse Claude response. Preview: ${text.substring(0, 150)}`)
}

/**
 * JSON文字列の「値の中」に紛れ込んだ生の制御文字（改行・タブ等）をエスケープする。
 * 文字列の外（構造部分）の空白は触らない。
 */
function escapeControlCharsInStrings(json: string): string {
  let result = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]

    if (escaped) {
      result += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      result += ch
      escaped = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      result += ch
      continue
    }

    if (inString) {
      // 文字列の中の生の制御文字をエスケープ
      if (ch === '\n') { result += '\\n'; continue }
      if (ch === '\r') { result += '\\r'; continue }
      if (ch === '\t') { result += '\\t'; continue }
    }

    result += ch
  }

  return result
}

/**
 * 途中で切れた/壊れたJSONを、最後に成功していた地点まで巻き戻して閉じる。
 * 開いている配列・オブジェクトの数を数えて、閉じ括弧を補う。
 * 完璧ではないが、取れるフィールドだけでも救うための最終手段。
 */
function salvageTruncatedJson(json: string): string {
  // まず制御文字をエスケープしておく
  let s = escapeControlCharsInStrings(json)

  // 文字列が開きっぱなしなら閉じる
  let inString = false
  let escaped = false
  const stack: string[] = []
  let lastSafe = 0

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      stack.pop()
      // トップレベルまで閉じた安全な位置を記録
      if (stack.length >= 1) lastSafe = i + 1
    } else if (ch === ',' && stack.length === 1) {
      // オブジェクト直下のカンマ区切り = フィールド境界（安全に切れる位置）
      lastSafe = i
    }
  }

  // 安全な位置まで切り詰め
  if (lastSafe > 0) s = s.substring(0, lastSafe)

  // 開いている括弧を閉じる（残ったstackを逆順で閉じる）
  // ※切り詰めで stack を再計算
  inString = false
  escaped = false
  const stack2: string[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{' || ch === '[') stack2.push(ch)
    else if (ch === '}') stack2.pop()
    else if (ch === ']') stack2.pop()
  }
  // 末尾の余分なカンマを除去
  s = s.replace(/,\s*$/, '')
  while (stack2.length > 0) {
    const open = stack2.pop()
    s += open === '{' ? '}' : ']'
  }

  return s
}


/**
 * enum系フィールドを安全に正規化（想定外の値はフォールバック）
 */
function pickEnum<T extends string>(value: any, allowed: readonly T[], fallback: T): T {
  const v = String(value ?? '').toLowerCase().trim() as T
  return (allowed as readonly string[]).includes(v) ? v : fallback
}

/**
 * レスポンスのバリデーション（v4: 全フィールドにデフォルト値。
 * どんなに欠けた応答でも旧・新クライアントを壊さない）
 */
function validateDeepDive(data: any): Omit<DeepDiveResult, 'pain_point_id'> {
  return {
    verdict: {
      recommendation: pickEnum(data.verdict?.recommendation, ['build', 'investigate', 'skip'] as const, 'investigate'),
      one_line_pitch: String(data.verdict?.one_line_pitch || ''),
      confidence: pickEnum(data.verdict?.confidence, ['high', 'medium', 'low'] as const, 'low'),
      confidence_reason: String(data.verdict?.confidence_reason || ''),
    },
    root_causes: Array.isArray(data.root_causes)
      ? data.root_causes.slice(0, 5).map((rc: any) => ({
          cause: String(rc.cause || 'Unknown'),
          percentage: Number(rc.percentage) || 0,
          basis: pickEnum(rc.basis, ['evidence', 'hypothesis'] as const, 'hypothesis'),
          explanation: String(rc.explanation || ''),
        }))
      : [],
    evidence_quotes: Array.isArray(data.evidence_quotes)
      ? data.evidence_quotes.slice(0, 4).map(String)
      : [],
    market_opportunity: {
      size: String(data.market_opportunity?.size || 'Unknown'),
      reasoning: String(data.market_opportunity?.reasoning || ''),
      willingness_to_pay: String(data.market_opportunity?.willingness_to_pay || 'Unknown'),
    },
    market_gap: {
      why_unfixed: Array.isArray(data.market_gap?.why_unfixed)
        ? data.market_gap.why_unfixed.slice(0, 4).map((h: any) => ({
            hypothesis: String(h.hypothesis || ''),
            type: pickEnum(
              h.type,
              ['innovators_dilemma', 'business_model_conflict', 'tech_debt', 'enterprise_focus', 'platform_constraint', 'low_priority'] as const,
              'low_priority'
            ),
            solo_exploitable: Boolean(h.solo_exploitable),
            reasoning: String(h.reasoning || ''),
          }))
        : [],
      gap_type: pickEnum(data.market_gap?.gap_type, ['open', 'protected', 'contested'] as const, 'contested'),
      why_now: String(data.market_gap?.why_now || ''),
      differentiation_wedge: String(data.market_gap?.differentiation_wedge || ''),
    },
    competitors: Array.isArray(data.competitors)
      ? data.competitors.slice(0, 5).map((c: any) => ({
          name: String(c.name || 'Unknown'),
          weakness: String(c.weakness || ''),
        }))
      : [],
    competition_read: pickEnum(data.competition_read, ['validation', 'crowded', 'greenfield_risk'] as const, 'validation'),
    app_concept: {
      name: String(data.app_concept?.name || 'Untitled'),
      tagline: String(data.app_concept?.tagline || ''),
      description: String(data.app_concept?.description || ''),
      target_audience: String(data.app_concept?.target_audience || ''),
      monetization: String(data.app_concept?.monetization || ''),
      mvp_features: Array.isArray(data.app_concept?.mvp_features)
        ? data.app_concept.mvp_features.map(String).slice(0, 6)
        : [],
      build_estimate: String(data.app_concept?.build_estimate || ''),
      cut_list: Array.isArray(data.app_concept?.cut_list)
        ? data.app_concept.cut_list.map(String).slice(0, 5)
        : [],
    },
    willingness_to_pay: {
      signal: pickEnum(data.willingness_to_pay?.signal, ['strong', 'moderate', 'weak', 'unknown'] as const, 'unknown'),
      evidence: String(data.willingness_to_pay?.evidence || ''),
    },
    next_step: {
      cheapest_test: String(data.next_step?.cheapest_test || ''),
      kill_criteria: String(data.next_step?.kill_criteria || ''),
    },
    starter_prompt: String(data.starter_prompt || ''),
    summary: String(data.summary || ''),
  }
}


/**
 * Deep Dive 使用回数チェック
 * - 無料ユーザー: 1日3回まで
 * - Pro ユーザー: 無制限（limit = -1 のセンチネルを返す）
 */
export async function checkDeepDiveLimit(
  db: D1Database,
  userId: number
): Promise<{ allowed: boolean; used: number; limit: number; pro: boolean }> {
  const today = new Date().toISOString().split('T')[0]

  // その日の使用回数（Pro/無料どちらも参考として取得）
  const usage = await db.prepare(
    'SELECT count FROM deep_dive_usage WHERE user_id = ? AND usage_date = ?'
  ).bind(userId, today).first<{ count: number }>()
  const used = usage?.count || 0

  // Pro なら無制限
  const pro = await isUserPro(db, userId)
  if (pro) {
    return { allowed: true, used, limit: -1, pro: true }
  }

  // 無料は 1日3回
  const limit = 3
  return { allowed: used < limit, used, limit, pro: false }
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
