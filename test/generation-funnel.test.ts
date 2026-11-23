// ============================================================
// 生成の「ふるい」と、モデル失敗時の窓の扱い — 回帰テスト
// ============================================================
//
// 2026-10-25 に2つを足した:
//   1. 生成1回ごとに、候補 → 各段階の除外数 → 保存数を generation_runs に記録する。
//      重複で落とした候補の見本（何と一致したか）を rejected_duplicates に残す。
//   2. モデルが2回とも失敗した窓を「空だった」扱いにしない。
//      以前は再試行ループの最後で例外を握りつぶしていて、窓が進んでいた。
//      9/30 のテストは「読めない返答で例外を投げるか」だけを見ていて、
//      その例外が最後にどこへ行くかを確かめていなかった。ここでは生成全体を
//      本物の SQLite で通して、窓が保持されることまで見る。
//
// 実行: npm test
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  generatePainPoints,
  deduplicatePainPoints,
  deduplicateExistingPainPoints,
  isTitleDuplicate,
  recordGenerationRun,
  type DedupRejection,
  type ScoredPainPoint,
} from '../src/cron/generate-pain-points'
import { createTestDb, type TestDb } from './helpers/sqlite-d1'

// ------------------------------------------------------------
// 1. 重複判定：判定は変えずに、見本を集める
// ------------------------------------------------------------
const pp = (title: string, summary: string): ScoredPainPoint => ({
  title, summary, keywords: [], related_topics: [], severity: 'medium', ai_generated_idea: '',
  ruleBasedScore: 0.5, reviewCount: 10, matchingReviewCount: 3,
})

describe('deduplicatePainPoints: 落とした候補が「何と」重なったかを集める', () => {
  const existingTitles = ['Offline sync fails after update', 'Subscription price doubled without notice']
  const existingSummaries = [
    'Notes edited without a connection never reach other devices once the app updates.',
    'Renewal charged twice the original amount and the email gave no warning beforehand.',
  ]

  it('タイトルが重なった候補は、相手のタイトルと重なりの割合つきで記録される', () => {
    const rejections: DedupRejection[] = []
    const out = deduplicatePainPoints([pp('Sync fails offline', 'A different description entirely about calendars.')],
      [...existingTitles], [...existingSummaries], rejections)
    expect(out).toEqual([])
    expect(rejections).toEqual([{
      candidateTitle: 'Sync fails offline', matchedTitle: 'Offline sync fails after update', kind: 'title', score: 0.75,
    }])
  })

  it('要約で重なったときも、記録するのは相手のタイトル（人が読んで分かるように）', () => {
    const rejections: DedupRejection[] = []
    deduplicatePainPoints(
      [pp('Billing surprise at renewal', 'Renewal charged twice the original amount, no warning email.')],
      [...existingTitles], [...existingSummaries], rejections)
    expect(rejections).toHaveLength(1)
    expect(rejections[0].kind).toBe('summary')
    expect(rejections[0].matchedTitle).toBe('Subscription price doubled without notice')
  })

  it('見本を集めても集めなくても、残る候補は同じ（判定は変わっていない）', () => {
    const candidates = [
      pp('Sync fails offline', 'x'.repeat(40)),
      pp('Export stalls at ninety percent', 'Rendering a long timeline stops near the end and never finishes.'),
      pp('Export hangs near completion', 'Rendering a long timeline stops near the end, then freezes.'),
      pp('Widget shows stale weather', 'The home screen widget keeps yesterday’s forecast until opened.'),
    ]
    const without = deduplicatePainPoints(candidates, [...existingTitles], [...existingSummaries])
    const withCollector = deduplicatePainPoints(candidates, [...existingTitles], [...existingSummaries], [])
    expect(withCollector.map(p => p.title)).toEqual(without.map(p => p.title))
    // 同じ回の先行候補との重複も落ちる（2本目の Export）
    expect(without.map(p => p.title)).toEqual(['Export stalls at ninety percent', 'Widget shows stale weather'])
  })
})

// ------------------------------------------------------------
// 1b. 重複判定の線引き — 2026-10-25〜11-01 の見本 296 件からの実例
// ------------------------------------------------------------
// 旧基準（短い方の語数で割って 0.4 以上）では、どれも「重複」として落ちていた。
// 目で確かめて、上は本当の重複、下は別の不満だったもの。
describe('タイトルの重複判定: 本当の重複は落とし、別の不満は通す', () => {
  const reject = (cand: string, existing: string) =>
    deduplicatePainPoints([pp(cand, 'candidate summary that shares nothing with the other one')],
      [existing], ['an unrelated existing summary about something else entirely'])

  it.each([
    ['Increased taps required to end focus session', 'Increased taps required to end focus session'],
    ['Increased steps to log food after update', 'Increased steps to log food'],
    ['Refunds denied or delayed for incomplete orders', 'Refunds denied for incomplete orders'],
    ['Food arrives cold due to delivery delays', 'Food arrives cold due to delayed delivery'],
  ])('本当の重複は落ちる: 「%s」←「%s」', (cand, existing) => {
    expect(reject(cand, existing)).toEqual([])
  })

  it.each([
    ['Notifications fail after period of app inactivity', 'Notifications are not cool'],
    ['Event editing fails on iOS after software update', 'Fails to update assets after update'],
    ['Unable to combine gift cards for payment', 'Unable to rename gift cards in app'],       // 新しい計算でちょうど 0.4
    ['Payment authentication fails on order placement', 'Inconsistent Ad Placement'],
    ['App crashes on launch after recent update', 'Crashes and Instability'],
  ])('別の不満は通る: 「%s」←「%s」', (cand, existing) => {
    expect(reject(cand, existing).map(p => p.title)).toEqual([cand])
  })

  it('線はちょうど 0.5（0.5 は落とし、0.4 は通す）', () => {
    // 語の集合で直接確かめる（重なり2語）
    expect(isTitleDuplicate(new Set(['a1', 'b2', 'c3']), new Set(['a1', 'b2', 'd4']))).toBe(0.5)   // 2/4
    expect(isTitleDuplicate(new Set(['a1', 'b2', 'c3']), new Set(['a1', 'b2', 'd4', 'e5']))).toBeNull()  // 2/5 = 0.4
  })
})

// ------------------------------------------------------------
// 1c. 既存データの掃除（debug）も同じ線引きを使う
// ------------------------------------------------------------
// 同じアプリなら「タイトルか要約のどちらかが重なれば消す」作り。古い基準のままだと、
// 別の不満を既存データから消してしまう（生成で落とすより取り返しがつかない）。
describe('deduplicateExistingPainPoints: 別の不満は消さない', () => {
  let db: TestDb
  beforeEach(() => { db = createTestDb() })
  const add = (title: string, summary: string) => db.raw.prepare(
    `INSERT INTO pain_points (category, title, summary, sample_app_ids) VALUES ('X', ?, ?, '[7]')`).run(title, summary)

  it('同じアプリでも、旧基準でだけ重なるものは両方残る', async () => {
    add('Notifications are not cool', 'Alert sounds and banners feel dated and look unpolished.')
    add('Notifications fail after period of app inactivity', 'Reminders stop arriving once the phone sits idle for days.')
    const r = await deduplicateExistingPainPoints(db as any)
    expect(r).toEqual({ total: 2, removed: 0, remaining: 2 })
  })

  it('本当の重複は1件にまとまる', async () => {
    add('Food arrives cold due to delivery delays', 'Orders sit too long before pickup and arrive lukewarm.')
    add('Food arrives cold due to delayed delivery', 'Drivers batch several orders so meals cool down on the way.')
    const r = await deduplicateExistingPainPoints(db as any)
    expect(r).toEqual({ total: 2, removed: 1, remaining: 1 })
  })
})

// ------------------------------------------------------------
// 2. 記録：全列を読み戻す（種値は全列で別の値）
// ------------------------------------------------------------
describe('recordGenerationRun: 1回分の集計と見本を記録する', () => {
  let db: TestDb
  beforeEach(() => { db = createTestDb() })

  const stats = {
    windows: 8, candidates: 29, rawRejected: 3, dupRejected: 11, qualityRejected: 2,
    signalRejected: 5, created: 6, errors: 1, existingCount: 892,
  }

  it('集計の全列が、それぞれの列に入る', async () => {
    await recordGenerationRun(db as any, stats)
    const row = db.raw.prepare('SELECT * FROM generation_runs').get() as Record<string, unknown>
    const { id, run_at, ...rest } = row
    expect(rest).toEqual({
      windows: 8, candidates: 29, raw_rejected: 3, dup_rejected: 11, quality_rejected: 2,
      signal_rejected: 5, created: 6, errors: 1, existing_count: 892,
    })
    expect(run_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('重複の見本は、候補・相手・種類・割合が列に入る', async () => {
    await recordGenerationRun(db as any, stats, [
      { appId: 7, candidateTitle: 'Sync fails offline', matchedTitle: 'Offline sync fails after update', kind: 'title', score: 0.666666 },
    ])
    const row = db.raw.prepare('SELECT app_id, candidate_title, matched_title, kind, score FROM rejected_duplicates').get()
    expect(row).toEqual({
      app_id: 7, candidate_title: 'Sync fails offline', matched_title: 'Offline sync fails after update', kind: 'title', score: 0.67,
    })
  })

  it('見本は最新300件だけ残る（1回あたり最大20件）', async () => {
    const twenty = Array.from({ length: 25 }, (_, i) => ({
      appId: 7, candidateTitle: `c${i}`, matchedTitle: `m${i}`, kind: 'title' as const, score: 0.5,
    }))
    for (let run = 0; run < 16; run++) await recordGenerationRun(db as any, stats, twenty)
    const r = db.raw.prepare('SELECT COUNT(*) AS n, MIN(id) AS first FROM rejected_duplicates').get() as { n: number; first: number }
    expect(r.n).toBe(300)          // 16回 × 20件 = 320件 → 古い20件が消える
    expect(r.first).toBe(21)
  })

  it('失敗の理由は列に入り、最新200件だけ残る', async () => {
    const errs = Array.from({ length: 30 }, (_, i) => ({ appId: 7, message: `InferenceUpstreamError: timeout ${i}` }))
    for (let run = 0; run < 7; run++) await recordGenerationRun(db as any, stats, [], errs)
    const r = db.raw.prepare('SELECT COUNT(*) AS n, MIN(id) AS first FROM generation_errors').get() as { n: number; first: number }
    expect(r).toEqual({ n: 200, first: 11 })   // 7回 × 30件 = 210件 → 古い10件が消える
    const last = db.raw.prepare('SELECT app_id, message FROM generation_errors ORDER BY id DESC LIMIT 1').get()
    expect(last).toEqual({ app_id: 7, message: 'InferenceUpstreamError: timeout 29' })
  })

  it('記録に失敗しても例外にしない（保存はもう終わっている）', async () => {
    db.raw.exec('DROP TABLE generation_runs')
    await expect(recordGenerationRun(db as any, stats)).resolves.toBeUndefined()
  })
})

// ------------------------------------------------------------
// 3. 生成全体：本物の SQLite で通す
// ------------------------------------------------------------
// アプリ1本・ネガティブレビュー10件・既存ペインポイント1件を用意する。
// モデル（Workers AI）だけを偽物にする。
function seed(db: TestDb) {
  db.raw.exec(`
    INSERT INTO tracked_apps (id, apple_id, app_name, category) VALUES (7, '777', 'Test Video', 'Photo & Video');
    INSERT INTO app_stats_cache (app_id, negative_count, pain_point_count) VALUES (7, 10, 1);
    INSERT INTO pain_points (category, title, summary, sample_app_ids, keywords, related_topics)
      VALUES ('Photo & Video', 'Offline sync fails after update',
              'Projects edited without a connection never reach other devices after updating.',
              '[7]', '["sync"]', '[]');
  `)
  const ins = db.raw.prepare(`
    INSERT INTO reviews (tracked_app_id, review_id, rating, title, body, region, sentiment_score, sentiment_label)
    VALUES (7, ?, 1, ?, ?, 'us', ?, 'NEGATIVE')`)
  for (let i = 0; i < 10; i++) {
    const body = i < 3 ? 'The export stalls at ninety percent every single time' : `Generic complaint number ${i}`
    ins.run(`r${i}`, `Review ${i}`, body, -0.9 + i * 0.01)
  }
}

const state = (db: TestDb) =>
  db.raw.prepare('SELECT window_offset, error_streak FROM app_generation_state WHERE app_id = 7').get()

// 生成コードの待ち時間（5秒・3秒）を飛ばして走らせる
async function run(db: TestDb, ai: unknown) {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    const p = generatePainPoints(db as any, ai as any, 1)
    await vi.runAllTimersAsync()
    return await p
  } finally {
    vi.useRealTimers()
  }
}

describe('generatePainPoints: モデルが失敗した窓は「空」ではなく「失敗」', () => {
  let db: TestDb
  beforeEach(() => { db = createTestDb(); seed(db) })
  afterEach(() => { vi.useRealTimers() })

  it('モデルが2回とも失敗 → 窓は進まず、error_streak=1、ふるいの記録に errors=1', async () => {
    const ai = { run: vi.fn(async () => { throw new Error('model unavailable') }) }
    const r = await run(db, ai)

    expect(r.errors).toBe(1)
    expect(r.appsProcessed).toBe(0)
    expect(state(db)).toEqual({ window_offset: 0, error_streak: 1 })   // 窓は保持
    const g = db.raw.prepare('SELECT windows, candidates, errors FROM generation_runs').get()
    expect(g).toEqual({ windows: 0, candidates: 0, errors: 1 })
    // 失敗の理由が、どのアプリのものか分かる形で残る（migration 0015）
    const e = db.raw.prepare('SELECT app_id, message FROM generation_errors').all()
    expect(e).toEqual([{ app_id: 7, message: 'Error: model unavailable' }])
  })
})

describe('generatePainPoints: ふるいの各段階が数えられ、記録される', () => {
  let db: TestDb
  beforeEach(() => { db = createTestDb(); seed(db) })

  it('候補2件：1件は既存と重複で除外、1件は保存 → 数と見本が残る', async () => {
    const response = JSON.stringify({ pain_points: [
      {
        title: 'Sync fails offline',
        summary: 'Edits made without a network connection are lost when the device reconnects later.',
        keywords: ['sync', 'offline'], related_topics: ['sync'], severity: 'high', ai_generated_idea: 'x',
      },
      {
        title: 'Export stalls at ninety percent',
        summary: 'Rendering a finished timeline stops near the end and never completes the file.',
        keywords: ['export', 'stalls'], related_topics: ['export'], severity: 'high', ai_generated_idea: 'y',
      },
    ] })
    const ai = { run: vi.fn(async () => ({ response })) }
    const r = await run(db, ai)

    expect(r).toMatchObject({ appsProcessed: 1, candidates: 2, duplicatesSkipped: 1, painPointsCreated: 1, errors: 0 })
    const g = db.raw.prepare('SELECT windows, candidates, dup_rejected, created, existing_count FROM generation_runs').get()
    expect(g).toEqual({ windows: 1, candidates: 2, dup_rejected: 1, created: 1, existing_count: 1 })
    const ex = db.raw.prepare('SELECT candidate_title, matched_title, kind FROM rejected_duplicates').get()
    expect(ex).toEqual({ candidate_title: 'Sync fails offline', matched_title: 'Offline sync fails after update', kind: 'title' })
    expect(state(db)).toMatchObject({ error_streak: 0 })
  })
})

// ------------------------------------------------------------
// 4. 週報に「生成のふるい」が出る
// ------------------------------------------------------------
import { sendWeeklyReportNow } from '../src/monitor'

describe('週報: 生成のふるい', () => {
  let db: TestDb
  let sentHtml = ''
  beforeEach(() => {
    db = createTestDb()
    sentHtml = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sentHtml = JSON.parse(init.body).html
      return new Response('{}', { status: 200 })
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('記録がまだ無いときは、そう書く', async () => {
    await sendWeeklyReportNow({ DB: db as any, RESEND_API_KEY: 'x' } as any)
    expect(sentHtml).toContain('生成のふるい')
    expect(sentHtml).toContain('まだ記録がありません')
  })

  it('各段階の数と、重複の見本が出る。タイトルの記号はエスケープされる', async () => {
    // 直近6日に毎日生成がある状態にする（ゼロの日が続くと、そちらの警告が優先されるため）
    for (let d = 0; d < 7; d++) {
      db.raw.prepare(`INSERT INTO pain_points (category, title, summary, created_at)
                      VALUES ('X', ?, 'summary text long enough', datetime('now', ?))`).run(`pp ${d}`, `-${d} days`)
    }
    await recordGenerationRun(db as any, {
      windows: 8, candidates: 40, rawRejected: 2, dupRejected: 24, qualityRejected: 1,
      signalRejected: 5, created: 8, errors: 0, existingCount: 892,
    }, [{ appId: 7, candidateTitle: 'Export <fails> & stalls', matchedTitle: 'Export stalls', kind: 'title', score: 1 }])
    await sendWeeklyReportNow({ DB: db as any, RESEND_API_KEY: 'x' } as any)

    expect(sentHtml).toContain('重複で除外')
    expect(sentHtml).toMatch(/<b>24<\/b><\/td><td[^>]*>60%/)          // 重複 24 件 = 候補の 60%
    expect(sentHtml).toContain('Export &lt;fails&gt; &amp; stalls')   // そのまま埋め込まない
    expect(sentHtml).not.toContain('<fails>')
    // 2026-11-23: 重複の割合だけでは注意を出さない（既存が増えれば自然に上がるため）
    expect(sentHtml).not.toContain('「重複」で除外されています')
    expect(sentHtml).toContain('OK 順調です')
  })
})

// ------------------------------------------------------------
// 5. 読む順番 — 待ち時間が終わったら、いちばん長く読まれていないものから
// ------------------------------------------------------------
// 2026-11-23: 「空振りの少ないアプリが先」だったため、空振り0回の54本が1日64枠を
// 使い切り、空振り1回の62本は 11/1 から一度も読まれていなかった（最古は 9/25）。
import { readCandidateApps } from '../src/stats'
import { STARVED_AFTER_HOURS } from '../src/monitor'

// 「○時間前」を SQLite の datetime 形式で
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().slice(0, 19).replace('T', ' ')

function seedApps(db: TestDb, apps: { id: number; name: string; streak?: number; err?: number; ppCount?: number; at?: string | null }[]) {
  for (const a of apps) {
    db.raw.prepare(`INSERT INTO tracked_apps (id, apple_id, app_name, category) VALUES (?, ?, ?, 'X')`).run(a.id, String(900 + a.id), a.name)
    db.raw.prepare(`INSERT INTO app_stats_cache (app_id, negative_count, pain_point_count) VALUES (?, 100, ?)`).run(a.id, a.ppCount ?? 0)
    if (a.at !== null) {
      db.raw.prepare(`INSERT INTO app_generation_state (app_id, last_attempted_at, empty_streak, error_streak) VALUES (?, ?, ?, ?)`)
        .run(a.id, a.at, a.streak ?? 0, a.err ?? 0)
    }
  }
}

describe('readCandidateApps: 未着手 → いちばん長く読まれていないもの の順', () => {
  let db: TestDb
  beforeEach(() => { db = createTestDb() })

  it('空振り1回でも、待ち時間が終わっていて一番古ければ先に読まれる', async () => {
    seedApps(db, [
      { id: 1, name: 'fresh-productive', streak: 0, at: hoursAgo(7) },          // 待ち6h → 対象
      { id: 2, name: 'starved-dry',      streak: 1, at: hoursAgo(24 * 50) },    // 待ち12h → 対象、50日前
      { id: 3, name: 'never-read',       at: null },                             // 未着手
      { id: 4, name: 'just-read',        streak: 0, at: hoursAgo(1) },          // 待ち中 → 対象外
      { id: 5, name: 'dry-cooling',      streak: 1, at: hoursAgo(10) },         // 待ち12h中 → 対象外
      { id: 6, name: 'many-pp',          streak: 0, at: hoursAgo(48), ppCount: 90 },
    ])
    const picked = await readCandidateApps(db as any, 10)
    expect(picked.map(a => a.app_name)).toEqual(['never-read', 'starved-dry', 'many-pp', 'fresh-productive'])
  })

  it('空振りの罰は待ち時間で受ける（並び順では罰さない）', async () => {
    seedApps(db, [
      { id: 1, name: 'dry-3', streak: 3, at: hoursAgo(49) },   // 待ち48h → 対象、49h前
      { id: 2, name: 'dry-0', streak: 0, at: hoursAgo(8) },    // 待ち6h → 対象、8h前
    ])
    const picked = await readCandidateApps(db as any, 1)
    expect(picked.map(a => a.app_name)).toEqual(['dry-3'])
  })
})

describe('週報: 待ち時間が終わっても読まれないアプリと、失敗の理由', () => {
  let db: TestDb
  let sentHtml = ''
  beforeEach(() => {
    db = createTestDb()
    sentHtml = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sentHtml = JSON.parse(init.body).html
      return new Response('{}', { status: 200 })
    }))
    for (let d = 0; d < 7; d++) {
      db.raw.prepare(`INSERT INTO pain_points (category, title, summary, created_at)
                      VALUES ('X', ?, 'summary text long enough', datetime('now', ?))`).run(`pp ${d}`, `-${d} days`)
    }
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('待ち時間が終わってから3日以上読まれていないアプリは、名前と日数つきで注意に出る', async () => {
    seedApps(db, [
      { id: 1, name: 'Forgotten <App>', streak: 1, at: hoursAgo(12 + STARVED_AFTER_HOURS + 24) },  // 4日放置
      { id: 2, name: 'Recent',          streak: 0, at: hoursAgo(5) },
    ])
    await sendWeeklyReportNow({ DB: db as any, RESEND_API_KEY: 'x' } as any)
    expect(sentHtml).toContain('3日以上読まれていないアプリ: 1 本')
    expect(sentHtml).toContain('Forgotten &lt;App&gt; — 4日')
    expect(sentHtml).not.toContain('Recent —')
    expect(sentHtml).toContain('読む順番に偏りがあります')
  })

  it('放置がなければ「なし」と出て、注意も出ない', async () => {
    seedApps(db, [{ id: 1, name: 'Fine', streak: 1, at: hoursAgo(13) }])
    await sendWeeklyReportNow({ DB: db as any, RESEND_API_KEY: 'x' } as any)
    expect(sentHtml).toContain('3日以上読まれていないアプリ: なし')
    expect(sentHtml).not.toContain('読む順番に偏りがあります')
  })

  it('失敗した窓の理由が、多い順に件数つきで出る', async () => {
    const stats = { windows: 8, candidates: 20, rawRejected: 0, dupRejected: 5, qualityRejected: 0, signalRejected: 0, created: 5, errors: 3, existingCount: 100 }
    await recordGenerationRun(db as any, stats, [], [
      { appId: 1, message: 'Error: Unparseable model response: Sure! Here are' },
      { appId: 2, message: 'Error: Unparseable model response: Sure! Here are' },
      { appId: 3, message: 'InferenceUpstreamError: <timeout>' },
    ])
    await sendWeeklyReportNow({ DB: db as any, RESEND_API_KEY: 'x' } as any)
    expect(sentHtml).toContain('失敗した窓の理由')
    expect(sentHtml).toMatch(/2 件 — <code>Error: Unparseable model response: Sure! Here are<\/code>[\s\S]*1 件 — <code>InferenceUpstreamError: &lt;timeout&gt;<\/code>/)
  })
})
