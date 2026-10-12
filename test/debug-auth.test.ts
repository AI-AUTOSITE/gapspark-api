// ============================================================
// /api/debug/* の認証 — ルート表を全部たどって確認する
// ============================================================
//
// ミドルウェア app.use('/api/debug/*', ...) は「登録順」と「パス」に依存する。
//   - このミドルウェアより上の行に debug ルートを書くと、素通りする
//   - /api/admin/... のように別の場所に作ると、素通りする
// どちらも「来月、誰かが（自分が）うっかり」起こしうる。
//
// このテストは debug ルートを手で列挙しない。Hono のルート表（app.routes）から
// 機械的に拾うので、新しく足したルートも自動で対象になる。
//
// 実行: npm test
// ============================================================

import { describe, it, expect } from 'vitest'
import worker, { app } from '../src/index'

const ctx = { waitUntil() {}, passThroughOnException() {} } as any

// 実ハンドラ（ミドルウェアではないもの）だけを取り出す
const handlers = app.routes.filter((r) => r.method !== 'ALL')
const debugRoutes = handlers.filter((r) => r.path.startsWith('/api/debug/'))

// :id のようなパラメータを埋めて、叩ける URL にする
const urlOf = (path: string) =>
  'https://example.test' + path.replace(/:[A-Za-z_]+/g, '1').replace(/\*/g, 'x')

async function call(method: string, path: string, env: Record<string, unknown>, headers: Record<string, string> = {}) {
  const req = new Request(urlOf(path), { method, headers })
  return worker.fetch(req, env as any, ctx)
}

describe('debug ルートの見張り', () => {
  it('debug ルートが1本以上見つかる（ルート表が取れている）', () => {
    // 0 本なら、このファイルの他のテストは何も確かめていないことになる
    expect(debugRoutes.length).toBeGreaterThan(0)
  })

  it('「debug」「admin」を含むルートは、すべて /api/debug/ の下にある', () => {
    // 前置詞の外に作ると、ミドルウェアが掛からない
    const outside = handlers
      .filter((r) => /debug|admin/i.test(r.path) && !r.path.startsWith('/api/debug/'))
      .map((r) => `${r.method} ${r.path}`)
    expect(outside).toEqual([])
  })
})

describe.each(debugRoutes.map((r) => [r.method, r.path] as const))('%s %s', (method, path) => {
  it('ヘッダなし → 401', async () => {
    const res = await call(method, path, { DEBUG_TOKEN: 'correct-token' })
    expect(res.status).toBe(401)
  })

  it('違うトークン → 401', async () => {
    const res = await call(method, path, { DEBUG_TOKEN: 'correct-token' }, { Authorization: 'Bearer wrong' })
    expect(res.status).toBe(401)
  })

  it('シークレット未設定 → 503（設定忘れで開かない）', async () => {
    const res = await call(method, path, {})
    expect(res.status).toBe(503)
  })
})
