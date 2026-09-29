// 運用監視: 週報 + アラートメール（Resend経由）
// 既存の6時間Cronから runMonitor() を呼ぶ設計（Cronは増やさない＝無料枠3本のまま）。
// 状態は D1 の monitor_state テーブルに保存（重複通知の防止・前回比の計算に使う）。
//
// 【2026-09-12 変更】
// getStats() が reviews を4周フルスキャンしていたため（1回あたり約82万行）、
// D1 の rows_read 無料枠を毎日超過していた。集計は stats.ts に移し、
// ここではキャッシュを1行読むだけにした。読み取りコストは行数に依存しない。
//
// 【2026-09-27 変更】週報を9月の知見に合わせて更新
//   a) 全6行に先週比を出す（以前は2行だけで、残りは「—」だった）
//   b) 「直近7日の生成数」を日別で載せる — wrangler を叩かずに確認できる
//   c) 判断表を書き換え。「増えない → アプリ追加」は9/12に誤診した行。
//      実際の原因は D1の枠超過・候補選定の空回り・モデルのコピー・静的な窓で、
//      どれも材料切れではなかった。「増えない → 先にパイプラインを疑う」に変更。
//   d) 空振り（empty_streak）の分布と窓の回転状況も載せる

import { readCachedStats, type Counts } from './stats'

type MonitorEnv = {
  DB: D1Database
  RESEND_API_KEY: string
}

// 通知先 / 送信元（変更したい場合はここ）
const ALERT_EMAIL = 'mxsf5216@yahoo.co.jp'
const FROM_EMAIL = 'onboarding@resend.dev'

// しきい値（前回決めた条件）
const ANALYZED_DONE_RATIO = 0.90  // 分析90%で「ほぼ完了」とみなす
const PP_FLAT_DAYS = 3            // ペインポイントが3日増えない → 掘り尽くしサイン
const ALERT_COOLDOWN_DAYS = 7     // 同じアラートを再送しない間隔（日）

type Stats = {
  total: number
  analyzed: number
  negative: number
  positive: number
  painPoints: number
  trackedApps: number
}

// stats_cache から1行読むだけ（重い集計はしない）。
// Cron から counts を渡された場合はその値を使う（DBアクセスを1回節約）。
async function getStats(db: D1Database, provided?: Counts): Promise<Stats> {
  const c = provided ?? (await readCachedStats(db)).counts
  return {
    total: c.total,
    analyzed: c.analyzed,
    negative: c.negative,
    positive: c.positive,
    painPoints: c.pain_points,
    trackedApps: c.tracked_apps,
  }
}

async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM monitor_state WHERE key = ?').bind(key).first<Record<string, string>>()
  return row?.value ?? null
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(`
    INSERT INTO monitor_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).bind(key, value).run()
}

// Resend でメール送信
async function sendEmail(apiKey: string, subject: string, html: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: ALERT_EMAIL, subject, html }),
    })
    if (!res.ok) {
      console.error('Resend send failed:', res.status, await res.text())
      return false
    }
    return true
  } catch (e) {
    console.error('Resend send error:', e)
    return false
  }
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

function daysBetween(dateStr: string, today: string): number {
  const a = new Date(dateStr + 'T00:00:00Z').getTime()
  const b = new Date(today + 'T00:00:00Z').getTime()
  return Math.round((b - a) / 86400000)
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

// ===== 直近7日の生成数（日別） =====
// pain_points は数百行なので、全件スキャンでも無視できるコスト。
// 欠けた日は 0 で埋める — 「0の日」が見えることが、この表の目的。
type TrendRow = { d: string; n: number }

async function getGenerationTrend(db: D1Database): Promise<TrendRow[]> {
  const counts = new Map<string, number>()
  try {
    const res = await db.prepare(`
      SELECT date(created_at) AS d, COUNT(*) AS n
      FROM pain_points
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY d
    `).all<{ d: string; n: number }>()
    for (const r of res.results ?? []) counts.set(r.d, Number(r.n) || 0)
  } catch (e) {
    console.error('getGenerationTrend failed:', e)
  }

  const rows: TrendRow[] = []
  for (let i = 0; i < 7; i++) {
    const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    rows.push({ d: dt, n: counts.get(dt) ?? 0 })
  }
  return rows // 今日 → 6日前
}

// ===== パイプラインの健全性（空振り分布・窓の回転） =====
// app_generation_state は約100行。テーブルが無い環境でも落ちないよう try/catch。
type PipelineHealth = {
  streaks: { streak: number; apps: number }[]
  rotating: number    // window_offset > 0 のアプリ数
  maxOffset: number
  total: number
  broken: { app_name: string; error_streak: number }[]   // 連続エラー3回以上
}

async function getPipelineHealth(db: D1Database): Promise<PipelineHealth> {
  const out: PipelineHealth = { streaks: [], rotating: 0, maxOffset: 0, total: 0, broken: [] }
  try {
    const st = await db.prepare(`
      SELECT empty_streak AS streak, COUNT(*) AS apps
      FROM app_generation_state GROUP BY empty_streak ORDER BY empty_streak
    `).all<{ streak: number; apps: number }>()
    out.streaks = (st.results ?? []).map(r => ({ streak: Number(r.streak), apps: Number(r.apps) }))

    const rot = await db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN window_offset > 0 THEN 1 ELSE 0 END) AS rotating,
        COALESCE(MAX(window_offset), 0) AS max_offset
      FROM app_generation_state
    `).first<{ total: number; rotating: number; max_offset: number }>()
    out.total = Number(rot?.total) || 0
    out.rotating = Number(rot?.rotating) || 0
    out.maxOffset = Number(rot?.max_offset) || 0

    // 「乾いている」ではなく「壊れている」アプリを名前つきで出す
    const br = await db.prepare(`
      SELECT ta.app_name AS app_name, g.error_streak AS error_streak
      FROM app_generation_state g
      JOIN tracked_apps ta ON ta.id = g.app_id
      WHERE g.error_streak >= 3
      ORDER BY g.error_streak DESC
      LIMIT 10
    `).all<{ app_name: string; error_streak: number }>()
    out.broken = (br.results ?? []).map(r => ({ app_name: r.app_name, error_streak: Number(r.error_streak) }))
  } catch (e) {
    console.error('getPipelineHealth failed:', e)
  }
  return out
}

// ===== HTML部品 =====

function delta(cur: number, prev: number | null | undefined): string {
  if (prev == null) return '—'
  const d = cur - prev
  if (d === 0) return '±0'
  return (d > 0 ? '+' : '') + fmt(d)
}

function trendTableHtml(trend: TrendRow[]): string {
  const rows = trend.map((r, i) => {
    const zero = r.n === 0
    const label = i === 0 ? `${r.d}（今日・集計途中）` : r.d
    const style = zero && i > 0 ? ' style="color:#c00;font-weight:bold"' : ''
    return `<tr><td>${label}</td><td${style}>${r.n}</td></tr>`
  }).join('')
  return `
  <h3>直近7日の生成数</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">
    <tr style="background:#f0f0f0"><th>日付（UTC）</th><th>新規ペインポイント</th></tr>
    ${rows}
  </table>
  <p style="font-size:12px;color:#666">赤い 0 が2日以上続いたら、下の「パイプラインの確認」へ。</p>`
}

function healthTableHtml(h: PipelineHealth): string {
  if (h.total === 0) return ''
  const streakRows = h.streaks.map(r => `<tr><td>${r.streak}回</td><td>${r.apps}</td></tr>`).join('')
  const brokenHtml = h.broken.length === 0
    ? `<p style="font-size:13px">連続エラー3回以上のアプリ: なし</p>`
    : `<p style="font-size:13px;color:#c00"><b>連続エラー3回以上のアプリ（壊れている可能性）:</b></p>
       <ul style="font-size:13px;color:#c00">${h.broken.map(b => `<li>${b.app_name} — ${b.error_streak}回連続</li>`).join('')}</ul>`
  return `
  <h3>パイプラインの状態</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">
    <tr style="background:#f0f0f0"><th>連続空振り（1周まるごと）</th><th>アプリ数</th></tr>
    ${streakRows}
  </table>
  <p style="font-size:13px">窓の回転: ${h.rotating} / ${h.total} アプリが途中の窓を読んでいる（最大 offset ${fmt(h.maxOffset)}）</p>
  ${brokenHtml}`
}

function decisionTableHtml(): string {
  return `
  <h3>判断表（数字の見方）</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">
    <tr style="background:#f0f0f0"><th>数字</th><th>状態</th><th>やること</th></tr>
    <tr><td rowspan="2">分析の進捗</td><td>90%未満</td><td>何もしない（ファストレーンが自動で消化）</td></tr>
    <tr><td>90%以上</td><td>正常。分析が取得に追いついている</td></tr>
    <tr><td rowspan="2">直近7日の生成</td><td>毎日出ている</td><td>何もしない</td></tr>
    <tr><td>0の日が続く</td><td><b>先に「パイプラインの確認」</b>（下）。材料切れと決めるのはその後</td></tr>
    <tr><td rowspan="2">連続空振り</td><td>0〜1回が大半</td><td>正常。窓を回転して掘っている</td></tr>
    <tr><td>3回以上が大半</td><td>1周しても出ないアプリが多い。窓が薄いか、重複除去が厳しすぎる可能性</td></tr>
    <tr><td rowspan="2">連続エラー</td><td>なし</td><td>正常</td></tr>
    <tr><td>3回以上のアプリあり</td><td>そのアプリは「乾いている」のではなく「壊れている」。自動で待機に入るが、原因（レビュー取得・Workers AI）は人が見る</td></tr>
    <tr><td rowspan="2">レビュー取得（GitHub Actions）</td><td>緑✅が続く</td><td>OK（6時間ごとに自動取得）</td></tr>
    <tr><td>赤❌が出た</td><td>失敗通知メールが届く。Actionsログを確認（CFトークン失効・Apple側障害などを疑う）</td></tr>
  </table>

  <h3>パイプラインの確認（アプリを足す前に）</h3>
  <ol style="font-size:14px">
    <li><code>curl https://gapspark-api.pricedrop-app.workers.dev/api/health</code><br>
        → <code>stats_updated_at</code> が6時間以内か（cronが動いているか）</li>
    <li><code>curl "https://gapspark-api.pricedrop-app.workers.dev/api/debug/generate-pain-points?apps=1"</code><br>
        → <code>errors</code> が 0 か。<code>rawCopiesRejected</code> が異常に多くないか（生成自体が通るか）</li>
    <li>Cloudflare Dashboard → D1 → gapspark-db → Metrics<br>
        → 読み取りが枠内か（9月1日と同じ枠超過ではないか）</li>
  </ol>
  <p style="font-size:12px;color:#666">9月に「増えない」が出たとき、原因は材料切れではなく上の3つでした。この順で見てから判断する。</p>`
}

type PrevStats = Partial<Record<keyof Stats, number>>

function weeklyReportHtml(stats: Stats, prev: PrevStats, trend: TrendRow[], health: PipelineHealth): string {
  const ratio = stats.total > 0 ? Math.round((stats.analyzed / stats.total) * 100) : 0

  // 今日を除いた直近6日で、0の日が何日あるか
  const zeroDays = trend.slice(1).filter(r => r.n === 0).length
  const weekTotal = trend.reduce((a, r) => a + r.n, 0)
  const stuckApps = health.streaks.filter(r => r.streak >= 3).reduce((a, r) => a + r.apps, 0)
  const stuckRatio = health.total > 0 ? stuckApps / health.total : 0

  let recommend = `OK 順調です。直近7日で ${fmt(weekTotal)} 件のペインポイントが生成されています。GitHub Actions が6時間ごとにレビューを取得し、分析・生成まで自動で回っています。何もしなくて大丈夫。`
  if (health.broken.length > 0) {
    recommend = `注意: ${health.broken.length} 件のアプリが連続でエラーになっています（下の「パイプラインの状態」に名前あり）。材料切れではなく故障です。そのアプリのレビュー取得か、Workers AI 側の状態を確認してください。他のアプリの生成は続いています。`
  } else if (zeroDays >= 2) {
    recommend = `注意: 直近6日のうち ${zeroDays} 日、生成がゼロでした。<b>アプリを足す前に</b>、下の「パイプラインの確認」を上から順に見てください。9月に同じ症状が出たとき、原因は材料切れではなく D1 の枠超過でした。`
  } else if (stuckRatio >= 0.6) {
    recommend = `注意: ${stuckApps} / ${health.total} アプリが「1周まるごと空振り」を3回以上続けています。生成は動いていますが、窓が薄いか重複除去が厳しすぎる可能性があります。生成されたタイトルの質を目視で確認してください。`
  }

  return `
  <div style="font-family:sans-serif;max-width:640px">
    <h2>GapSpark 週次レポート</h2>
    <p>${todayUTC()} 時点の状況です。</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      <tr style="background:#f0f0f0"><th>項目</th><th>現在</th><th>先週比</th></tr>
      <tr><td>追跡アプリ数</td><td>${fmt(stats.trackedApps)}</td><td>${delta(stats.trackedApps, prev.trackedApps)}</td></tr>
      <tr><td>総レビュー</td><td>${fmt(stats.total)}</td><td>${delta(stats.total, prev.total)}</td></tr>
      <tr><td>分析済み</td><td>${fmt(stats.analyzed)}（${ratio}%）</td><td>${delta(stats.analyzed, prev.analyzed)}</td></tr>
      <tr><td>ネガティブ</td><td>${fmt(stats.negative)}</td><td>${delta(stats.negative, prev.negative)}</td></tr>
      <tr><td>ポジティブ</td><td>${fmt(stats.positive)}</td><td>${delta(stats.positive, prev.positive)}</td></tr>
      <tr><td>ペインポイント</td><td>${fmt(stats.painPoints)}</td><td>${delta(stats.painPoints, prev.painPoints)}</td></tr>
    </table>
    <h3>今やること</h3>
    <p>${recommend}</p>
    ${trendTableHtml(trend)}
    ${healthTableHtml(health)}
    ${decisionTableHtml()}
    <hr>
    <p style="color:#888;font-size:12px">GapSpark 運用監視より自動送信</p>
  </div>`
}

function alertHtml(title: string, body: string, stats: Stats, trend: TrendRow[]): string {
  const ratio = stats.total > 0 ? Math.round((stats.analyzed / stats.total) * 100) : 0
  return `
  <div style="font-family:sans-serif;max-width:640px">
    <h2>[GapSpark アラート] ${title}</h2>
    <p>${body}</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      <tr><td>分析済み</td><td>${fmt(stats.analyzed)} / ${fmt(stats.total)}（${ratio}%）</td></tr>
      <tr><td>ペインポイント</td><td>${fmt(stats.painPoints)}</td></tr>
    </table>
    ${trendTableHtml(trend)}
    ${decisionTableHtml()}
    <hr>
    <p style="color:#888;font-size:12px">GapSpark 運用監視より自動送信</p>
  </div>`
}

// 先週の値を monitor_state から読む／保存する（全6項目）
const REPORT_KEYS: { key: keyof Stats; state: string }[] = [
  { key: 'trackedApps', state: 'report_apps' },
  { key: 'total',       state: 'report_total' },
  { key: 'analyzed',    state: 'report_analyzed' },
  { key: 'negative',    state: 'report_negative' },
  { key: 'positive',    state: 'report_positive' },
  { key: 'painPoints',  state: 'report_pain_points' },
]

async function loadPrevReport(db: D1Database): Promise<PrevStats> {
  const prev: PrevStats = {}
  for (const { key, state } of REPORT_KEYS) {
    const v = await getState(db, state)
    if (v != null) prev[key] = parseInt(v)
  }
  return prev
}

async function savePrevReport(db: D1Database, stats: Stats): Promise<void> {
  for (const { key, state } of REPORT_KEYS) {
    await setState(db, state, String(stats[key]))
  }
}

// ===== メインの監視ロジック（6時間Cronから呼ぶ） =====
// 自分で時間ゲート（日曜のみ週報）と重複防止（cooldown）を行うので、
// 6時間ごとに毎回呼んでも、メールは必要なときだけ送られる。
//
// counts: Cron が refreshStatsCache() で計算した値を渡す（省略時はキャッシュを読む）
export async function runMonitor(env: MonitorEnv, counts?: Counts): Promise<Record<string, unknown>> {
  const db = env.DB
  const today = todayUTC()
  const stats = await getStats(db, counts)

  // キャッシュがまだ無い（デプロイ直後など）ときは何もしない。
  // ゼロのまま進めると「分析が止まっている」の誤アラートが飛ぶため。
  if (stats.total === 0) {
    return {
      today,
      skipped: 'stats cache is empty — /api/debug/refresh-stats を1回叩くか、次のCronを待ってください',
    }
  }

  const ratio = stats.total > 0 ? stats.analyzed / stats.total : 0
  const actions: string[] = []

  // 前回チェック時の分析済み数（ストール検知用）
  const prevAnalyzedStr = await getState(db, 'last_analyzed_count')
  const prevAnalyzed = prevAnalyzedStr != null ? parseInt(prevAnalyzedStr) : null

  // ペインポイントの最終増加日を追跡（停滞検知用）
  const ppLastStr = await getState(db, 'pp_last_value')
  const ppLast = ppLastStr != null ? parseInt(ppLastStr) : null
  let ppChangeDate = await getState(db, 'pp_last_change_date')
  if (ppLast == null || stats.painPoints > ppLast) {
    await setState(db, 'pp_last_value', String(stats.painPoints))
    await setState(db, 'pp_last_change_date', today)
    ppChangeDate = today
  }
  const ppFlatDays = ppChangeDate ? daysBetween(ppChangeDate, today) : 0

  // ===== 1. 週報（日曜のみ・1日1通） =====
  const isSunday = new Date().getUTCDay() === 0 // 0=日曜(UTC)
  const lastReport = await getState(db, 'last_weekly_report')
  if (isSunday && lastReport !== today) {
    const prev = await loadPrevReport(db)
    const trend = await getGenerationTrend(db)
    const health = await getPipelineHealth(db)
    const html = weeklyReportHtml(stats, prev, trend, health)
    if (await sendEmail(env.RESEND_API_KEY, 'GapSpark 週次レポート', html)) {
      await setState(db, 'last_weekly_report', today)
      await savePrevReport(db, stats)
      actions.push('weekly_report_sent')
    }
  }

  // ===== 2. 停滞アラート（分析90%以上 かつ ペインポイントが3日以上増えてない） =====
  // 【変更】以前は「掘り尽くし → アプリ追加」と断定していたが、9月の実例では
  // 原因は D1 の枠超過だった。断定せず、確認手順へ誘導する文面に変更。
  if (ratio >= ANALYZED_DONE_RATIO && ppFlatDays >= PP_FLAT_DAYS) {
    const last = await getState(db, 'last_exhaustion_alert')
    if (!last || daysBetween(last, today) >= ALERT_COOLDOWN_DAYS) {
      const trend = await getGenerationTrend(db)
      const html = alertHtml(
        'ペインポイントが増えていません',
        `分析は${Math.round(ratio * 100)}%まで進んでいますが、ペインポイントが${ppFlatDays}日間増えていません。<b>アプリを足す前に</b>、下の「パイプラインの確認」を上から順に見てください。9月に同じ症状が出たとき、原因は材料切れではなく D1 の読み取り枠の超過でした。3つとも問題なければ、そのときは本当に材料切れです。`,
        stats,
        trend
      )
      if (await sendEmail(env.RESEND_API_KEY, 'GapSpark: ペインポイントが増えていません', html)) {
        await setState(db, 'last_exhaustion_alert', today)
        actions.push('exhaustion_alert_sent')
      }
    }
  }

  // ===== 3. ストール（異常）アラート（バックログが残るのに分析が増えていない） =====
  if (prevAnalyzed != null && ratio < 0.99 && stats.analyzed <= prevAnalyzed) {
    const last = await getState(db, 'last_stall_alert')
    if (!last || daysBetween(last, today) >= ALERT_COOLDOWN_DAYS) {
      const trend = await getGenerationTrend(db)
      const html = alertHtml(
        'データ収集が止まっているかも',
        `前回チェック時（${fmt(prevAnalyzed)}件）から分析済みレビューが増えていません（現在 ${fmt(stats.analyzed)}件）。まだ未分析が残っているのに進んでいないため、Cron停止やエラーの可能性があります。wrangler tail でログ確認をおすすめします。`,
        stats,
        trend
      )
      if (await sendEmail(env.RESEND_API_KEY, 'GapSpark: 分析が止まっているかも', html)) {
        await setState(db, 'last_stall_alert', today)
        actions.push('stall_alert_sent')
      }
    }
  }

  // 次回のストール比較用に、今回の分析済み数を保存
  await setState(db, 'last_analyzed_count', String(stats.analyzed))
  await setState(db, 'last_check_at', new Date().toISOString())

  return { today, stats, ratioPercent: Math.round(ratio * 100), ppFlatDays, actions }
}

// ===== デバッグ用（手動で叩いてメール確認） =====

// 単純なテストメール（Resendが動くかの確認）
export async function sendTestEmail(env: MonitorEnv): Promise<boolean> {
  return sendEmail(
    env.RESEND_API_KEY,
    'GapSpark テストメール',
    '<p>これは GapSpark 運用監視のテストメールです。届いていれば設定OKです。</p>'
  )
}

// 週報を今すぐ送る（中身の確認用。状態は更新しない）
// キャッシュ + 数百行のテーブルを読むだけなので、何回叩いてもD1のコストは小さい。
export async function sendWeeklyReportNow(env: MonitorEnv): Promise<boolean> {
  const stats = await getStats(env.DB)
  const prev = await loadPrevReport(env.DB)
  const trend = await getGenerationTrend(env.DB)
  const health = await getPipelineHealth(env.DB)
  const html = weeklyReportHtml(stats, prev, trend, health)
  return sendEmail(env.RESEND_API_KEY, 'GapSpark 週次レポート（テスト送信）', html)
}
