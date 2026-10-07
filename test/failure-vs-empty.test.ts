// ============================================================
// 「失敗」と「空」は別の状態である — 回帰テスト
// ============================================================
//
// 2026-09 に同じ形の穴が 5 箇所見つかった:
//   fetch が失敗しても []、モデルの返答が読めなくても []、保存が落ちても 0。
//   呼び出し側はそれを「読んだが何も無かった」と解釈して先へ進み、
//   失敗した仕事は静かに消えていた。
//
// このテストは、その箇所が「失敗を空に化けさせない」ことを固定する。
// 直し方が変わっても、この性質が壊れたら落ちる。
//
// DB を触るテストは、本番スキーマを載せたメモリ上の SQLite に対して
// 本物の SQL を流し、列名で読み戻す（test/helpers/sqlite-d1.ts）。
//
// 実行:         npm test
// 守りの確認:   npm run test:mutate（修正を1つずつ戻して、落ちることを確認）
// ============================================================

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { fetchAppReviews } from '../src/cron/fetch-reviews'
import { searchHackerNews } from '../src/cron/fetch-hackernews'
import {
  parseLlamaResponse,
  savePainPoints,
  type ScoredPainPoint,
  type AppWithReviews,
} from '../src/cron/generate-pain-points'
import { recordGenerationError } from '../src/stats'
import { createTestDb, type TestDb } from './helpers/sqlite-d1'

afterEach(() => {
  vi.unstubAllGlobals()
})

// fetch の偽物。status と body を指定して Response を返す
function fakeFetch(status: number, body: unknown = '') {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  })))
}

// fetch が例外を投げる偽物（DNS 失敗・タイムアウトなど）
function fakeFetchThrows(message = 'fetch failed') {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(message) }))
}

// ------------------------------------------------------------
// 1. App Store レビュー取得
// ------------------------------------------------------------
describe('fetchAppReviews: HTTP エラーは空リストではなく失敗として返る', () => {
  it('500 → ok:false, status:500', async () => {
    fakeFetch(500, 'Internal Server Error')
    const r = await fetchAppReviews('916366645')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(500)
  })

  it('403（レート制限）→ ok:false, status:403', async () => {
    fakeFetch(403, 'Forbidden')
    const r = await fetchAppReviews('916366645')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
  })

  it('ネットワーク例外 → ok:false, status:null', async () => {
    fakeFetchThrows()
    const r = await fetchAppReviews('916366645')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBeNull()
  })

  it('200 なのに本文が JSON でない（エラーページ等）→ ok:false', async () => {
    // ステータスは正常でも本文が読めなければ「取れた」とは言えない。
    // HN で catch 側しか直っていなかったのと同じ形の分岐。
    fakeFetch(200, '<html>Service Unavailable</html>')
    const r = await fetchAppReviews('916366645')
    expect(r.ok).toBe(false)
  })

  it('本当に空（メタデータ1件のみ）→ ok:true, reviews:[]', async () => {
    // Apple の RSS は先頭にアプリのメタデータが入る。レビュー0件ならそれだけ
    fakeFetch(200, { feed: { entry: [{ 'im:name': { label: 'App' } }] } })
    const r = await fetchAppReviews('916366645')
    expect(r).toEqual({ ok: true, reviews: [] })
  })

  it('レビューあり → ok:true, reviews に中身', async () => {
    fakeFetch(200, { feed: { entry: [
      { 'im:name': { label: 'App' } },
      { id: { label: 'r1' }, 'im:rating': { label: '1' }, title: { label: 'Crashes' }, content: { label: 'It crashes on launch' } },
    ] } })
    const r = await fetchAppReviews('916366645')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.reviews).toHaveLength(1)
  })
})

// ------------------------------------------------------------
// 2. Hacker News 検索
// ------------------------------------------------------------
describe('searchHackerNews: 失敗は null、該当なしは []', () => {
  it('429 → null', async () => {
    fakeFetch(429, 'Too Many Requests')
    expect(await searchHackerNews('Notion', 20)).toBeNull()
  })

  it('例外 → null', async () => {
    fakeFetchThrows()
    expect(await searchHackerNews('Notion', 20)).toBeNull()
  })

  it('200 なのに本文が JSON でない → null', async () => {
    fakeFetch(200, '<html>maintenance</html>')
    expect(await searchHackerNews('Notion', 20)).toBeNull()
  })

  it('ヒット0件 → []（null ではない）', async () => {
    fakeFetch(200, { hits: [] })
    expect(await searchHackerNews('Notion', 20)).toEqual([])
  })
})

// ------------------------------------------------------------
// 3. モデル返答の解析
// ------------------------------------------------------------
describe('parseLlamaResponse: 読めない返答は例外、該当なしは []', () => {
  it('JSON ではない文章 → throw', () => {
    expect(() => parseLlamaResponse('Sure! Here are the pain points I found:')).toThrow()
  })

  it('空文字 → throw', () => {
    expect(() => parseLlamaResponse('')).toThrow()
  })

  it('{"pain_points":[]} → []（モデルが「該当なし」と答えた）', () => {
    expect(parseLlamaResponse('{"pain_points":[]}')).toEqual([])
  })

  it('前置きが付いていても JSON 配列は拾える', () => {
    const body = JSON.stringify([{
      title: 'App freezes when opening large files',
      summary: 'Users report the app locks up on files over 100MB, forcing a restart.',
      keywords: ['freeze', 'large', 'files'],
      related_topics: ['performance'],
      severity: 'high',
      ai_generated_idea: 'LiteOpen — a viewer that streams large files',
    }])
    const parsed = parseLlamaResponse('Here you go:\n' + body)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].title).toBe('App freezes when opening large files')
  })
})

// ------------------------------------------------------------
// 4. 保存 — 本物の SQLite に対して、全列を読み戻す
// ------------------------------------------------------------
// 列の入れ替えミューテーション（npm run test:swap）で、13列×78ペアのうち
// 56ペアが緑のまま残った。title と severity_score しか読み戻していなかったので、
// 他の11列は何が入っても通っていた。今は全列を期待値と比べる。
//
// 種値は全列で違う値にする。2列が同じ値だと、入れ替えても同じ行になり、
// 入れ替わっていることを検出できない。

// 日付列は値ではなく形で確認する（datetime('now') の結果）
const DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

const app: AppWithReviews & { negative_count?: number } = {
  app_id: 7, app_name: 'Test App', category: 'Productivity', tags: '[]', negative_count: 50,
}

const painPoint: ScoredPainPoint = {
  title: 'Sync fails after device sleep',
  summary: 'Changes made offline are lost when the device wakes and reconnects.',
  keywords: ['sync', 'offline', 'lost'],
  related_topics: ['connectivity'],
  severity: 'critical',
  ai_generated_idea: 'SafeSync — a queue that survives sleep',
  ruleBasedScore: 0.8,    // → severity_score
  reviewCount: 50,        // → frequency
  matchingReviewCount: 4,
}

// 信号計算（mention_count / sample_size）のための種レビュー。
// ネガティブ5件のうち2件がキーワードに該当 → mention_count=2, sample_size=5。
// 該当しない3件は sync/offline/lost/fails/device/sleep を含まない文にする
// （LIKE '%lost%' は "almost" にも当たるので、部分文字列にも注意）。
// ポジティブ1件は数えられないことの確認用。
function seedReviews(db: TestDb) {
  db.raw.exec(`INSERT INTO tracked_apps (id, apple_id, app_name, category) VALUES (7, '777', 'Test App', 'Productivity')`)
  const ins = db.raw.prepare(`
    INSERT INTO reviews (tracked_app_id, review_id, rating, title, body, region, sentiment_score, sentiment_label)
    VALUES (7, ?, ?, ?, ?, 'us', ?, ?)`)
  ins.run('r1', 1, 'Broken again', 'Sync drops every time the phone goes idle', -0.9, 'NEGATIVE')
  ins.run('r2', 2, 'Data gone', 'Changes made offline vanish', -0.8, 'NEGATIVE')
  ins.run('r3', 1, 'Pricing', 'Price went up again this month', -0.7, 'NEGATIVE')
  ins.run('r4', 2, 'Ads', 'Too many ads on the home tab', -0.6, 'NEGATIVE')
  ins.run('r5', 1, 'Font', 'Font is tiny on the settings page', -0.5, 'NEGATIVE')
  ins.run('r6', 5, 'Great', 'Sync works great now', 0.9, 'POSITIVE')
}

describe('savePainPoints: 保存の失敗は 0 ではなく例外', () => {
  let db: TestDb
  beforeEach(() => { db = createTestDb(); seedReviews(db) })

  it('db.batch が落ちたら throw し、何も保存されていない', async () => {
    db.failNextBatch()
    await expect(savePainPoints(db as any, app, [painPoint])).rejects.toThrow()
    const n = db.raw.prepare('SELECT COUNT(*) AS n FROM pain_points').get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('保存できたら件数を返し、全列が期待どおりの値で入っている', async () => {
    const saved = await savePainPoints(db as any, app, [painPoint])
    expect(saved).toBe(1)

    const row = db.raw.prepare('SELECT * FROM pain_points').get() as Record<string, unknown>
    const { id, created_at, last_updated_at, ...rest } = row
    expect(rest).toEqual({
      category: 'Productivity',
      title: painPoint.title,
      summary: painPoint.summary,
      severity_score: 0.8,
      frequency: 50,
      sample_app_ids: '[7]',
      keywords: '["sync","offline","lost"]',
      related_topics: '["connectivity"]',
      ai_generated_idea: painPoint.ai_generated_idea,
      mention_count: 2,
      sample_size: 5,
      ai_model_used: 'workers-ai-mistral-small-3.1-24b',
    })
    expect(id).toBe(1)
    expect(created_at).toMatch(DATETIME)
    expect(last_updated_at).toMatch(DATETIME)
  })
})

// ------------------------------------------------------------
// 5. 失敗の「その後」— 窓は保持され、エラーは記録される
// ------------------------------------------------------------
// 4 の throw は入口にすぎない。呼び出し側は例外を受けて recordGenerationError を
// 呼ぶ。そこで「窓を進めない」「error_streak を刻む」が起きて初めて、失敗した
// 結果は救われる。ここを固定する。
//
// 本物の UPSERT を流し、列名で読み戻す。以前は偽DBの bind 引数を見ていたが、
// INSERT の列順が入れ替わっても配列の位置は合うので通ってしまった。
// 列名で読めば、それは通らない。
describe('recordGenerationError: 失敗した窓は保持され、連続回数が保存される', () => {
  let db: TestDb
  beforeEach(() => { db = createTestDb() })

  // 種値は全列で違う値に（app_id=7, cycle_created=3）。以前は app_id=1 /
  // cycle_created=0 で、error_streak=1 や empty_streak=0 と同じ値になり、
  // その列を入れ替えても検出できなかった。
  const base = { app_id: 7, negative_count: 500, window_offset: 100, error_streak: 0, cycle_created: 3 }

  // 全列を読み戻す。日付列は形で、残りは値で確認する
  const readBack = () => {
    const row = db.raw.prepare('SELECT * FROM app_generation_state WHERE app_id = 7').get() as Record<string, unknown>
    const { last_attempted_at, last_created_at, updated_at, ...rest } = row
    expect(last_attempted_at).toMatch(DATETIME)
    expect(updated_at).toMatch(DATETIME)
    expect(last_created_at).toBeNull()   // エラー記録では「生まれた時刻」は触らない
    return rest
  }

  it('1回目の失敗 → 窓は動かない、error_streak=1、他の列はそのまま', async () => {
    const r = await recordGenerationError(db as any, base, 50)
    expect(r.held).toBe(true)
    expect(readBack()).toEqual({ app_id: 7, empty_streak: 0, window_offset: 100, cycle_created: 3, error_streak: 1 })
  })

  it('2回目の連続失敗 → その窓だけ飛ばす、error_streak=2（リセットされない）', async () => {
    const r = await recordGenerationError(db as any, { ...base, error_streak: 1 }, 50)
    expect(r.held).toBe(false)
    expect(readBack()).toEqual({ app_id: 7, empty_streak: 0, window_offset: 150, cycle_created: 3, error_streak: 2 })
  })

  it('記録の書き込み自体が失敗しても例外にならない（生成は成功しているため）', async () => {
    db.raw.exec('DROP TABLE app_generation_state')
    await expect(recordGenerationError(db as any, base, 50)).resolves.toBeTruthy()
  })
})
