// 運用監視: 週報 + アラートメール（Resend経由）
// 既存の6時間Cronから runMonitor() を呼ぶ設計（Cronは増やさない＝無料枠3本のまま）。
// 状態は D1 の monitor_state テーブルに保存（重複通知の防止・前回比の計算に使う）。
//
// 【2026-09-12 変更】
// getStats() が reviews を4周フルスキャンしていたため（1回あたり約82万行）、
// D1 の rows_read 無料枠を毎日超過していた。集計は stats.ts に移し、
// ここではキャッシュを1行読むだけにした。読み取りコストは行数に依存しない。

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

function decisionTableHtml(): string {
  return `
  <h3>判断表（数字の見方）</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">
    <tr style="background:#f0f0f0"><th>数字</th><th>状態</th><th>やること</th></tr>
    <tr><td rowspan="2">分析の進捗</td><td>90%未満</td><td>何もしない（ファストレーンが自動で消化）</td></tr>
    <tr><td>90%以上</td><td>正常。分析が取得に追いついている状態</td></tr>
    <tr><td rowspan="2">新規ペインポイント</td><td>まだ増えてる</td><td>何もしない（既存アプリをまだ掘れている）</td></tr>
    <tr><td>数日増えない</td><td>掘り尽くしサイン。apps_to_track.json にアプリ名を足してコミット → 自動で追加・取得・分析</td></tr>
    <tr><td rowspan="2">レビュー取得（GitHub Actions）</td><td>緑✅が続く</td><td>OK（正常。6時間ごとに自動取得）</td></tr>
    <tr><td>赤❌が出た</td><td>失敗通知メールが届く。Actionsログを確認（CFトークン失効・Apple側障害などを疑う）</td></tr>
  </table>`
}

function weeklyReportHtml(stats: Stats, prevAnalyzed: number | null, prevPP: number | null): string {
  const ratio = stats.total > 0 ? Math.round((stats.analyzed / stats.total) * 100) : 0
  const dAnalyzed = prevAnalyzed != null ? stats.analyzed - prevAnalyzed : null
  const dPP = prevPP != null ? stats.painPoints - prevPP : null

  // 推奨文（実態に合わせて更新）：
  // レビュー取得は GitHub Actions で自動化済み。分析が追いついているのは正常。
  // 成長のレバーは「追跡アプリを増やす」= apps_to_track.json に名前を足すこと。
  let recommend = 'OK 順調です。GitHub Actions が6時間ごとにレビューを取得し、分析・ペイン生成まで自動で回っています。何もしなくて大丈夫。'
  if (dPP != null && dPP <= 0 && ratio >= 90) {
    recommend = '注意: 分析は追いついていますが、ペインポイントが増えていません。既存アプリを掘り尽くしたサインです。GitHubリポジトリの apps_to_track.json に新しいアプリ名を足してコミットすると、自動で追加・取得・分析されます（成長のレバー）。'
  }

  return `
  <div style="font-family:sans-serif;max-width:640px">
    <h2>GapSpark 週次レポート</h2>
    <p>${todayUTC()} 時点の状況です。</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      <tr style="background:#f0f0f0"><th>項目</th><th>現在</th><th>先週比</th></tr>
      <tr><td>追跡アプリ数</td><td>${fmt(stats.trackedApps)}</td><td>—</td></tr>
      <tr><td>総レビュー</td><td>${fmt(stats.total)}</td><td>—</td></tr>
      <tr><td>分析済み</td><td>${fmt(stats.analyzed)}（${ratio}%）</td><td>${dAnalyzed != null ? '+' + fmt(dAnalyzed) : '—'}</td></tr>
      <tr><td>ネガティブ</td><td>${fmt(stats.negative)}</td><td>—</td></tr>
      <tr><td>ポジティブ</td><td>${fmt(stats.positive)}</td><td>—</td></tr>
      <tr><td>ペインポイント</td><td>${fmt(stats.painPoints)}</td><td>${dPP != null ? '+' + fmt(dPP) : '—'}</td></tr>
    </table>
    <h3>今やること</h3>
    <p>${recommend}</p>
    ${decisionTableHtml()}
    <hr>
    <p style="color:#888;font-size:12px">GapSpark 運用監視より自動送信</p>
  </div>`
}

function alertHtml(title: string, body: string, stats: Stats): string {
  const ratio = stats.total > 0 ? Math.round((stats.analyzed / stats.total) * 100) : 0
  return `
  <div style="font-family:sans-serif;max-width:640px">
    <h2>[GapSpark アラート] ${title}</h2>
    <p>${body}</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      <tr><td>分析済み</td><td>${fmt(stats.analyzed)} / ${fmt(stats.total)}（${ratio}%）</td></tr>
      <tr><td>ペインポイント</td><td>${fmt(stats.painPoints)}</td></tr>
    </table>
    ${decisionTableHtml()}
    <hr>
    <p style="color:#888;font-size:12px">GapSpark 運用監視より自動送信</p>
  </div>`
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

  // ペインポイントの最終増加日を追跡（掘り尽くし検知用）
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
    const prevRepAnalyzed = await getState(db, 'report_analyzed')
    const prevRepPP = await getState(db, 'report_pain_points')
    const html = weeklyReportHtml(
      stats,
      prevRepAnalyzed != null ? parseInt(prevRepAnalyzed) : null,
      prevRepPP != null ? parseInt(prevRepPP) : null
    )
    if (await sendEmail(env.RESEND_API_KEY, 'GapSpark 週次レポート', html)) {
      await setState(db, 'last_weekly_report', today)
      await setState(db, 'report_analyzed', String(stats.analyzed))
      await setState(db, 'report_pain_points', String(stats.painPoints))
      actions.push('weekly_report_sent')
    }
  }

  // ===== 2. 掘り尽くしアラート（分析90%以上 かつ ペインポイントが3日以上増えてない） =====
  if (ratio >= ANALYZED_DONE_RATIO && ppFlatDays >= PP_FLAT_DAYS) {
    const last = await getState(db, 'last_exhaustion_alert')
    if (!last || daysBetween(last, today) >= ALERT_COOLDOWN_DAYS) {
      const html = alertHtml(
        'アプリ追加 or 新データ源の時期です',
        `分析が${Math.round(ratio * 100)}%まで進み、ペインポイントが${ppFlatDays}日間増えていません。今のアプリからは新しいペインポイントがほぼ出尽くした可能性があります。Apple RSS は最新フィードのみで過去分は取れないため、「Hacker News など新データ源の取得」か「アプリ追加」を検討してください。`,
        stats
      )
      if (await sendEmail(env.RESEND_API_KEY, 'GapSpark: アプリ追加/新データ源の時期です', html)) {
        await setState(db, 'last_exhaustion_alert', today)
        actions.push('exhaustion_alert_sent')
      }
    }
  }

  // ===== 3. ストール（異常）アラート（バックログが残るのに分析が増えていない） =====
  if (prevAnalyzed != null && ratio < 0.99 && stats.analyzed <= prevAnalyzed) {
    const last = await getState(db, 'last_stall_alert')
    if (!last || daysBetween(last, today) >= ALERT_COOLDOWN_DAYS) {
      const html = alertHtml(
        'データ収集が止まっているかも',
        `前回チェック時（${fmt(prevAnalyzed)}件）から分析済みレビューが増えていません（現在 ${fmt(stats.analyzed)}件）。まだ未分析が残っているのに進んでいないため、Cron停止やエラーの可能性があります。wrangler tail でログ確認をおすすめします。`,
        stats
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
// キャッシュを読むだけなので、何回叩いてもD1の読み取りコストは増えない。
export async function sendWeeklyReportNow(env: MonitorEnv): Promise<boolean> {
  const stats = await getStats(env.DB)
  const prevRepAnalyzed = await getState(env.DB, 'report_analyzed')
  const prevRepPP = await getState(env.DB, 'report_pain_points')
  const html = weeklyReportHtml(
    stats,
    prevRepAnalyzed != null ? parseInt(prevRepAnalyzed) : null,
    prevRepPP != null ? parseInt(prevRepPP) : null
  )
  return sendEmail(env.RESEND_API_KEY, 'GapSpark 週次レポート（テスト送信）', html)
}
