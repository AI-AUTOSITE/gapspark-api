// 全体カウント（総レビュー数・分析済み・ネガポジ・ペインポイント数など）の
// 計算とキャッシュを一元管理するモジュール。
//
// 【なぜ必要か】
// 以前は monitor.ts と dashboard.ts がそれぞれ
//   (SELECT COUNT(*) FROM reviews) を4本並べたクエリを直接実行していた。
// これは reviews を4周フルスキャンするため、1回あたり約82万行を読む。
// コストが reviews の行数に正比例するので、10万行を超えたあたりから
// D1 無料枠（5,000,000 rows_read/日）を静かに超過するようになった。
//
// 【方針】ここが再発防止の要
//   書き込み（重い集計）: Cron からのみ  → refreshStatsCache()
//   読み取り（API・監視）: キャッシュだけ → readCachedStats()
//
// readCachedStats() は「キャッシュが無ければゼロを返す」だけで、
// 絶対に自分で集計しない。読み取り経路から重いクエリが走る道を塞いでおく。
// （ここでフォールバック集計を許すと、/api/dashboard を叩かれた回数だけ
//   82万行スキャンが走る＝今回と同じ事故が再発する）

export type Counts = {
  total: number
  analyzed: number
  negative: number
  positive: number
  pain_points: number
  tracked_apps: number
  deep_dives: number
}

export type CachedStats = {
  counts: Counts
  updated_at: string | null   // null = まだ一度もキャッシュが作られていない
}

const EMPTY_COUNTS: Counts = {
  total: 0,
  analyzed: 0,
  negative: 0,
  positive: 0,
  pain_points: 0,
  tracked_apps: 0,
  deep_dives: 0,
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 実際にDBを集計する【重い処理】。Cron からのみ呼ぶこと。
 *
 * reviews のスキャンは1周だけ。以前の
 *   (SELECT COUNT(*) FROM reviews), (SELECT COUNT(*) FROM reviews WHERE ...) × 3
 * は4周していたので、これだけで読み取りが 1/4 になる。
 * 残りのテーブルは数百行なのでコストは無視できる。
 */
export async function computeCounts(db: D1Database): Promise<Counts> {
  const [reviewRes, ppRes, appsRes, ddRes] = await db.batch([
    db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN sentiment_score IS NOT NULL  THEN 1 ELSE 0 END) AS analyzed,
        SUM(CASE WHEN sentiment_label = 'NEGATIVE' THEN 1 ELSE 0 END) AS negative,
        SUM(CASE WHEN sentiment_label = 'POSITIVE' THEN 1 ELSE 0 END) AS positive
      FROM reviews
    `),
    db.prepare('SELECT COUNT(*) AS c FROM pain_points'),
    db.prepare('SELECT COUNT(*) AS c FROM tracked_apps'),
    db.prepare('SELECT COUNT(*) AS c FROM deep_dives'),
  ])

  const r = (reviewRes.results?.[0] ?? {}) as Record<string, unknown>

  return {
    total: num(r.total),
    analyzed: num(r.analyzed),
    negative: num(r.negative),
    positive: num(r.positive),
    pain_points: num((ppRes.results?.[0] as Record<string, unknown>)?.c),
    tracked_apps: num((appsRes.results?.[0] as Record<string, unknown>)?.c),
    deep_dives: num((ddRes.results?.[0] as Record<string, unknown>)?.c),
  }
}

/**
 * キャッシュを読む【軽い処理】。1行しか読まないので、何回呼んでもコストは一定。
 * キャッシュが無い／壊れている場合はゼロを返す（集計はしない）。
 */
export async function readCachedStats(db: D1Database): Promise<CachedStats> {
  try {
    const row = await db
      .prepare('SELECT payload, updated_at FROM stats_cache WHERE id = 1')
      .first<Record<string, string>>()

    if (!row?.payload) {
      return { counts: { ...EMPTY_COUNTS }, updated_at: null }
    }

    const parsed = JSON.parse(row.payload) as Partial<Counts>
    return {
      counts: { ...EMPTY_COUNTS, ...parsed },
      updated_at: row.updated_at ?? null,
    }
  } catch (e) {
    // テーブル未作成・JSON破損など。ここで落ちるとAPI全体が500になるので握りつぶす
    console.error('readCachedStats failed:', e)
    return { counts: { ...EMPTY_COUNTS }, updated_at: null }
  }
}

/**
 * 集計してキャッシュに書き込む【重い処理】。Cron からのみ呼ぶこと。
 * 計算した Counts をそのまま返すので、呼び出し側は再読み込み不要。
 */
export async function refreshStatsCache(db: D1Database): Promise<Counts> {
  const counts = await computeCounts(db)

  await db
    .prepare(`
      INSERT INTO stats_cache (id, payload, updated_at)
      VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        payload    = excluded.payload,
        updated_at = excluded.updated_at
    `)
    .bind(JSON.stringify(counts))
    .run()

  return counts
}

// ============================================================
// アプリ別の統計キャッシュ（Step 4）
// ============================================================
//
// generate-pain-points.ts の候補選定クエリ（1回53万行・1日8回＝約4.25M行）を
// 置き換えるためのキャッシュ。上と同じ「Cronが書き、読み手は読むだけ」の形。
//
//   refreshAppStatsCache() … 6時間cronからのみ（重い。ネガレビューを1周）
//   readCandidateApps()    … 3時間cronが呼ぶ（101行読むだけ）

export type CandidateApp = {
  app_id: number
  app_name: string
  category: string
  tags: string
  negative_count: number
  existing_pain_points: number
  // ---- 回転・バックオフの状態（Step 2）----
  window_offset: number     // 次に読み始めるレビューの位置
  empty_streak: number      // 連続で「1周まるごと空振り」した回数
  cycle_created: number     // 現在の周回で生まれたペインポイント数
}

/**
 * アプリ別のネガレビュー数とペインポイント数を集計してキャッシュに保存する【重い処理】。
 * 6時間cronからのみ呼ぶこと。
 *
 * 旧クエリとの違い:
 *   旧) tracked_apps JOIN reviews + 相関サブクエリ(pain_points × json_each × アプリ数)
 *   新) ①ネガ数をGROUP BYで1周 ②ペイン数をjson_eachで1周 の2本に分解
 * 相関サブクエリが消えるので、pain_points の読み取りがアプリ数倍されなくなる。
 */
export async function refreshAppStatsCache(
  db: D1Database
): Promise<{ apps: number }> {
  // ① アプリ別ネガティブレビュー数
  //    idx_reviews_app_sentiment(tracked_app_id, sentiment_label, sentiment_score) が
  //    そのまま使えるカバリングインデックス
  const negRes = await db.prepare(`
    SELECT tracked_app_id AS app_id, COUNT(*) AS negative_count
    FROM reviews
    WHERE sentiment_label = 'NEGATIVE' AND sentiment_score IS NOT NULL
    GROUP BY tracked_app_id
  `).all<{ app_id: number; negative_count: number }>()

  // ② アプリ別ペインポイント数（pain_points は数百行なので軽い）
  const ppRes = await db.prepare(`
    SELECT CAST(json_each.value AS INTEGER) AS app_id,
           COUNT(DISTINCT pp.id) AS pain_point_count
    FROM pain_points pp, json_each(pp.sample_app_ids)
    GROUP BY CAST(json_each.value AS INTEGER)
  `).all<{ app_id: number; pain_point_count: number }>()

  const painCounts = new Map<number, number>()
  for (const row of ppRes.results ?? []) {
    painCounts.set(num(row.app_id), num(row.pain_point_count))
  }

  // 全消し → 入れ直し。追跡から外れたアプリの行が残らない
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM app_stats_cache'),
  ]

  const insert = db.prepare(`
    INSERT INTO app_stats_cache (app_id, negative_count, pain_point_count, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `)

  const seen = new Set<number>()
  for (const row of negRes.results ?? []) {
    const id = num(row.app_id)
    seen.add(id)
    stmts.push(insert.bind(id, num(row.negative_count), painCounts.get(id) ?? 0))
  }

  // ネガレビューが0件でもペインポイントを持つアプリは記録しておく
  for (const [id, count] of painCounts) {
    if (!seen.has(id)) stmts.push(insert.bind(id, 0, count))
  }

  await db.batch(stmts)
  return { apps: stmts.length - 1 }
}

// ---- 空振りバックオフ（Step C） ----------------------------------------
//
// 掘っても何も生まれないアプリは pain_point_count が増えないため、
// ORDER BY pain_point_count ASC だと永久に最優先で選ばれ続けてしまう。
// 「連続で0件だった回数」に応じて次回までの待ち時間を倍々に伸ばす。

const BASE_COOLDOWN_HOURS = 6      // 空振り0回のときの待ち時間（=3時間cron 2回分）
const MAX_BACKOFF_STEPS = 6        // 2^6 = 64 → 384時間（16日）で頭打ち

/** 連続空振り回数から、次に試すまでの待ち時間（時間）を求める */
export function cooldownHours(emptyStreak: number): number {
  const steps = Math.min(Math.max(emptyStreak, 0), MAX_BACKOFF_STEPS)
  return BASE_COOLDOWN_HOURS * Math.pow(2, steps)
}

type CandidateRow = Omit<CandidateApp, 'window_offset' | 'empty_streak' | 'cycle_created'> & {
  last_attempted_at: string | null
  window_offset: number | null
  empty_streak: number | null
  cycle_created: number | null
}

/**
 * app_stats_cache が空かどうか（1行読むだけ）。
 * 「候補が0件」の理由が『キャッシュ未作成』なのか『全アプリが待機中』なのかを
 * 区別するために使う。区別しないと、待機中のたびに重い再集計が走ってしまう。
 */
export async function isAppStatsCacheEmpty(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare('SELECT COUNT(*) AS c FROM app_stats_cache')
    .first<{ c: number }>()
  return num(row?.c) === 0
}

/**
 * ペインポイント生成の候補アプリを取り出す【軽い処理】。
 * app_stats_cache・tracked_apps・app_generation_state はいずれもアプリ数ぶん
 * （約100行）なので、全部読んでも300行程度。絞り込みと並べ替えはJS側で行う。
 *
 * 優先順位:
 *   1. 一度も試していないアプリ
 *   2. 空振りが少ないアプリ（＝実績のあるアプリ）
 *   3. 既存ペインポイントが少ないアプリ
 *   4. ネガティブレビューが多いアプリ
 */
export async function readCandidateApps(
  db: D1Database,
  limit: number,
  minNegativeReviews = 5
): Promise<CandidateApp[]> {
  const res = await db.prepare(`
    SELECT
      ta.id         AS app_id,
      ta.app_name   AS app_name,
      ta.category   AS category,
      ta.tags       AS tags,
      s.negative_count   AS negative_count,
      s.pain_point_count AS existing_pain_points,
      g.last_attempted_at AS last_attempted_at,
      g.window_offset     AS window_offset,
      g.empty_streak      AS empty_streak,
      g.cycle_created     AS cycle_created
    FROM app_stats_cache s
    JOIN tracked_apps ta ON ta.id = s.app_id
    LEFT JOIN app_generation_state g ON g.app_id = s.app_id
    WHERE s.negative_count >= ?
  `).bind(minNegativeReviews).all<CandidateRow>()

  const now = Date.now()

  const ready = (res.results ?? []).filter((row) => {
    if (!row.last_attempted_at) return true   // 未着手は常に対象
    // SQLite の datetime('now') は "YYYY-MM-DD HH:MM:SS"（UTC）形式
    const attempted = Date.parse(row.last_attempted_at.replace(' ', 'T') + 'Z')
    if (!Number.isFinite(attempted)) return true   // 壊れた値なら対象に含める
    const waitMs = cooldownHours(num(row.empty_streak)) * 3600_000
    return now - attempted >= waitMs
  })

  ready.sort((a, b) => {
    const aNew = a.last_attempted_at ? 1 : 0
    const bNew = b.last_attempted_at ? 1 : 0
    if (aNew !== bNew) return aNew - bNew
    const aStreak = num(a.empty_streak)
    const bStreak = num(b.empty_streak)
    if (aStreak !== bStreak) return aStreak - bStreak
    if (a.existing_pain_points !== b.existing_pain_points) {
      return a.existing_pain_points - b.existing_pain_points
    }
    return b.negative_count - a.negative_count
  })

  return ready.slice(0, limit).map((row) => ({
    app_id: row.app_id,
    app_name: row.app_name,
    category: row.category,
    tags: row.tags,
    negative_count: row.negative_count,
    existing_pain_points: row.existing_pain_points,
    window_offset: num(row.window_offset),
    empty_streak: num(row.empty_streak),
    cycle_created: num(row.cycle_created),
  }))
}

/**
 * 1アプリぶんの生成結果を記録し、次回の読み位置を決める（Step 2: 回転）。
 *
 *   窓を1つ進める:        window_offset += windowSize
 *   末尾に達したら1周:    window_offset = 0（reviewsInWindow < windowSize でも末尾とみなす）
 *   成果が出た:           empty_streak = 0（即リセット）
 *   1周まるごと空振り:    empty_streak += 1（窓1つの空振りでは伸ばさない）
 *
 * 「窓1つが空でも次の窓は当たりかもしれない」ので、1周するまでは
 * 基本の6時間サイクルで淡々と進める。待機が伸びるのは1周して何も
 * 出なかったときだけ。
 */
export async function recordGenerationAttempt(
  db: D1Database,
  app: Pick<CandidateApp, 'app_id' | 'negative_count' | 'window_offset' | 'empty_streak' | 'cycle_created'>,
  created: number,
  reviewsInWindow: number,
  windowSize: number
): Promise<{ nextOffset: number; wrapped: boolean; emptyStreak: number }> {
  const nextRaw = app.window_offset + windowSize
  const wrapped = nextRaw >= app.negative_count || reviewsInWindow < windowSize
  const nextOffset = wrapped ? 0 : nextRaw
  const cycleCreated = app.cycle_created + created

  let streak = app.empty_streak
  if (created > 0) {
    streak = 0
  } else if (wrapped && cycleCreated === 0) {
    streak += 1
  }
  const nextCycleCreated = wrapped ? 0 : cycleCreated

  try {
    await db.prepare(`
      INSERT INTO app_generation_state
        (app_id, last_attempted_at, last_created_at, empty_streak, window_offset, cycle_created, updated_at)
      VALUES
        (?, datetime('now'), CASE WHEN ? > 0 THEN datetime('now') ELSE NULL END, ?, ?, ?, datetime('now'))
      ON CONFLICT(app_id) DO UPDATE SET
        last_attempted_at = datetime('now'),
        last_created_at   = CASE WHEN ? > 0 THEN datetime('now') ELSE app_generation_state.last_created_at END,
        empty_streak      = ?,
        window_offset     = ?,
        cycle_created     = ?,
        updated_at        = datetime('now')
    `).bind(
      app.app_id, created, streak, nextOffset, nextCycleCreated,
      created, streak, nextOffset, nextCycleCreated
    ).run()
  } catch (e) {
    // 記録に失敗しても生成そのものは成功しているので、握りつぶして続行する
    console.error(`recordGenerationAttempt failed for app ${app.app_id}:`, e)
  }

  return { nextOffset, wrapped, emptyStreak: streak }
}
