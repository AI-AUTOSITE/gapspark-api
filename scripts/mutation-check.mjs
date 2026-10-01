#!/usr/bin/env node
// ============================================================
// ミューテーションチェック — 「修正を戻したらテストが落ちるか」を機械的に確かめる
// ============================================================
//
// テストが通っていることと、テストが何かを守っていることは別。
// 修正を1つ戻してもスイートが緑のままなら、その修正は誰にも守られていない。
// 2026-09-30 に手でやって、1箇所が緑のままだった（error_streak を DB に書く値を
// 誰も見ていなかった）。手作業は一度きりの監査で終わるので、ここに残す。
//
// 使い方:  npm run test:mutate
// 追加:    「失敗を空に化けさせない」修正を足したら、MUTATIONS に1行足す。
//          before = 修正後のコード（今の状態）、after = 修正前に戻した形。
//
// 各ミューテーションを適用 → vitest 実行 → 復元。1つでも緑のままなら exit 1。
// ============================================================

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MUTATIONS = [
  {
    file: 'src/cron/fetch-reviews.ts',
    label: 'fetch-reviews: HTTP エラーが [] に戻る',
    before: 'return { ok: false, status: res.status, message: `HTTP ${res.status}` }',
    after:  'return { ok: true, reviews: [] }',
  },
  {
    file: 'src/cron/fetch-reviews.ts',
    label: 'fetch-reviews: 例外が [] に戻る',
    before: 'return { ok: false, status: null, message: String(e).substring(0, 200) }',
    after:  'return { ok: true, reviews: [] }',
  },
  {
    file: 'src/cron/fetch-hackernews.ts',
    label: 'hackernews: HTTP エラーが [] に戻る',
    before: 'console.error(`  HN HTTP ${res.status} for "${brand}"`)\n      return null',
    after:  'console.error(`  HN HTTP ${res.status} for "${brand}"`)\n      return []',
  },
  {
    file: 'src/cron/fetch-hackernews.ts',
    label: 'hackernews: 例外が [] に戻る',
    before: 'console.error(`  HN fetch error for "${brand}":`, e)\n    return null',
    after:  'console.error(`  HN fetch error for "${brand}":`, e)\n    return []',
  },
  {
    file: 'src/cron/generate-pain-points.ts',
    label: 'parse: 読めない返答が [] に戻る',
    before: 'throw new Error(`Unparseable model response: ${cleaned.substring(0, 80)}`)',
    after:  'return []',
  },
  {
    file: 'src/cron/generate-pain-points.ts',
    label: 'save: 保存失敗が 0 に戻る',
    before: 'console.error(`  DB insert error for ${app.app_name}:`, e)\n    throw e',
    after:  'console.error(`  DB insert error for ${app.app_name}:`, e)\n    return 0',
  },
  {
    file: 'src/stats.ts',
    label: 'recordGenerationError: 窓を保持しなくなる',
    before: '  const skip = errors % MAX_ERRORS_PER_WINDOW === 0   // 2回ごとに1窓飛ばす',
    after:  '  const skip = true',
  },
  {
    file: 'src/stats.ts',
    label: 'recordGenerationError: error_streak を DB に書かなくなる',
    before: '      app.app_id, nextOffset, nextCycleCreated, errors,\n      nextOffset, nextCycleCreated, errors',
    after:  '      app.app_id, nextOffset, nextCycleCreated, 0,\n      nextOffset, nextCycleCreated, 0',
  },
]

function runTests() {
  const r = spawnSync('npx', ['vitest', 'run'], { encoding: 'utf8' })
  const m = /(\d+) failed/.exec(r.stdout + r.stderr)
  return { ok: r.status === 0, failed: m ? Number(m[1]) : 0 }
}

// まず素の状態で通ることを確認（通らなければ判定できない）
const baseline = runTests()
if (!baseline.ok) {
  console.error('❌ ミューテーション前のテストが通っていません。先に直してください。')
  process.exit(1)
}

let survived = 0
console.log(`\n${MUTATIONS.length} 件のミューテーションを順に適用します\n`)
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  if (!original.includes(m.before)) {
    console.log(`  ⚠️  ${m.label}\n      → 対象コードが見つかりません（修正の形が変わった？ MUTATIONS を更新してください）`)
    survived++
    continue
  }
  writeFileSync(m.file, original.replace(m.before, m.after))
  let result
  try {
    result = runTests()
  } finally {
    writeFileSync(m.file, original)   // 何があっても必ず戻す
  }
  if (result.ok) {
    console.log(`  🟢 ${m.label}\n      → 緑のまま。この修正は誰にも守られていません`)
    survived++
  } else {
    console.log(`  🔴 ${m.label}（${result.failed} 本落ちた）`)
  }
}

const after = runTests()
console.log(`\n復元確認: ${after.ok ? '✅ 元どおり通る' : '❌ 復元に失敗。git status を確認してください'}`)

if (survived > 0) {
  console.log(`\n❌ ${survived} 件が緑のまま。テストが足りません。`)
  process.exit(1)
}
console.log(`\n✅ ${MUTATIONS.length} 件すべて、戻すとテストが落ちます。`)
