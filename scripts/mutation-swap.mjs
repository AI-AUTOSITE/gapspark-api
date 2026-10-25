#!/usr/bin/env node
// ============================================================
// 列入れ替えミューテーション — INSERT の列リストの全ペアを機械生成して検査する
// ============================================================
//
// mutation-check.mjs は「私が選んだ」ミューテーション。こちらは選ばない。
// テスト対象の INSERT 文の列リストから、全ての2列の組を機械的に入れ替えて
// スイートを走らせる。緑のまま残った組は、次のどれか:
//   (a) 等価: 両列が同じ式で埋まる（例: 両方 datetime('now')）。入れ替えても同じ行。
//       → 検出不能で、テストの欠陥ではない。EQUIVALENT に明示して除外する
//   (b) fixture 衝突: 両列が偶然同じ値（例: 両方 0）。種値を変えれば落ちる
//   (c) 未検証: その列を誰も読み戻していない。read-back に足せば落ちる
// (b)(c) はテストの穴。0 になるまで直す。
//
// 使い方:  npm run test:swap
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

// 検査する INSERT 文。file と、列リストを一意に特定できる先頭部分
const TARGETS = [
  {
    file: 'src/stats.ts',
    label: 'recordGenerationError → app_generation_state',
    columns: '(app_id, last_attempted_at, empty_streak, window_offset, cycle_created, error_streak, updated_at)',
    // 両方 datetime('now') で埋まる。入れ替えても同じ行になる＝等価
    equivalent: [['last_attempted_at', 'updated_at']],
  },
  {
    file: 'src/cron/generate-pain-points.ts',
    label: 'savePainPoints → pain_points',
    columns: '(category, title, summary, severity_score, frequency, sample_app_ids, keywords, related_topics, ai_generated_idea, mention_count, sample_size, ai_model_used, last_updated_at)',
    equivalent: [],
  },
  {
    file: 'src/cron/generate-pain-points.ts',
    label: 'recordGenerationRun → generation_runs',
    columns: '(windows, candidates, raw_rejected, dup_rejected, quality_rejected, signal_rejected, created, errors, existing_count)',
    equivalent: [],
  },
  {
    file: 'src/cron/generate-pain-points.ts',
    label: 'recordGenerationRun → rejected_duplicates',
    columns: '(app_id, candidate_title, matched_title, kind, score)',
    equivalent: [],
  },
]

let lastRunInterrupted = false
function runTests() {
  const r = spawnSync('npx', ['vitest', 'run'], { encoding: 'utf8' })
  lastRunInterrupted = interrupted(r)
  return r.status === 0
}

function pairs(list) {
  const out = []
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]])
  return out
}

if (!runTests()) {
  console.error('❌ ミューテーション前のテストが通っていません。先に直してください。')
  process.exit(1)
}

let totalPairs = 0, caught = 0, survived = [], skippedEquivalent = 0

for (const t of TARGETS) {
  const original = readFileSync(t.file, 'utf8')
  if (!original.includes(t.columns)) {
    console.log(`⚠️  ${t.label}: 列リストが見つかりません（変更された？ TARGETS を更新）`)
    process.exit(1)
  }
  const cols = t.columns.slice(1, -1).split(',').map((s) => s.trim())
  const eq = new Set(t.equivalent.map(([a, b]) => [a, b].sort().join('|')))

  console.log(`\n${t.label}  —  ${cols.length} 列 → ${pairs(cols).length} ペア`)
  for (const [a, b] of pairs(cols)) {
    totalPairs++
    const key = [a, b].sort().join('|')
    if (eq.has(key)) { skippedEquivalent++; continue }

    const swapped = cols.map((c) => (c === a ? b : c === b ? a : c))
    const mutant = original.replace(t.columns, '(' + swapped.join(', ') + ')')
    applyMutant(t.file, original, mutant)
    let ok
    try { ok = runTests() } finally { restoreFile(t.file, original) }
    if (lastRunInterrupted) {
      console.log(`\n中断しました。${t.file} は元に戻してあります。`)
      process.exit(130)
    }
    if (ok) {
      survived.push(`${t.label}: ${a} ⇄ ${b}`)
      console.log(`  🟢 ${a} ⇄ ${b}   ← 緑のまま`)
    } else {
      caught++
    }
  }
}

console.log(`\n${'─'.repeat(60)}`)
console.log(`ペア総数 ${totalPairs} / 検出 ${caught} / 等価として除外 ${skippedEquivalent} / 緑のまま ${survived.length}`)
console.log(`復元確認: ${runTests() ? '✅ 元どおり通る' : '❌ 復元に失敗'}`)
if (survived.length) {
  console.log(`\n❌ 緑のまま（テストの穴）:\n  ${survived.join('\n  ')}`)
  process.exit(1)
}
console.log('\n✅ 等価以外の全ペアで、入れ替えるとテストが落ちます。')
