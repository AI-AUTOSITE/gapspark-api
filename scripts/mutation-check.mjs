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

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// ------------------------------------------------------------
// 途中で止められても、変異させたファイルを必ず元に戻す
// ------------------------------------------------------------
// 2026-10-25 に実際に起きた: 実行が途中で強制終了され、ソースが変異した状態で残った。
// 気づかずにコミットすれば、壊れたコードが本番に出る。
//   1. 変異させる前に、元の中身を BACKUP に書いておく（強制終了でも次回の最初に復元）
//   2. Ctrl+C では親プロセスを生かしたまま子（vitest）だけ止まるので、その場で戻して終わる
const BACKUP = '.mutation-backup.json'
if (existsSync(BACKUP)) {
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'))
  writeFileSync(b.file, b.original)
  unlinkSync(BACKUP)
  console.log(`⚠️  前回の実行が途中で止まっていたので、${b.file} を元に戻しました`)
}
process.on('SIGINT', () => {})    // 親は即死させない（子が止まったあと、自分で戻して終わる）
process.on('SIGTERM', () => {})
function applyMutant(file, original, mutant) {
  writeFileSync(BACKUP, JSON.stringify({ file, original }))
  writeFileSync(file, mutant)
}
function restoreFile(file, original) {
  writeFileSync(file, original)
  if (existsSync(BACKUP)) unlinkSync(BACKUP)
}
function interrupted(r) {
  return Boolean(r.signal) || r.status === 130
}

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
  {
    // 偽DB時代には検出できなかった種類。本物の SQLite で列名を読み戻すので落ちる
    file: 'src/stats.ts',
    label: 'recordGenerationError: INSERT の列順が入れ替わる（値が別の列に入る）',
    before: '        (app_id, last_attempted_at, empty_streak, window_offset, cycle_created, error_streak, updated_at)',
    after:  '        (app_id, last_attempted_at, empty_streak, error_streak, cycle_created, window_offset, updated_at)',
  },
  {
    // 認証ミドルウェアより上の行に debug ルートを足す（登録順で素通りする形）
    file: 'src/index.ts',
    label: 'debug 認証: ミドルウェアより上に debug ルートが足される',
    before: "// CORS設定（iOSアプリからのアクセス許可）\napp.use('/*', cors())",
    after:  "app.get('/api/debug/early', (c) => c.json({ ok: true }))\n// CORS設定（iOSアプリからのアクセス許可）\napp.use('/*', cors())",
  },
  {
    // /api/debug/ の外に管理用ルートを足す（パスで素通りする形）
    file: 'src/index.ts',
    label: 'debug 認証: /api/debug/ の外に admin ルートが足される',
    before: "// CORS設定（iOSアプリからのアクセス許可）\napp.use('/*', cors())",
    after:  "// CORS設定（iOSアプリからのアクセス許可）\napp.use('/*', cors())\napp.get('/api/admin/purge', (c) => c.json({ ok: true }))",
  },  {
    // 2026-10-25 に見つけた穴：モデルが2回失敗しても数えるだけで握りつぶし、窓が「空」として進む
    file: 'src/cron/generate-pain-points.ts',
    label: '生成: モデル失敗を握りつぶして窓を進める（9/30 の直し漏れ）',
    before: '            else throw e',
    after:  '            else errors++',
  },
  {
    file: 'src/cron/generate-pain-points.ts',
    label: 'ふるい: 重複で除外した数を記録しない',
    before: '    dupRejected: duplicatesSkipped,',
    after:  '    dupRejected: 0,',
  },
  {
    file: 'src/cron/generate-pain-points.ts',
    label: 'ふるい: 重複の見本を集めない',
    before: '      dupRejections.push(...appRejections.map(r => ({ ...r, appId: app.app_id })))',
    after:  '      void appRejections',
  },
]

function runTests() {
  const r = spawnSync('npx', ['vitest', 'run'], { encoding: 'utf8' })
  const m = /(\d+) failed/.exec(r.stdout + r.stderr)
  return { ok: r.status === 0, failed: m ? Number(m[1]) : 0, interrupted: interrupted(r) }
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
  applyMutant(m.file, original, original.replace(m.before, m.after))
  let result
  try {
    result = runTests()
  } finally {
    restoreFile(m.file, original)   // 何があっても必ず戻す
  }
  if (result.interrupted) {
    console.log(`\n中断しました。${m.file} は元に戻してあります。`)
    process.exit(130)
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
