// ============================================================
// 「失敗」と「空」は別の状態である — 回帰テスト
// ============================================================
//
// 2026-09 に同じ形の穴が 4 箇所見つかった:
//   fetch が失敗しても []、モデルの返答が読めなくても []、保存が落ちても 0。
//   呼び出し側はそれを「読んだが何も無かった」と解釈して先へ進み、
//   失敗した仕事は静かに消えていた。
//
// このテストは、その 4 箇所が「失敗を空に化けさせない」ことを固定する。
// 直し方が変わっても、この性質が壊れたら落ちる。
//
// 実行: npm test
// ============================================================

import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAppReviews } from '../src/cron/fetch-reviews'
import { searchHackerNews } from '../src/cron/fetch-hackernews'
import {
  parseLlamaResponse,
  savePainPoints,
  type ScoredPainPoint,
  type AppWithReviews,
} from '../src/cron/generate-pain-points'

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
// 4. 保存
// ------------------------------------------------------------

// D1 の偽物。prepare().bind().first() は信号計算用に固定値を返し、
// batch() は指定に応じて成功するか例外を投げる。
function fakeDb(opts: { batchThrows?: boolean } = {}) {
  const stmt: any = {
    bind: () => stmt,
    first: async () => ({ cnt: 5 }),
    run: async () => ({ meta: { changes: 1 } }),
    all: async () => ({ results: [] }),
  }
  return {
    prepare: () => stmt,
    batch: async (stmts: unknown[]) => {
      if (opts.batchThrows) throw new Error('D1_ERROR: database is locked')
      return stmts.map(() => ({ meta: { changes: 1 } }))
    },
  }
}

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
  it('db.batch が落ちたら throw（0 を返して「空」に化けない）', async () => {
    const db = fakeDb({ batchThrows: true })
    await expect(savePainPoints(db as any, app, [painPoint])).rejects.toThrow()
  })

  it('保存できたら件数を返す', async () => {
    const db = fakeDb()
    const saved = await savePainPoints(db as any, app, [painPoint])
    expect(saved).toBe(1)
  })
})
