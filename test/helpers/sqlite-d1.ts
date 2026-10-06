// ============================================================
// テスト用: 本番スキーマを載せたメモリ上の SQLite を、D1 の顔で返す
// ============================================================
//
// D1 は中身が SQLite。schema.sql と migrations/*.sql をそのまま流せば
// 本番と同じテーブルがメモリ上にできる。関数は本物の SQL を実行し、
// テストは SELECT で列名を指定して読み戻す。
//
// 以前の偽DB（bind の引数を記録するだけ）では、INSERT の列順が入れ替わっても
// 配列の位置は合うので通ってしまった。本物のテーブルなら「error_streak 列に
// 何が入ったか」を直接読めるので、その種の間違いが検出できる。
//
// 使い方:
//   const db = createTestDb()
//   await someFunction(db as any, ...)
//   db.raw.prepare('SELECT ... FROM ...').get()   ← 読み戻し
//   db.failNextBatch()                             ← 次の batch() を失敗させる
// ============================================================

import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type D1Like = {
  prepare(sql: string): any
  batch(stmts: any[]): Promise<any[]>
}

export type TestDb = D1Like & {
  raw: Database.Database
  failNextBatch(err?: Error): void
}

export function createTestDb(): TestDb {
  const raw = new Database(':memory:')

  // 本番と同じ順でスキーマを適用
  const files = [
    'schema.sql',
    ...readdirSync(join(ROOT, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => join('migrations', f)),
  ]
  for (const f of files) raw.exec(readFileSync(join(ROOT, f), 'utf8'))

  let pendingBatchError: Error | null = null

  function prepare(sql: string) {
    const stmt = raw.prepare(sql)
    let params: unknown[] = []
    const api = {
      bind(...args: unknown[]) {
        params = args
        return api
      },
      async first(column?: string) {
        const row = stmt.get(...params) as Record<string, unknown> | undefined
        return column ? row?.[column] : row ?? null
      },
      async run() {
        const r = stmt.run(...params)
        return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }
      },
      async all() {
        return { success: true, results: stmt.all(...params), meta: {} }
      },
      // batch() から同期的に実行するための内部用
      _exec() {
        if (stmt.reader) return { success: true, results: stmt.all(...params), meta: {} }
        const r = stmt.run(...params)
        return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }
      },
    }
    return api
  }

  async function batch(stmts: any[]) {
    if (pendingBatchError) {
      const e = pendingBatchError
      pendingBatchError = null
      throw e
    }
    // D1 の batch はトランザクション（全部成功か、全部なかったことに）
    const tx = raw.transaction((list: any[]) => list.map((s) => s._exec()))
    return tx(stmts)
  }

  return {
    prepare,
    batch,
    raw,
    failNextBatch(err = new Error('D1_ERROR: database is locked')) {
      pendingBatchError = err
    },
  }
}
