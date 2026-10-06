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
// 4. 保存 — 本物の SQLite に対して
// ------------------------------------------------------------
const app: AppWithReviews & { negative_count?: number } = {
  app_id: 1, app_name: 'Test App', category: 'Productivity', tags: '[]', negative_count: 50,
}

const painPoint: ScoredPainPoint = {
  title: 'Sync fails after device sleep',
  summary: 'Changes made offline are lost when the device wakes and reconnects.',
  keywords: ['sync', 'offline', 'lost'],
  related_topics: ['sync'],
  severity: 'critical',
  ai_generated_idea: 'SafeSync — a queue that survives sleep',
  ruleBasedScore: 0.8,
  reviewCount: 50,
  matchingReviewCount: 4,
}

describe('savePainPoints: 保存の失敗は 0 ではなく例外', () => {
  let db: TestDb
  beforeEach(() => { db = createTestDb() })

  it('db.batch が落ちたら throw し、何も保存されていない', async () => {
    db.failNextBatch()
    await expect(savePainPoints(db as any, app, [painPoint])).rejects.toThrow()
    const n = db.raw.prepare('SELECT COUNT(*) AS n FROM pain_points').get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('保存できたら件数を返し、行が実際に入っている', async () => {
    const saved = await savePainPoints(db as any, app, [painPoint])
    expect(saved).toBe(1)
    const row = db.raw.prepare('SELECT title, severity_score FROM pain_points').get() as any
    expect(row.title).toBe(painPoint.title)
    expect(row.severity_score).toBeGreaterThan(0)
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

  const base = { app_id: 1, negative_count: 500, window_offset: 100, error_streak: 0, cycle_created: 0 }
  const readBack = () =>
    db.raw.prepare('SELECT window_offset, error_streak FROM app_generation_state WHERE app_id = 1').get()

  it('1回目の失敗 → 窓は動かない、error_streak=1 が列に入る', async () => {
    const r = await recordGenerationError(db as any, base, 50)
    expect(r.held).toBe(true)
    expect(readBack()).toEqual({ window_offset: 100, error_streak: 1 })
  })

  it('2回目の連続失敗 → その窓だけ飛ばす、error_streak=2（リセットされない）', async () => {
    const r = await recordGenerationError(db as any, { ...base, error_streak: 1 }, 50)
    expect(r.held).toBe(false)
    expect(readBack()).toEqual({ window_offset: 150, error_streak: 2 })
  })

  it('記録の書き込み自体が失敗しても例外にならない（生成は成功しているため）', async () => {
    db.raw.exec('DROP TABLE app_generation_state')
    await expect(recordGenerationError(db as any, base, 50)).resolves.toBeTruthy()
  })
})
