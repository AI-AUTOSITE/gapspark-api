// アイデア掛け合わせ機能
// 複数アプリの不満を掛け合わせて「個人開発者が現実的に作れる革新的なアプリ」のアイデアを生成する。
//   おまかせ(auto)  = 週次cronが相性の良い組合せを事前生成しキャッシュ（全ユーザー無料）
//   手動(manual)    = ユーザーが2〜3個のペインを選んで生成（3回/日・Proは無制限）
// combo_key（ソート済みpain_point_id）でキャッシュ管理 → 同じ組合せは Claude を呼ばず再利用。

const MODEL_AUTO = 'claude-sonnet-5'              // おまかせ = 強モデル（キャッシュ前提なので品質優先）
const MODEL_MANUAL = 'claude-haiku-4-5-20251001'  // 手動 = Deep Diveと同じ安モデル（コスト管理）
const IDEA_FREE_LIMIT = 3                          // 手動の1日無料回数（Pro=無制限）

export type IdeaResult = {
  app_name: string
  concept: string
  differentiation: string
  mvp_features: string[]
  starter_prompt: string
  buildability: string
}

// combo_key: pain_point_id をソートして結合（"12,45,78"）
function comboKeyFor(ids: number[]): string {
  return [...ids].map(Number).sort((a, b) => a - b).join(',')
}

// ===== 手動生成の1日制限（Deep Diveと同じ構造・別枠）=====
export async function checkIdeaGenLimit(db: D1Database, userId: number) {
  const user = await db.prepare('SELECT subscription_tier FROM users WHERE id = ?')
    .bind(userId).first<{ subscription_tier: string }>()
  const pro = user?.subscription_tier === 'pro'
  const today = new Date().toISOString().slice(0, 10)
  const row = await db.prepare('SELECT count FROM idea_gen_usage WHERE user_id = ? AND usage_date = ?')
    .bind(userId, today).first<{ count: number }>()
  const used = row?.count ?? 0
  if (pro) return { allowed: true, used, limit: -1, pro: true }
  return { allowed: used < IDEA_FREE_LIMIT, used, limit: IDEA_FREE_LIMIT, pro: false }
}

export async function recordIdeaGenUsage(db: D1Database, userId: number) {
  const today = new Date().toISOString().slice(0, 10)
  await db.prepare(
    `INSERT INTO idea_gen_usage (user_id, usage_date, count) VALUES (?, ?, 1)
     ON CONFLICT(user_id, usage_date) DO UPDATE SET count = count + 1`
  ).bind(userId, today).run()
}

// ===== おまかせ一覧を取得（新しい順）=====
export async function getAutoIdeas(db: D1Database, limit = 20) {
  const res = await db.prepare(
    `SELECT id, pain_point_ids, idea, created_at FROM idea_combinations
     WHERE mode = 'auto' ORDER BY created_at DESC LIMIT ?`
  ).bind(limit).all<{ id: number; pain_point_ids: string; idea: string; created_at: string }>()
  return (res.results || []).map((r) => ({
    id: r.id,
    pain_point_ids: JSON.parse(r.pain_point_ids || '[]') as number[],
    idea: JSON.parse(r.idea) as IdeaResult,
    created_at: r.created_at,
  }))
}

// ===== 相性の良い組合せを探す（AIなし・JSで処理・neuron消費ゼロ）=====
// 同じ related_topic を共有し、かつ別々のアプリの、signal/severity が高いペインを2〜3個束ねる。
// = 「複数アプリが揃って落としているボール」を見つける。
type PainRow = {
  id: number; title: string; summary: string; severity_score: number
  mention_count: number; sample_size: number; related_topics: string; sample_app_ids: string
}
export async function findAutoCombos(db: D1Database, maxCombos = 10): Promise<number[][]> {
  const res = await db.prepare(
    `SELECT id, title, summary, severity_score, mention_count, sample_size, related_topics, sample_app_ids
     FROM pain_points`
  ).all<PainRow>()
  const pains = res.results || []

  const scoreOf = (p: PainRow) => {
    const ratio = p.sample_size > 0 ? p.mention_count / p.sample_size : 0
    return (p.severity_score || 0) * (0.5 + ratio) // signalで重み付け
  }
  const appOf = (p: PainRow): number | null => {
    try { const a = JSON.parse(p.sample_app_ids || '[]'); return Array.isArray(a) && a.length ? Number(a[0]) : null }
    catch { return null }
  }

  // topic → その topic を持つペイン一覧
  const byTopic = new Map<string, PainRow[]>()
  for (const p of pains) {
    let topics: string[] = []
    try { topics = JSON.parse(p.related_topics || '[]') } catch { /* noop */ }
    for (const t of topics) {
      if (!t || typeof t !== 'string') continue
      const key = t.toLowerCase()
      if (!byTopic.has(key)) byTopic.set(key, [])
      byTopic.get(key)!.push(p)
    }
  }

  // 各 topic で、別アプリの上位ペインを2〜3個束ねて combo にする
  const combos: { ids: number[]; score: number }[] = []
  const seen = new Set<string>()
  for (const group of byTopic.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => scoreOf(b) - scoreOf(a))
    const picked: PainRow[] = []
    const usedApps = new Set<number>()
    for (const p of sorted) {
      const app = appOf(p)
      if (app != null && usedApps.has(app)) continue // 同じアプリは1つまで
      picked.push(p)
      if (app != null) usedApps.add(app)
      if (picked.length >= 3) break
    }
    if (picked.length < 2) continue // 別アプリが2件揃わなければスキップ
    const ids = picked.map((p) => p.id)
    const key = comboKeyFor(ids)
    if (seen.has(key)) continue
    seen.add(key)
    combos.push({ ids, score: picked.reduce((s, p) => s + scoreOf(p), 0) })
  }

  combos.sort((a, b) => b.score - a.score)
  return combos.slice(0, maxCombos).map((c) => c.ids)
}

// ===== アイデア生成（キャッシュ確認 → Claude → 保存）=====
export async function generateIdea(
  db: D1Database, apiKey: string, painPointIds: number[], mode: 'auto' | 'manual'
): Promise<{ idea: IdeaResult; cached: boolean }> {
  const ids = [...new Set(painPointIds.map(Number))].filter((n) => Number.isInteger(n))
  if (ids.length < 2 || ids.length > 3) throw new Error('2〜3個のペインを選んでください')
  const comboKey = comboKeyFor(ids)

  // キャッシュ確認（おまかせ・手動どちらでも、既に生成済みなら再利用 → Claude呼ばない）
  const hit = await db.prepare('SELECT idea FROM idea_combinations WHERE combo_key = ? LIMIT 1')
    .bind(comboKey).first<{ idea: string }>()
  if (hit) return { idea: JSON.parse(hit.idea) as IdeaResult, cached: true }

  // ペインの詳細を取得
  const ph = ids.map(() => '?').join(',')
  const res = await db.prepare(
    `SELECT id, title, summary, related_topics, sample_app_ids FROM pain_points WHERE id IN (${ph})`
  ).bind(...ids).all<{ id: number; title: string; summary: string; related_topics: string; sample_app_ids: string }>()
  const pains = res.results || []
  if (pains.length < 2) throw new Error('選択したペインが見つかりません')

  // アプリ名を引く
  const allAppIds = new Set<number>()
  for (const p of pains) { try { for (const a of JSON.parse(p.sample_app_ids || '[]')) allAppIds.add(Number(a)) } catch { /* noop */ } }
  const appNames = new Map<number, string>()
  if (allAppIds.size) {
    const aph = [...allAppIds].map(() => '?').join(',')
    const ar = await db.prepare(`SELECT id, app_name FROM tracked_apps WHERE id IN (${aph})`)
      .bind(...[...allAppIds]).all<{ id: number; app_name: string }>()
    for (const r of ar.results || []) appNames.set(r.id, r.app_name)
  }
  const appLabel = (p: { sample_app_ids: string }) => {
    try { const a = JSON.parse(p.sample_app_ids || '[]'); return a.map((x: number) => appNames.get(Number(x)) || `App#${x}`).join(', ') }
    catch { return 'Unknown' }
  }

  // プロンプト構築
  const painList = pains.map((p, i) => {
    let topics: string[] = []
    try { topics = JSON.parse(p.related_topics || '[]') } catch { /* noop */ }
    return `${i + 1}. [App: ${appLabel(p)}] "${p.title}" — ${p.summary} Topics: ${topics.join(', ')}`
  }).join('\n')

  const systemPrompt = `You are a product strategist for indie developers and solo builders (including "vibe coders" who build apps with AI tools like Claude and Cursor). You will be given several real user complaints, each from the negative App Store reviews of a DIFFERENT popular app. Your job is NOT to merge these apps' features. Find the ONE underlying unmet need these complaints share, and propose a single new app that nails exactly that gap — an app one developer could realistically build and ship. You ALWAYS respond with valid JSON only. Never include markdown code blocks, explanations, or any text outside the JSON object. Your entire response must be parseable by JSON.parse().`

  const userPrompt = `Below are ${pains.length} real user complaints, each from the negative reviews of a DIFFERENT popular app. Do not merge their features — find the one shared unmet need and propose a single new app that fills exactly that gap.

COMPLAINTS:
${painList}

Return ONLY a JSON object with this exact structure:
{
  "app_name": "A short, memorable name",
  "concept": "2-3 sentences: what the app is and the core insight — the shared gap none of the source apps address well",
  "differentiation": "How this is meaningfully different from the apps above and why users would switch",
  "mvp_features": ["3-5 concrete features to build first — specific, not generic"],
  "starter_prompt": "A ready-to-paste prompt (120-200 words) an indie dev can give to Claude/Cursor to start building the MVP, including a suggested tech stack for a solo developer",
  "buildability": "One sentence on why a solo developer can realistically ship this"
}

Rules:
- Must be realistically buildable by ONE developer (no ideas that need a big team).
- Be specific and concrete. Avoid buzzwords and generic startup-speak.
- The concept must clearly connect to the actual complaints above.
- Do not restate the app names as the solution ("build a better X"). Find the real insight.
- Output ONLY the raw JSON object. Do NOT wrap it in markdown code fences (no \`\`\`). Start your response with { and end with }. No prose.`

  const model = mode === 'auto' ? MODEL_AUTO : MODEL_MANUAL
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
      ],
    }),
  })
  if (!response.ok) {
    const err = await response.text()
    console.error('Claude API error (idea):', response.status, err.substring(0, 200))
    throw new Error(`Claude API error: ${response.status}`)
  }
  const data = await response.json() as { content: { type: string; text: string }[] }
  const rawText = data.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') || ''
  const text = rawText.trimStart().startsWith('{') ? rawText : '{' + rawText
  const idea = parseIdeaResponse(text)

  // 保存（combo_key一意。他が先に入れた場合は IGNORE）
  await db.prepare(
    `INSERT OR IGNORE INTO idea_combinations (combo_key, pain_point_ids, mode, idea, model_used)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(comboKey, JSON.stringify(ids), mode, JSON.stringify(idea), model).run()

  return { idea, cached: false }
}

// ===== おまかせを一括事前生成（cron / debug 用）=====
export async function generateAutoIdeas(
  db: D1Database, apiKey: string, count = 5
): Promise<{ created: number; skipped: number }> {
  const combos = await findAutoCombos(db, count * 3) // 候補を多めに取りキャッシュ済みは飛ばす
  let created = 0, skipped = 0
  for (const ids of combos) {
    if (created >= count) break
    try {
      const { cached } = await generateIdea(db, apiKey, ids, 'auto')
      if (cached) { skipped++; continue }
      created++
      await new Promise((r) => setTimeout(r, 1000)) // API負荷を軽く分散
    } catch (e) {
      console.error('Auto idea generation failed for combo', ids, e)
    }
  }
  return { created, skipped }
}

// ===== JSONパース（Deep Dive同様の堅牢版・簡易）=====
function parseIdeaResponse(text: string): IdeaResult {
  let cleaned = text.trim()

  // ① markdownフェンスを全除去（```json / ``` )
  cleaned = cleaned.replace(/```json/gi, '').replace(/```/g, '')

  // ② 最初の「"app_name" を含む { 」を正しく捉えるため、
  //    先頭の余計な文字を落として、最初の { から最後の } までを抜く
  const f = cleaned.indexOf('{')
  const l = cleaned.lastIndexOf('}')
  if (f !== -1 && l > f) cleaned = cleaned.substring(f, l + 1)

  // ③ さらに、先頭が「{ 空白 {」のように { が二重で始まる場合、余分な { を1つ剥がす
  cleaned = cleaned.replace(/^\s*\{\s*\{/, '{')

  cleaned = cleaned.trim()

  const attempts = [
    () => JSON.parse(cleaned),
    () => JSON.parse(cleaned.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ')),
    () => JSON.parse(cleaned.replace(/,(\s*[}\]])/g, '$1').replace(/([{,]\s*)(\w+):/g, '$1"$2":')),
  ]
  for (const a of attempts) {
    try { return validateIdea(a()) } catch { /* 次を試す */ }
  }

  console.error('Idea JSON parse failed. Raw text:', text.substring(0, 800))
  throw new Error('アイデアのJSONパースに失敗しました')
}

function validateIdea(o: any): IdeaResult {
  return {
    app_name: String(o.app_name || 'Untitled Idea'),
    concept: String(o.concept || ''),
    differentiation: String(o.differentiation || ''),
    mvp_features: Array.isArray(o.mvp_features) ? o.mvp_features.map(String).slice(0, 8) : [],
    starter_prompt: String(o.starter_prompt || ''),
    buildability: String(o.buildability || ''),
  }
}