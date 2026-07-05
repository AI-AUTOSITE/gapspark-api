// Workers AI (Llama 3.2 1B) でペインポイントを抽出・要約
// v3: ルールベースseverity scoring + 改善プロンプト + 厳格な重複除去
//
// v2 → v3 改善点:
// 1. severity_score: AI任せ → 星評価・キーワード・頻度・新しさで計算
// 2. frequency: 「全ネガティブ数」→「この問題の該当レビュー数」
// 3. プロンプト: 「indie devがビルドできるアプリ」視点、具体的タイトル要求
// 4. アイデア: 「Implement a...」→「AppName — コンセプト. Target: ターゲット」
// 5. 重複除去: 閾値 0.5→0.4、サマリー類似チェック追加、品質フィルタ追加

interface AppWithReviews {
  app_id: number
  app_name: string
  category: string
  tags: string
}

interface NegativeReview {
  id: number
  title: string
  body: string
  rating: number
  sentiment_score: number
  review_date: string | null
}

interface ExtractedPainPoint {
  title: string
  summary: string
  keywords: string[]
  related_topics: string[]
  severity: string
  ai_generated_idea: string
}

interface ScoredPainPoint extends ExtractedPainPoint {
  ruleBasedScore: number
  reviewCount: number
  matchingReviewCount: number  // 純粋なキーワード一致レビュー数（足切り判定用）
}

interface ExistingPainPoint {
  id: number
  title: string
  summary: string
  keywords: string
}

// ========================================
// キーワード辞書（ルールベースscoring用）
// ========================================

const CRITICAL_KEYWORDS = new Set([
  'crash', 'crashes', 'crashing', 'data loss', 'lost data', 'deleted',
  'broken', 'unusable', 'unresponsive', 'freeze', 'freezes', 'frozen',
  'security', 'hacked', 'breach', 'vulnerability', 'corrupt', 'corrupted'
])

const HIGH_KEYWORDS = new Set([
  'bug', 'bugs', 'glitch', 'error', 'fail', 'fails', 'failed', 'failure',
  'slow', 'laggy', 'lag', 'loading', 'timeout', 'stuck', 'hang',
  'missing', 'disappeared', 'gone', 'removed',
  'sync', 'syncing', 'offline', 'disconnect', 'connection'
])

const MEDIUM_KEYWORDS = new Set([
  'annoying', 'frustrating', 'confusing', 'complicated', 'hard to use',
  'ugly', 'clunky', 'unintuitive', 'poor', 'bad', 'terrible', 'awful',
  'update', 'downgrade', 'worse', 'ruined'
])

const WISHLIST_KEYWORDS = new Set([
  'wish', 'please', 'would be nice', 'hope', 'suggest', 'suggestion',
  'feature request', 'option', 'ability', 'support'
])

// ========================================
// メイン: ペインポイント生成パイプライン
// ========================================

export async function generatePainPoints(
  db: D1Database,
  ai: Ai,
  appsPerRun: number = 10
): Promise<{
  appsProcessed: number
  painPointsCreated: number
  duplicatesSkipped: number
  errors: number
}> {
  let appsProcessed = 0
  let painPointsCreated = 0
  let duplicatesSkipped = 0
  let errors = 0

  const apps = await db.prepare(`
    SELECT 
      ta.id as app_id, ta.app_name, ta.category, ta.tags,
      COUNT(r.id) as negative_count,
      (
        SELECT COUNT(*) FROM pain_points pp
        WHERE EXISTS (
          SELECT 1 FROM json_each(pp.sample_app_ids)
          WHERE json_each.value = ta.id
        )
      ) as existing_pain_points
    FROM tracked_apps ta
    JOIN reviews r ON r.tracked_app_id = ta.id
    WHERE r.sentiment_label = 'NEGATIVE' AND r.sentiment_score IS NOT NULL
    GROUP BY ta.id
    HAVING negative_count >= 5
    ORDER BY existing_pain_points ASC, negative_count DESC
    LIMIT ?
  `).bind(appsPerRun).all<AppWithReviews & { negative_count: number }>()

  if (!apps.results || apps.results.length === 0) {
    console.log('No apps with enough negative reviews')
    return { appsProcessed: 0, painPointsCreated: 0, duplicatesSkipped: 0, errors: 0 }
  }

  // 全既存ペインポイント（クロスアプリ重複チェック用）
  const allExisting = await db.prepare(
    'SELECT id, title, summary, keywords FROM pain_points'
  ).all<ExistingPainPoint>()
  const globalTitles = allExisting.results?.map(p => p.title) || []
  const globalSummaries = allExisting.results?.map(p => p.summary) || []

  console.log(`Generating pain points for ${apps.results.length} apps (${globalTitles.length} existing)...`)

  for (const app of apps.results) {
    try {
      console.log(`  Processing: ${app.app_name} (${app.negative_count} negative reviews)`)

      // このアプリの既存ペインポイント
      const existing = await db.prepare(`
        SELECT id, title, summary, keywords FROM pain_points
        WHERE EXISTS (
          SELECT 1 FROM json_each(sample_app_ids) WHERE json_each.value = ?
        )
      `).bind(app.app_id).all<ExistingPainPoint>()
      const existingTitles = existing.results?.map(p => p.title) || []

      // ネガティブレビュー取得（review_date も取得 — recencyスコア用）
      const reviews = await db.prepare(`
        SELECT id, title, body, rating, sentiment_score, review_date
        FROM reviews
        WHERE tracked_app_id = ?
          AND sentiment_label = 'NEGATIVE'
          AND sentiment_score IS NOT NULL
        ORDER BY sentiment_score ASC
        LIMIT 30
      `).bind(app.app_id).all<NegativeReview>()

      if (!reviews.results || reviews.results.length < 5) {
        console.log(`    Skipping: not enough negative reviews`)
        continue
      }

      const REVIEW_BATCH_SIZE = 5
      const allPainPoints: ScoredPainPoint[] = []

      for (let i = 0; i < reviews.results.length; i += REVIEW_BATCH_SIZE) {
        const batch = reviews.results.slice(i, i + REVIEW_BATCH_SIZE)
        
        const reviewText = batch.map(r => 
          `[${r.rating}★] ${r.title}: ${r.body.substring(0, 200)}`
        ).join('\n')

        const allKnownTitles = [...existingTitles, ...allPainPoints.map(p => p.title)]

        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const painPoints = await extractPainPointsWithLlama(ai, app, reviewText, allKnownTitles)
            // ルールベーススコアリング適用
            const scored = painPoints.map(pp => 
              applyRuleBasedScoring(pp, batch, reviews.results)
            )
            allPainPoints.push(...scored)
            break
          } catch (e) {
            console.error(`    Llama error (attempt ${attempt}):`, e)
            if (attempt < 2) await new Promise(r => setTimeout(r, 5000))
            else errors++
          }
        }

        await new Promise(r => setTimeout(r, 3000))
      }

      // 重複除去（ローカル + グローバル）
      const unique = deduplicatePainPoints(allPainPoints, globalTitles, globalSummaries)
      duplicatesSkipped += allPainPoints.length - unique.length

      if (allPainPoints.length > unique.length) {
        console.log(`    Dedup: ${allPainPoints.length} → ${unique.length}`)
      }

      // 品質フィルタ
      const quality = unique.filter(pp => {
        if (pp.title.length < 10 || pp.title.length > 80) return false
        if (pp.summary.length < 30) return false
        const vague = ['not working', 'does not work', 'app issues', 'general issues', 'various issues', 'account issues']
        if (vague.some(v => pp.title.toLowerCase() === v)) return false
        return true
      })

      if (quality.length < unique.length) {
        console.log(`    Quality filter: ${unique.length} → ${quality.length}`)
      }

      // 信号強度フィルタ: キーワードが2件未満のレビューにしか出ない
      // ペインポイントは「ノイズ（1人だけの複合的な不満）」とみなして捨てる。
      // これで Discover に "1件由来の弱いペインポイント" が残らなくなる。
      const MIN_SUPPORTING_REVIEWS = 2
      const wellSupported = quality.filter(pp => pp.matchingReviewCount >= MIN_SUPPORTING_REVIEWS)

      if (wellSupported.length < quality.length) {
        console.log(`    Signal filter: ${quality.length} → ${wellSupported.length} (dropped weakly-supported <${MIN_SUPPORTING_REVIEWS} reviews)`)
      }

      if (wellSupported.length > 0) {
        const saved = await savePainPoints(db, app, wellSupported)
        painPointsCreated += saved
        wellSupported.forEach(pp => {
          globalTitles.push(pp.title)
          globalSummaries.push(pp.summary)
        })
        console.log(`    Created ${saved} pain points for ${app.app_name}`)
      }

      appsProcessed++
      await new Promise(r => setTimeout(r, 5000))

    } catch (e) {
      console.error(`  Error processing ${app.app_name}:`, e)
      errors++
    }
  }

  console.log(`Complete: ${appsProcessed} apps, ${painPointsCreated} created, ${duplicatesSkipped} dupes, ${errors} errors`)
  return { appsProcessed, painPointsCreated, duplicatesSkipped, errors }
}


// ========================================
// ルールベース severity スコアリング
// ========================================

/**
 * severity_score = starPenalty × keywordSeverity × frequencyWeight × recencyBoost
 * 
 * starPenalty:     1★→1.0, 2★→0.8, 3★→0.6, 4★→0.4, 5★→0.2
 * keywordSeverity: critical→1.0, high→0.7, medium→0.5, wishlist→0.3, other→0.4
 * frequencyWeight: log(1 + 該当レビュー数) / log(1 + 全レビュー数)
 * recencyBoost:    30日以内→1.2, 90日以内→1.0, それ以前→0.8
 */
function applyRuleBasedScoring(
  pp: ExtractedPainPoint,
  batchReviews: NegativeReview[],
  allReviews: NegativeReview[]
): ScoredPainPoint {
  // 1. Star Penalty
  const avgRating = batchReviews.reduce((sum, r) => sum + r.rating, 0) / batchReviews.length
  const starPenalty = (6 - avgRating) / 5

  // 2. Keyword Severity
  const allText = `${pp.title} ${pp.summary} ${pp.keywords.join(' ')}`.toLowerCase()
  let keywordSeverity = 0.4
  if ([...CRITICAL_KEYWORDS].some(k => allText.includes(k))) keywordSeverity = 1.0
  else if ([...HIGH_KEYWORDS].some(k => allText.includes(k))) keywordSeverity = 0.7
  else if ([...MEDIUM_KEYWORDS].some(k => allText.includes(k))) keywordSeverity = 0.5
  else if ([...WISHLIST_KEYWORDS].some(k => allText.includes(k))) keywordSeverity = 0.3

  // 3. Frequency（キーワードが全レビュー中で何件に出現するか）
  const ppKeywords = pp.keywords.map(k => k.toLowerCase())
  const matchingReviews = allReviews.filter(r => {
    const text = `${r.title} ${r.body}`.toLowerCase()
    return ppKeywords.some(k => text.includes(k))
  })
  const matchingReviewCount = matchingReviews.length  // 純粋な一致数（足切り用）
  const reviewCount = Math.max(matchingReviews.length, batchReviews.length)
  const frequencyWeight = Math.log(1 + reviewCount) / Math.log(1 + allReviews.length)

  // 4. Recency Boost
  let recencyBoost = 1.0
  const newestDate = batchReviews
    .map(r => r.review_date)
    .filter(Boolean)
    .sort()
    .reverse()[0]
  
  if (newestDate) {
    const daysSince = (Date.now() - new Date(newestDate).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince <= 30) recencyBoost = 1.2
    else if (daysSince <= 90) recencyBoost = 1.0
    else recencyBoost = 0.8
  }

  // 最終スコア（0.05 ~ 1.0 にクランプ、小数2桁）
  const rawScore = starPenalty * keywordSeverity * frequencyWeight * recencyBoost
  const ruleBasedScore = Math.round(Math.min(1.0, Math.max(0.05, rawScore)) * 100) / 100

  return { ...pp, ruleBasedScore, reviewCount, matchingReviewCount }
}


// ========================================
// 改善プロンプト
// ========================================

async function extractPainPointsWithLlama(
  ai: Ai,
  app: AppWithReviews,
  reviewText: string,
  existingTitles: string[] = []
): Promise<ExtractedPainPoint[]> {
  const existingInstruction = existingTitles.length > 0
    ? `\nALREADY KNOWN (do NOT repeat):\n${existingTitles.slice(0, 10).map(t => `- ${t}`).join('\n')}\n`
    : ''

  const prompt = `Analyze negative reviews for "${app.app_name}" (${app.category}).
${existingInstruction}
Reviews:
${reviewText}

Extract 1-2 SPECIFIC pain points. For each, suggest a NEW standalone app idea an indie developer could build.

JSON array only:
[
  {
    "title": "Specific problem in 5-10 words (BAD: 'App crashes' / GOOD: 'App crashes when opening PDF attachments')",
    "summary": "2-3 sentences: What exactly frustrates users? How does it affect their workflow? Be specific about the trigger and impact.",
    "keywords": ["specific", "complaint", "terms", "from", "reviews"],
    "related_topics": ["topic1", "topic2"],
    "severity": "critical|high|medium|low",
    "ai_generated_idea": "AppName — A one-sentence app concept that solves this problem as a new product. Target: who would pay for it."
  }
]

Rules:
- critical=crash/data loss, high=feature broken, medium=UX frustration, low=feature wish
- Title MUST name the specific trigger or context (not just 'crashes' but 'crashes when...')
- ai_generated_idea must be a NEW app name + concept, not 'fix ${app.app_name}'
- related_topics: 2-3 lowercase topical tags describing the theme, like "sync", "offline", "notifications", "search" (NOT meta-labels like "feature_category" or "use_case")
- JSON only. No markdown, no explanation.`

  const result = await ai.run('@cf/meta/llama-3.2-1b-instruct', {
    prompt,
    max_tokens: 600,
    temperature: 0.3,
  }) as { response: string }

  return parseLlamaResponse(result.response)
}


// ========================================
// 重複除去（v3: 強化版）
// ========================================

function deduplicatePainPoints(
  newPoints: ScoredPainPoint[],
  globalTitles: string[],
  globalSummaries: string[]
): ScoredPainPoint[] {
  const unique: ScoredPainPoint[] = []
  const titleSets = globalTitles.map(t => extractWords(t))
  const summarySets = globalSummaries.map(s => extractWords(s))

  for (const point of newPoints) {
    const ptTitle = extractWords(point.title)
    const ptSummary = extractWords(point.summary)
    
    // タイトル重複（閾値0.4）
    if (titleSets.some(e => wordOverlapRatio(ptTitle, e) >= 0.4)) continue
    // サマリー重複（閾値0.5）
    if (summarySets.some(e => wordOverlapRatio(ptSummary, e) >= 0.5)) continue
    // バッチ内重複
    if (unique.some(u => 
      wordOverlapRatio(ptTitle, extractWords(u.title)) >= 0.4 ||
      wordOverlapRatio(ptSummary, extractWords(u.summary)) >= 0.5
    )) continue

    unique.push(point)
    titleSets.push(ptTitle)
    summarySets.push(ptSummary)
  }

  return unique
}


// ========================================
// ユーティリティ
// ========================================

function extractWords(text: string): Set<string> {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'shall',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'they', 'their',
    'it', 'its', 'this', 'that', 'these', 'those',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
    'and', 'or', 'but', 'not', 'no', 'nor',
    'too', 'very', 'just', 'about', 'so', 'up', 'out',
    'stop', 'need', 'want', 'app', 'fix', 'please', 'users',
    'when', 'after', 'before', 'while', 'because', 'since',
    'also', 'even', 'still', 'already', 'using', 'able', 'unable'
  ])
  
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
  )
}

function wordOverlapRatio(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0
  let overlap = 0
  for (const word of setA) { if (setB.has(word)) overlap++ }
  return overlap / Math.min(setA.size, setB.size)
}

function parseLlamaResponse(response: string): ExtractedPainPoint[] {
  try {
    const parsed = JSON.parse(response.trim())
    if (Array.isArray(parsed)) return validatePainPoints(parsed)
    if (parsed.title) return validatePainPoints([parsed])
  } catch {}

  try {
    const match = response.match(/\[[\s\S]*\]/)
    if (match) {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed)) return validatePainPoints(parsed)
    }
  } catch {}

  try {
    const match = response.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0])
      if (parsed.title) return validatePainPoints([parsed])
    }
  } catch {}

  console.error('  Failed to parse Llama response:', response.substring(0, 200))
  return []
}

// related_topics に紛れ込むメタラベル（トピックじゃない語）。パース時に除去する保険。
const RELATED_TOPIC_DENYLIST = new Set([
  'feature_category', 'use_case', 'usecase', 'topic1', 'topic2',
  'category', 'feature', 'topic', 'tag', 'tags', 'theme', 'area', 'type',
])

function validatePainPoints(points: any[]): ExtractedPainPoint[] {
  return points
    .filter(p => p && typeof p.title === 'string' && typeof p.summary === 'string')
    .map(p => ({
      title: String(p.title).substring(0, 100),
      summary: String(p.summary).substring(0, 500),
      keywords: Array.isArray(p.keywords) ? p.keywords.map(String).slice(0, 10) : [],
      related_topics: Array.isArray(p.related_topics)
        ? p.related_topics
            .map((t: any) => String(t).toLowerCase().trim())
            // メタラベル・空・短すぎる語を除去（プロンプト修正の保険）
            .filter((t: string) => t.length >= 2 && !RELATED_TOPIC_DENYLIST.has(t))
            .slice(0, 5)
        : [],
      severity: ['critical', 'high', 'medium', 'low'].includes(p.severity) ? p.severity : 'medium',
      ai_generated_idea: typeof p.ai_generated_idea === 'string' 
        ? p.ai_generated_idea.substring(0, 300) : ''
    }))
}

// ========================================
// 案B: 信号強度（Signal Strength）
// ========================================
//
// バッジ用の「信号の強さ」を計算する。
// v2設計変更: 当初は「15件中◯件」(上限15)だったが、アプリのネガレビューは数百件あり
//   話題語でもすぐ15件に達して 86% が 15/15 に飽和した（＝強弱を見分けられない）。
//   → 上限を撤廃し「実数マグニチュード」に変更:
//
//   mention_count: 対象アプリのネガレビュー中、検索語のいずれかを含む実件数（上限なし。例 8, 34, 127）
//   sample_size:   対象アプリのネガレビュー総数（上限なし）= 母集団
//                  → 割合 mention_count / sample_size = 「そのアプリの不満のうち何%がこの問題か」
//   両方 0 のとき = 計算不能（検索語なし / アプリ紐付けなし）→ UI はバッジ非表示にできる
//
// UI（Stage 3）は実数 or 割合を強度バー(Low/Mid/High)等で表示する。
//
// ※ 生成時（savePainPoints）とバックフィル（backfillMentionSignal）の両方が
//   この computeSignal を呼ぶので、値が食い違わない（1つの真実）。

// 汎用語リスト（ほぼ全ネガレビューに出る語）。信号カウントから除外する。
// 例: "app" はほとんどのレビューにヒットするので、含めると mention_count が15に張り付き、
//     バッジが信号の強弱を見分けられなくなる。意味のある（そのペイン固有の）語だけで数える。
// 複数語キーワード（"won't open" 等）は単語トークンと一致しないので除外されない＝残る（良い）。
const GENERIC_TERMS = new Set([
  // プラットフォーム・アプリそのもの
  'app', 'apps', 'application', 'applications',
  'ios', 'android', 'iphone', 'iphones', 'ipad', 'ipads',
  'phone', 'phones', 'device', 'devices', 'mobile', 'tablet',
  // バージョン・アップデート系
  'version', 'versions', 'update', 'updates', 'updated', 'upgrade', 'upgrades',
  // 超汎用の不満フィラー
  'work', 'works', 'working', 'worked', 'use', 'used', 'uses', 'using',
  'please', 'fix', 'fixed', 'fixes', 'get', 'gets', 'getting', 'got',
  'thing', 'things', 'time', 'times', 'way', 'ways',
  'want', 'wants', 'need', 'needs', 'make', 'makes', 'made',
  'really', 'even', 'back', 'still', 'since', 'every', 'always', 'never',
  'this', 'that', 'with', 'from', 'have', 'just', 'they', 'your', 'when', 'what',
])

// deep-dive.ts の Stage 1 と同じ検索語の作り方（＋汎用語の除外）：
// keywords（小文字化）+ タイトルから抽出した4文字以上の語 を重複除去。
// そこから汎用語(GENERIC_TERMS)を除いて、最大6語。
// ※ Deep Dive 側の照合ロジックも後で同じ除外に揃える（バッジと Deep Dive の一致を保つため）。
function deriveSearchTerms(keywords: string[], title: string): string[] {
  const titleTerms = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4)

  const all = Array.from(
    new Set([
      // 2文字以下のキーワード("ad"→"bad","read"等に誤爆)は substring 一致で飽和するので除外
      ...keywords.map(k => k.toLowerCase()).filter(k => k.length >= 3),
      ...titleTerms,
    ])
  )

  // 汎用語を除外して「そのペイン固有の語」だけにする
  const distinctive = all.filter(t => !GENERIC_TERMS.has(t))

  // まれに全部除外される（汎用語だけのペイン）→ 0件表示を避けるため元の語にフォールバック
  const terms = distinctive.length > 0 ? distinctive : all
  return terms.slice(0, 6)
}

// 信号強度を計算（DBクエリ。対象アプリの全ネガレビューを見るので生成/バックフィルで一致）
async function computeSignal(
  db: D1Database,
  appIds: number[],
  keywords: string[],
  title: string
): Promise<{ mentionCount: number; sampleSize: number }> {
  const searchTerms = deriveSearchTerms(keywords, title)
  if (searchTerms.length === 0 || appIds.length === 0) {
    return { mentionCount: 0, sampleSize: 0 }
  }

  const placeholders = appIds.map(() => '?').join(',')
  const likeClauses = searchTerms
    .map(() => '(LOWER(r.title) LIKE ? OR LOWER(r.body) LIKE ?)')
    .join(' OR ')
  const likeParams = searchTerms.flatMap(t => {
    const kw = `%${t.toLowerCase()}%`
    return [kw, kw]
  })

  // 言及件数（検索語のいずれかにマッチ = OR）
  const mentionRow = await db.prepare(`
    SELECT COUNT(*) as cnt FROM reviews r
    WHERE r.tracked_app_id IN (${placeholders})
      AND r.sentiment_label = 'NEGATIVE'
      AND (${likeClauses})
  `).bind(...appIds, ...likeParams).first<{ cnt: number }>()

  // 母数（対象アプリのネガレビュー総数）
  const totalRow = await db.prepare(`
    SELECT COUNT(*) as cnt FROM reviews r
    WHERE r.tracked_app_id IN (${placeholders})
      AND r.sentiment_label = 'NEGATIVE'
  `).bind(...appIds).first<{ cnt: number }>()

  return {
    mentionCount: mentionRow?.cnt || 0,   // 上限なし（実一致数）
    sampleSize: totalRow?.cnt || 0,        // 上限なし（アプリの総ネガ数 = 母集団）
  }
}

async function savePainPoints(
  db: D1Database,
  app: AppWithReviews & { negative_count?: number },
  painPoints: ScoredPainPoint[]
): Promise<number> {
  const insertStmt = db.prepare(`
    INSERT INTO pain_points 
    (category, title, summary, severity_score, frequency, sample_app_ids, keywords, related_topics, ai_generated_idea, mention_count, sample_size, ai_model_used, last_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'workers-ai-llama-3.2-1b', datetime('now'))
  `)

  const appIds = [app.app_id]

  // 各ペインの信号強度を先に計算（Deep Dive と同じ照合ロジック）してから INSERT
  const batch: D1PreparedStatement[] = []
  for (const pp of painPoints) {
    const signal = await computeSignal(db, appIds, pp.keywords, pp.title)
    batch.push(
      insertStmt.bind(
        app.category,
        pp.title,
        pp.summary,
        pp.ruleBasedScore,    // ← ルールベーススコア
        pp.reviewCount,        // ← 実際の該当レビュー数（severity用・従来通り）
        JSON.stringify(appIds),
        JSON.stringify(pp.keywords),
        JSON.stringify(pp.related_topics),
        pp.ai_generated_idea,
        signal.mentionCount,   // ← 案B: 言及件数
        signal.sampleSize      // ← 案B: 母数
      )
    )
  }

  try {
    const results = await db.batch(batch)
    return results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0)
  } catch (e) {
    console.error(`  DB insert error for ${app.app_name}:`, e)
    return 0
  }
}


// ========================================
// 既存データのメンテナンス用
// ========================================

/**
 * 既存ペインポイントの重複クリーンアップ（v3: サマリー類似もチェック）
 */
export async function deduplicateExistingPainPoints(
  db: D1Database
): Promise<{ total: number; removed: number; remaining: number }> {
  const all = await db.prepare(
    'SELECT id, title, summary, sample_app_ids FROM pain_points ORDER BY id ASC'
  ).all<{ id: number; title: string; summary: string; sample_app_ids: string }>()

  if (!all.results || all.results.length === 0) {
    return { total: 0, removed: 0, remaining: 0 }
  }

  const total = all.results.length
  const idsToDelete: number[] = []
  const kept: { id: number; title: string; summary: string; appIds: string }[] = []

  for (const pp of all.results) {
    const ptTitle = extractWords(pp.title)
    const ptSummary = extractWords(pp.summary)
    
    const isDuplicate = kept.some(k => {
      const titleDup = wordOverlapRatio(ptTitle, extractWords(k.title)) >= 0.4
      const summaryDup = wordOverlapRatio(ptSummary, extractWords(k.summary)) >= 0.5
      
      if (k.appIds === pp.sample_app_ids) return titleDup || summaryDup   // 同アプリ
      return titleDup && summaryDup                                        // 別アプリ
    })

    if (isDuplicate) {
      idsToDelete.push(pp.id)
    } else {
      kept.push({ id: pp.id, title: pp.title, summary: pp.summary, appIds: pp.sample_app_ids })
    }
  }

  if (idsToDelete.length > 0) {
    console.log(`Removing ${idsToDelete.length} duplicate pain points...`)
    for (let i = 0; i < idsToDelete.length; i += 50) {
      const batchIds = idsToDelete.slice(i, i + 50)
      const placeholders = batchIds.map(() => '?').join(',')
      await db.prepare(
        `DELETE FROM pain_points WHERE id IN (${placeholders})`
      ).bind(...batchIds).run()
    }
  }

  const remaining = total - idsToDelete.length
  console.log(`Dedup: ${total} → ${remaining} (${idsToDelete.length} removed)`)
  return { total, removed: idsToDelete.length, remaining }
}


/**
 * 既存ペインポイントの「弱信号」クリーンアップ。
 * キーワードが2件未満のネガティブレビューにしか出現しないペインポイントを削除する。
 * （新しい生成ロジックの足切りと同じ基準を、過去データにも適用する用）
 *
 * dryRun=true の場合は削除せず、削除対象の件数だけ返す（安全確認用）。
 */
export async function cleanupWeaklySupportedPainPoints(
  db: D1Database,
  dryRun: boolean = true,
  minSupportingReviews: number = 2
): Promise<{ total: number; weaklySupported: number; deleted: number; dryRun: boolean }> {
  const all = await db.prepare(
    'SELECT id, title, keywords, sample_app_ids FROM pain_points'
  ).all<{ id: number; title: string; keywords: string; sample_app_ids: string }>()

  if (!all.results || all.results.length === 0) {
    return { total: 0, weaklySupported: 0, deleted: 0, dryRun }
  }

  const total = all.results.length
  const idsToDelete: number[] = []

  for (const pp of all.results) {
    try {
      const keywords = JSON.parse(pp.keywords || '[]') as string[]
      const appIds = JSON.parse(pp.sample_app_ids || '[]') as number[]

      // キーワードが無い / アプリ紐付けが無いものは判定不能 → 残す（安全側）
      if (keywords.length === 0 || appIds.length === 0) continue

      // このペインのキーワードが何件のネガティブレビューに出るか数える
      // （いずれかのキーワードにマッチ = OR 条件）
      const likeClauses = keywords.slice(0, 6).map(() => '(LOWER(r.title) LIKE ? OR LOWER(r.body) LIKE ?)').join(' OR ')
      const likeParams = keywords.slice(0, 6).flatMap(k => {
        const kw = `%${k.toLowerCase()}%`
        return [kw, kw]
      })
      const placeholders = appIds.map(() => '?').join(',')

      const countRow = await db.prepare(`
        SELECT COUNT(*) as cnt
        FROM reviews r
        WHERE r.tracked_app_id IN (${placeholders})
          AND r.sentiment_label = 'NEGATIVE'
          AND (${likeClauses})
      `).bind(...appIds, ...likeParams).first<{ cnt: number }>()

      const supporting = countRow?.cnt || 0
      if (supporting < minSupportingReviews) {
        idsToDelete.push(pp.id)
      }
    } catch (e) {
      console.error(`  Error checking PP ${pp.id}:`, e)
      // エラー時は残す（安全側）
    }
  }

  const weaklySupported = idsToDelete.length

  if (!dryRun && idsToDelete.length > 0) {
    console.log(`Deleting ${idsToDelete.length} weakly-supported pain points...`)
    for (let i = 0; i < idsToDelete.length; i += 50) {
      const batchIds = idsToDelete.slice(i, i + 50)
      const ph = batchIds.map(() => '?').join(',')
      await db.prepare(`DELETE FROM pain_points WHERE id IN (${ph})`).bind(...batchIds).run()
    }
  }

  const deleted = dryRun ? 0 : weaklySupported
  console.log(`Weak-signal cleanup: total=${total}, weak=${weaklySupported}, deleted=${deleted}, dryRun=${dryRun}`)
  return { total, weaklySupported, deleted, dryRun }
}


/**
 * 既存ペインポイントのseverity_scoreをルールベースで再計算
 */
export async function recalculateSeverityScores(
  db: D1Database
): Promise<{ updated: number; errors: number }> {
  let updated = 0
  let errors = 0

  const painPoints = await db.prepare(
    'SELECT id, title, summary, keywords, sample_app_ids FROM pain_points'
  ).all<{ id: number; title: string; summary: string; keywords: string; sample_app_ids: string }>()

  if (!painPoints.results) return { updated: 0, errors: 0 }

  const updateStmt = db.prepare(
    'UPDATE pain_points SET severity_score = ?, frequency = ? WHERE id = ?'
  )
  let batchUpdates: D1PreparedStatement[] = []

  for (const pp of painPoints.results) {
    try {
      const keywords = JSON.parse(pp.keywords || '[]') as string[]
      const appIds = JSON.parse(pp.sample_app_ids || '[]') as number[]

      // Keyword Severity
      const fullText = `${pp.title} ${pp.summary} ${keywords.join(' ')}`.toLowerCase()
      let keywordSeverity = 0.4
      if ([...CRITICAL_KEYWORDS].some(k => fullText.includes(k))) keywordSeverity = 1.0
      else if ([...HIGH_KEYWORDS].some(k => fullText.includes(k))) keywordSeverity = 0.7
      else if ([...MEDIUM_KEYWORDS].some(k => fullText.includes(k))) keywordSeverity = 0.5
      else if ([...WISHLIST_KEYWORDS].some(k => fullText.includes(k))) keywordSeverity = 0.3

      // Review count（キーワードで検索）
      let reviewCount = 1
      if (keywords.length > 0 && appIds.length > 0) {
        const keyword = keywords[0]
        const placeholders = appIds.map(() => '?').join(',')
        const countResult = await db.prepare(`
          SELECT COUNT(*) as cnt FROM reviews
          WHERE tracked_app_id IN (${placeholders})
            AND sentiment_label = 'NEGATIVE'
            AND (LOWER(title) LIKE ? OR LOWER(body) LIKE ?)
        `).bind(...appIds, `%${keyword.toLowerCase()}%`, `%${keyword.toLowerCase()}%`).first<{ cnt: number }>()
        reviewCount = countResult?.cnt || 1
      }

      // Total negatives for this app
      let totalNegatives = 1
      if (appIds.length > 0) {
        const placeholders = appIds.map(() => '?').join(',')
        const total = await db.prepare(`
          SELECT COUNT(*) as cnt FROM reviews 
          WHERE tracked_app_id IN (${placeholders}) AND sentiment_label = 'NEGATIVE'
        `).bind(...appIds).first<{ cnt: number }>()
        totalNegatives = total?.cnt || 1
      }

      // Score calculation
      const starPenalty = 0.8  // ネガティブレビューの平均は約2★
      const frequencyWeight = Math.log(1 + reviewCount) / Math.log(1 + totalNegatives)
      const rawScore = starPenalty * keywordSeverity * frequencyWeight
      const finalScore = Math.round(Math.min(1.0, Math.max(0.05, rawScore)) * 100) / 100

      batchUpdates.push(updateStmt.bind(finalScore, reviewCount, pp.id))

      if (batchUpdates.length >= 50) {
        await db.batch(batchUpdates)
        updated += batchUpdates.length
        batchUpdates = []
      }
    } catch (e) {
      console.error(`  Error recalculating PP ${pp.id}:`, e)
      errors++
    }
  }

  if (batchUpdates.length > 0) {
    await db.batch(batchUpdates)
    updated += batchUpdates.length
  }

  console.log(`Severity recalculation: ${updated} updated, ${errors} errors`)
  return { updated, errors }
}


/**
 * 案B: 既存ペインポイントに mention_count / sample_size を一括計算して埋める。
 * migration 0005 適用直後に一度だけ実行すればよい（新規生成分は savePainPoints が自動で埋める）。
 * 生成時と同じ computeSignal を使うので値が一致する。
 *
 * ★分割実行★
 * 全ペインを1リクエストで処理すると、1件あたり2回のD1クエリ×数百件 = 数百〜千回の
 * 逐次サブリクエストになり、Cloudflare Worker の上限（無料枠 50 サブリクエスト）や
 * 実行時間を超えて返ってこなくなる。そこで 1回 CHUNK 件ずつ処理し、次の offset を返す。
 * 呼び出し側は done=true になるまで offset を進めて繰り返し叩く（Python ループで自動化）。
 */
export async function backfillMentionSignal(
  db: D1Database,
  offset: number = 0
): Promise<{
  total: number
  offset: number
  processed: number
  updated: number
  errors: number
  done: boolean
  next_offset: number
}> {
  // 1リクエストで処理する件数。2クエリ/件なので 20×2=40 + 数回 で無料枠50に収まる。
  const CHUNK = 20

  const totalRow = await db.prepare(
    'SELECT COUNT(*) as cnt FROM pain_points'
  ).first<{ cnt: number }>()
  const total = totalRow?.cnt || 0

  // このチャンク分のペインだけ取得（id 昇順で安定ページング）
  const painPoints = await db.prepare(
    'SELECT id, title, keywords, sample_app_ids FROM pain_points ORDER BY id LIMIT ? OFFSET ?'
  ).bind(CHUNK, offset).all<{ id: number; title: string; keywords: string; sample_app_ids: string }>()

  const rows = painPoints.results || []
  let errors = 0
  const updateStmt = db.prepare(
    'UPDATE pain_points SET mention_count = ?, sample_size = ? WHERE id = ?'
  )
  const batchUpdates: D1PreparedStatement[] = []

  for (const pp of rows) {
    try {
      const keywords = JSON.parse(pp.keywords || '[]') as string[]
      const appIds = JSON.parse(pp.sample_app_ids || '[]') as number[]
      const signal = await computeSignal(db, appIds, keywords, pp.title)
      batchUpdates.push(updateStmt.bind(signal.mentionCount, signal.sampleSize, pp.id))
    } catch (e) {
      console.error(`  Error backfilling signal for PP ${pp.id}:`, e)
      errors++
    }
  }

  let updated = 0
  if (batchUpdates.length > 0) {
    await db.batch(batchUpdates)
    updated = batchUpdates.length
  }

  const processed = rows.length
  const next_offset = offset + processed
  const done = next_offset >= total || processed === 0

  console.log(`Signal backfill chunk: offset=${offset}, processed=${processed}, updated=${updated}, errors=${errors}, total=${total}, done=${done}`)
  return { total, offset, processed, updated, errors, done, next_offset }
}


/**
 * 既存ペインポイントの related_topics を keywords から作り直す（一度きり）。
 * プロンプト修正は新規ペインにしか効かないので、過去分の "feature_category" 等の
 * メタラベルをトピック語に置き換える。Llama 不使用（keywordsから導出）＝neuron 消費ゼロ。
 * ペイン数は数百程度なので1リクエストで完結（チャンク不要）。
 */
export async function backfillRelatedTopics(
  db: D1Database
): Promise<{ total: number; updated: number }> {
  const rows = await db
    .prepare('SELECT id, title, keywords FROM pain_points')
    .all<{ id: number; title: string; keywords: string }>()

  if (!rows.results || rows.results.length === 0) {
    return { total: 0, updated: 0 }
  }

  const total = rows.results.length
  const updateStmt = db.prepare('UPDATE pain_points SET related_topics = ? WHERE id = ?')
  let batch: D1PreparedStatement[] = []
  let updated = 0

  for (const pp of rows.results) {
    try {
      const keywords = JSON.parse(pp.keywords || '[]') as string[]
      // keywords から汎用語(GENERIC_TERMS)・メタラベルを除いたトピック語を上位4件
      const topics = deriveSearchTerms(keywords, pp.title)
        .filter((t) => !RELATED_TOPIC_DENYLIST.has(t))
        .slice(0, 4)
      batch.push(updateStmt.bind(JSON.stringify(topics), pp.id))

      if (batch.length >= 50) {
        await db.batch(batch)
        updated += batch.length
        batch = []
      }
    } catch (e) {
      console.error(`  related_topics backfill error for PP ${pp.id}:`, e)
    }
  }

  if (batch.length > 0) {
    await db.batch(batch)
    updated += batch.length
  }

  console.log(`Related topics backfill: total=${total} updated=${updated}`)
  return { total, updated }
}


// ai_generated_idea の先頭（"AppName — concept" の AppName 部分）を取り出す。
// iOS の extractAppName と同じロジック。取れなければ null。
function extractAppNameFromIdea(idea: string): string | null {
  for (const sep of ['—', ' – ', ' - ', ':']) {
    const idx = idea.indexOf(sep)
    if (idx > 0) {
      const name = idea.slice(0, idx).trim()
      if (name.length >= 2 && name.length <= 40) return name
    }
  }
  return null
}

/**
 * 既存の保存アイデアで idea_title が汎用の "App Idea"（FM非対応端末のフォールバック）に
 * なっているものを、紐づくペインポイントの ai_generated_idea から実アプリ名に置き換える。
 * Llama 不使用・neuron 消費ゼロ・1回で完結。
 */
export async function backfillIdeaTitles(
  db: D1Database
): Promise<{ total: number; updated: number }> {
  const rows = await db
    .prepare(
      `SELECT si.id AS id, pp.ai_generated_idea AS idea
       FROM saved_ideas si
       JOIN pain_points pp ON si.pain_point_id = pp.id
       WHERE si.idea_title = 'App Idea'`
    )
    .all<{ id: number; idea: string | null }>()

  if (!rows.results || rows.results.length === 0) {
    return { total: 0, updated: 0 }
  }

  const total = rows.results.length
  const updateStmt = db.prepare('UPDATE saved_ideas SET idea_title = ? WHERE id = ?')
  const batch: D1PreparedStatement[] = []

  for (const row of rows.results) {
    const name = row.idea ? extractAppNameFromIdea(row.idea) : null
    if (name) {
      batch.push(updateStmt.bind(name, row.id))
    }
  }

  let updated = 0
  if (batch.length > 0) {
    await db.batch(batch)
    updated = batch.length
  }

  console.log(`Idea titles backfill: total(App Idea)=${total} updated=${updated}`)
  return { total, updated }
}
