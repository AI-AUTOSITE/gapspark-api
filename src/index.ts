import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { fetchAndStoreReviews, deepBackfillReviews } from './cron/fetch-reviews'
import { fetchHackerNewsMentions, runHackerNewsCron } from './cron/fetch-hackernews'
import { analyzeSentiment } from './cron/analyze-sentiment'
import { generatePainPoints, deduplicateExistingPainPoints, recalculateSeverityScores, cleanupWeaklySupportedPainPoints, backfillMentionSignal, backfillRelatedTopics, backfillIdeaTitles } from './cron/generate-pain-points'
import { getDeepDive, getCachedDeepDive, getDeepDivedPainPointIds, checkDeepDiveLimit, recordDeepDiveUsage } from './deep-dive'
import { unifiedSearch, getPopularTopics, getAppsByTopic, getPainPointsByTopic } from './search'
import { handleAppleAuth, authMiddleware, type AuthVariables } from './auth'
import { runMonitor, sendTestEmail, sendWeeklyReportNow } from './monitor'
import { recordDailySnapshot, getDashboardData } from './dashboard'
import { verifySubscription, applyProEntitlement, getUserSubscription, handleAppStoreNotification } from './subscription'

// Cloudflare Workers の環境変数型定義
type Bindings = {
  DB: D1Database
  AI: Ai
  CLAUDE_API_KEY: string
  JWT_SECRET: string        // 自前JWT署名用シークレット
  APPLE_BUNDLE_ID: string   // Apple Bundle ID（例: com.gapspark.app）
  RESEND_API_KEY: string    // Resend APIキー（運用監視メール用・secret）
  // ↓ サブスク検証（App Store Server API）。すべて wrangler secret put で設定
  APPSTORE_ISSUER_ID: string   // App Store Connect API の Issuer ID
  APPSTORE_KEY_ID: string      // 生成したAPIキーの Key ID
  APPSTORE_PRIVATE_KEY: string // .p8 の中身（PEM全体）
}

const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>()

// CORS設定（iOSアプリからのアクセス許可）
app.use('/*', cors())

// ========================================
// ヘルスチェック
// ========================================
app.get('/', (c) => {
  return c.json({
    name: 'GapSpark API',
    version: '1.0.0',
    status: 'running'
  })
})

app.get('/api/health', async (c) => {
  try {
    // 4つのCOUNTを1往復のbatchでまとめて実行（順次awaitより高速）
    // ※ JSONのキーは従来どおり（iOSのHealthStatsがそのままデコードできる）
    const stats = await c.env.DB.batch([
      c.env.DB.prepare('SELECT COUNT(*) as count FROM tracked_apps'),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM reviews'),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM reviews WHERE sentiment_score IS NOT NULL'),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM pain_points'),
    ])

    return c.json({
      status: 'ok',
      database: 'connected',
      tracked_apps: (stats[0].results?.[0] as any)?.count ?? 0,
      reviews: (stats[1].results?.[0] as any)?.count ?? 0,
      reviews_analyzed: (stats[2].results?.[0] as any)?.count ?? 0,
      pain_points: (stats[3].results?.[0] as any)?.count ?? 0
    })
  } catch (error) {
    return c.json({
      status: 'error',
      database: 'disconnected',
      message: String(error)
    }, 500)
  }
})

// ========================================
// Public API（認証不要）
// ========================================
// ========================================
// 統合検索 + トピック API
// ========================================

// 統合検索: /api/search?q=pdf → Topics + Apps + Pain Points を同時返却
app.get('/api/search', async (c) => {
  try {
    const q = c.req.query('q') || ''
    
    if (!q.trim()) {
      // 検索クエリが空 → 人気トピックを返す（検索バーフォーカス時の表示用）
      const topics = await getPopularTopics(c.env.DB)
      return c.json({ query: '', topics, apps: [], pain_points: [] })
    }

    const result = await unifiedSearch(c.env.DB, q)
    return c.json(result)
  } catch (error) {
    console.error('Search error:', error)
    return c.json({ error: String(error) }, 500)
  }
})

// 人気トピック一覧（Discoverタブのチップ表示用）
app.get('/api/topics', async (c) => {
  try {
    const topics = await getPopularTopics(c.env.DB)
    return c.json({ topics })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// トピック別アプリ一覧（トピックチップをタップ時）
app.get('/api/topics/:topic/apps', async (c) => {
  try {
    const topic = decodeURIComponent(c.req.param('topic'))
    const apps = await getAppsByTopic(c.env.DB, topic)
    return c.json({ topic, apps })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// トピック別ペインポイント一覧（トピックチップをタップ時）
app.get('/api/topics/:topic/pain-points', async (c) => {
  try {
    const topic = decodeURIComponent(c.req.param('topic'))
    const painPoints = await getPainPointsByTopic(c.env.DB, topic)
    return c.json({ topic, pain_points: painPoints })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/pain-points', async (c) => {
  try {
    const { category, limit } = c.req.query()
    const pageLimit = Math.min(parseInt(limit || '20'), 50)

    let query = `SELECT * FROM pain_points`
    const params: any[] = []

    if (category) {
      query += ` WHERE category = ?`
      params.push(category)
    }

    query += ` ORDER BY severity_score DESC, frequency DESC LIMIT ?`
    params.push(pageLimit)

    const stmt = c.env.DB.prepare(query).bind(...params)
    const result = await stmt.all()
    return c.json({ pain_points: result.results })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// Deep Dive済みのペインポイントID一覧（Discoverの「Analyzed」バッジ用・認証不要）
// ※ /:id より前に登録すること（"deep-dived-ids" が :id に食われないように）
app.get('/api/pain-points/deep-dived-ids', async (c) => {
  try {
    const ids = await getDeepDivedPainPointIds(c.env.DB)
    return c.json({ ids })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('deep-dived-ids error:', error)
    return c.json({ error: 'Failed to fetch analyzed IDs', detail: message }, 500)
  }
})

app.get('/api/pain-points/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const painPoint = await c.env.DB.prepare(
      'SELECT * FROM pain_points WHERE id = ?'
    ).bind(id).first()

    if (!painPoint) return c.json({ error: 'Pain point not found' }, 404)
    return c.json({ pain_point: painPoint })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/apps', async (c) => {
  try {
    const { category } = c.req.query()
    let query = 'SELECT * FROM tracked_apps'
    const params: string[] = []
    if (category) {
      query += ' WHERE category = ?'
      params.push(category)
    }
    query += ' ORDER BY app_name ASC'
    const stmt = params.length > 0
      ? c.env.DB.prepare(query).bind(...params)
      : c.env.DB.prepare(query)
    const result = await stmt.all()
    return c.json({ apps: result.results })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/apps/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const app = await c.env.DB.prepare(
      'SELECT * FROM tracked_apps WHERE id = ?'
    ).bind(id).first()
    if (!app) return c.json({ error: 'App not found' }, 404)
    return c.json({ app })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/apps/:id/pain-points', async (c) => {
  try {
    const id = c.req.param('id')

    // このアプリに関連するペインポイントを取得
    // sample_app_ids は JSON配列 → json_each で検索
    const result = await c.env.DB.prepare(`
      SELECT pp.* FROM pain_points pp
      WHERE EXISTS (
        SELECT 1 FROM json_each(pp.sample_app_ids) 
        WHERE json_each.value = ?
      )
      ORDER BY pp.severity_score DESC
    `).bind(parseInt(id)).all()

    return c.json({ pain_points: result.results })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/categories', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      'SELECT DISTINCT category, COUNT(*) as app_count FROM tracked_apps GROUP BY category ORDER BY category'
    ).all()
    return c.json({ categories: result.results })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/trends', async (c) => {
  try {
    // 最新のペインポイント（severity高い順）
    const result = await c.env.DB.prepare(`
      SELECT * FROM pain_points 
      ORDER BY severity_score DESC, last_updated_at DESC 
      LIMIT 20
    `).all()
    return c.json({ trends: result.results })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ダッシュボード用の集計データ（公開・読み取り専用）
// サブドメインのダッシュボードHTMLがここを取得して表示する。
// 既存の app.use('/*', cors()) によりCORSは許可済み（読み取り専用・認証情報なし）。
app.get('/api/dashboard', async (c) => {
  try {
    const data = await getDashboardData(c.env.DB)
    return c.json(data)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ========================================
// 認証エンドポイント
// ========================================

// Sign in with Apple — トークン検証 → ユーザー作成/更新 → JWT発行
app.post('/api/auth/apple', async (c) => {
  try {
    const body = await c.req.json()
    const result = await handleAppleAuth(
      c.env.DB,
      c.env.JWT_SECRET,
      c.env.APPLE_BUNDLE_ID,
      body
    )
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Apple auth error:', message)

    if (message.includes('identityToken is required')) {
      return c.json({ error: message }, 400)
    }
    if (message.includes('Apple token validation failed')) {
      return c.json({ error: 'Authentication failed', detail: message }, 401)
    }
    return c.json({ error: 'Authentication failed', detail: message }, 500)
  }
})

// ========================================
// Authenticated API（認証ミドルウェア適用）
// ========================================

// Deep Dive（認証必須 — 実ユーザーIDでレート制限）
app.get('/api/pain-points/:id/deep-dive', async (c, next) => {
  // 認証ミドルウェアをインラインで適用
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const painPointId = parseInt(c.req.param('id'))
    if (isNaN(painPointId)) {
      return c.json({ error: 'Invalid pain point ID' }, 400)
    }

    const userId = c.get('userId')

    // 使用回数チェック（1日3回制限）
    const limit = await checkDeepDiveLimit(c.env.DB, userId)
    if (!limit.allowed) {
      return c.json({
        error: 'Daily Deep Dive limit reached',
        used: limit.used,
        limit: limit.limit,
        message: 'You have used all 3 free Deep Dives today. Resets at midnight UTC.'
      }, 429)
    }

    // Deep Dive 実行（キャッシュ優先）
    const { result, cached } = await getDeepDive(
      c.env.DB,
      c.env.CLAUDE_API_KEY,
      painPointId
    )

    // キャッシュヒット（再表示）はカウントしない。新規生成のときだけ1回記録する。
    if (!cached) {
      await recordDeepDiveUsage(c.env.DB, userId)
    }

    // キャッシュヒット時はカウント増えないので used も remaining も据え置き。
    // Pro（limit=-1）は常に無制限。
    const increment = cached ? 0 : 1
    const remaining = limit.limit < 0 ? -1 : limit.limit - limit.used - increment

    return c.json({
      deep_dive: result,
      cached,
      usage: {
        used: limit.used + increment,
        limit: limit.limit,
        remaining
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'Pain point not found') {
      return c.json({ error: message }, 404)
    }
    console.error('Deep Dive error:', error)
    return c.json({ error: 'Deep Dive analysis failed', detail: message }, 500)
  }
})

// 分析済みDeep Diveをキャッシュから返す（カウントも生成もしない。UIの「分析済み」判定・再表示用）
// 未分析なら deep_dive: null を返す。
app.get('/api/pain-points/:id/deep-dive/cached', async (c, next) => {
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const painPointId = parseInt(c.req.param('id'))
    if (isNaN(painPointId)) {
      return c.json({ error: 'Invalid pain point ID' }, 400)
    }

    const result = await getCachedDeepDive(c.env.DB, painPointId)
    return c.json({ deep_dive: result })   // 未分析なら null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Deep Dive cached fetch error:', error)
    return c.json({ error: 'Failed to fetch cached Deep Dive', detail: message }, 500)
  }
})

// フリープランの残り回数（Deep Diveボタン付近の表示用・認証必須）
// Pro は limit=-1 / remaining=-1（無制限）を返す。
app.get('/api/user/deep-dive-usage', async (c, next) => {
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const userId = c.get('userId')
    const limit = await checkDeepDiveLimit(c.env.DB, userId)
    const remaining = limit.limit < 0 ? -1 : Math.max(0, limit.limit - limit.used)
    return c.json({ used: limit.used, limit: limit.limit, remaining, pro: limit.pro })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('deep-dive-usage error:', error)
    return c.json({ error: 'Failed to fetch usage', detail: message }, 500)
  }
})

// App Store Server Notifications V2（Appleがサブスクの更新/解約/返金/失効を通知してくる）
// 認証なし（Appleが叩くため）。署名の代わりに App Store Server API で再検証して users を同期する。
// 一時的な処理失敗時は 500 を返して Apple に再送させる（それ以外は 200）。
// このURLを App Store Connect → App Information → App Store Server Notifications に登録する。
app.post('/api/apple/notifications', async (c) => {
  let body: { signedPayload?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (!body?.signedPayload) {
    return c.json({ error: 'Missing signedPayload' }, 400)
  }

  try {
    const result = await handleAppStoreNotification(c.env.DB, c.env, body.signedPayload)
    return c.json({ ok: true, ...result }) // 200
  } catch (error) {
    console.error('App Store notification processing failed (will retry):', error)
    return c.json({ ok: false }, 500) // Apple が再送
  }
})

// 保存したアイデア取得（認証必須）
app.get('/api/user/saved', async (c, next) => {
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const userId = c.get('userId')
    const result = await c.env.DB.prepare(
      `SELECT si.*, pp.title as pain_point_title, pp.category
       FROM saved_ideas si
       LEFT JOIN pain_points pp ON pp.id = si.pain_point_id
       WHERE si.user_id = ?
       ORDER BY si.created_at DESC`
    ).bind(userId).all()
    return c.json({ saved_ideas: result.results })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// アイデア保存（認証必須）
app.post('/api/user/saved', async (c, next) => {
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const userId = c.get('userId')
    const body = await c.req.json()
    
    if (!body.idea_title) {
      return c.json({ error: 'idea_title is required' }, 400)
    }

    const result = await c.env.DB.prepare(
      `INSERT INTO saved_ideas (user_id, pain_point_id, idea_title, idea_description, idea_prompt, source)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      userId,
      body.pain_point_id || null,
      body.idea_title,
      body.idea_description || null,
      body.idea_prompt || null,
      body.source || 'workers_ai'
    ).run()

    return c.json({ 
      message: 'Idea saved', 
      id: result.meta?.last_row_id 
    }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// 保存アイデア削除（認証必須）
app.delete('/api/user/saved/:id', async (c, next) => {
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const userId = c.get('userId')
    const ideaId = c.req.param('id')

    // 自分のアイデアのみ削除可能
    const result = await c.env.DB.prepare(
      'DELETE FROM saved_ideas WHERE id = ? AND user_id = ?'
    ).bind(ideaId, userId).run()

    if (result.meta?.changes === 0) {
      return c.json({ error: 'Idea not found or not owned by you' }, 404)
    }

    return c.json({ message: 'Idea deleted' })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// アカウント削除（認証必須） - Apple Guideline 5.1.1(v) 対応
// ログイン中ユーザーに紐づく全データ + ユーザー本体を完全に削除する。
// 一時停止ではなく完全削除（Appleの要件）。
app.delete('/api/user/account', async (c, next) => {
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const userId = c.get('userId')

    // 子テーブル → users 本体 の順で一括削除（db.batch でまとめて実行）
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM saved_ideas WHERE user_id = ?').bind(userId),
      c.env.DB.prepare('DELETE FROM deep_dive_usage WHERE user_id = ?').bind(userId),
      c.env.DB.prepare('DELETE FROM app_requests WHERE user_id = ?').bind(userId),
      c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    ])

    return c.json({ message: 'Account deleted' })
  } catch (error) {
    console.error('Account deletion error:', error)
    return c.json({ error: 'Account deletion failed', detail: String(error) }, 500)
  }
})

// アプリ追跡リクエスト（認証必須）
app.post('/api/apps/request', async (c, next) => {
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const userId = c.get('userId')
    const body = await c.req.json()

    if (!body.app_name) {
      return c.json({ error: 'app_name is required' }, 400)
    }

    const result = await c.env.DB.prepare(
      `INSERT INTO app_requests (user_id, app_name, app_store_url, reason, status)
       VALUES (?, ?, ?, ?, 'pending')`
    ).bind(
      userId,
      body.app_name,
      body.app_store_url || null,
      body.reason || null
    ).run()

    return c.json({ 
      message: 'App request submitted', 
      id: result.meta?.last_row_id,
      status: 'pending'
    }, 201)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ユーザーのリクエスト一覧（認証必須）
app.get('/api/user/requests', async (c, next) => {
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const userId = c.get('userId')
    const result = await c.env.DB.prepare(
      'SELECT * FROM app_requests WHERE user_id = ? ORDER BY created_at DESC'
    ).bind(userId).all()
    return c.json({ requests: result.results })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ========================================
// サブスクリプション（GapSpark Pro）
// ========================================

// 購入した権利をサーバーに同期（認証必須）
// iOS が transactionId + jws + environment を送る → App Store Server API で検証 → Pro反映
app.post('/api/user/subscription', async (c, next) => {
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const userId = c.get('userId')
    const body = await c.req.json() as {
      transaction_id?: string
      jws?: string
      environment?: string
    }

    if (!body.transaction_id) {
      return c.json({ error: 'transaction_id is required' }, 400)
    }

    // App Store Server API で検証
    const verified = await verifySubscription(
      c.env,
      body.transaction_id,
      body.environment || 'Production'
    )

    // 有効なら Pro を反映（無効なら何もしない = 保存済み期限で自動判定）
    if (verified.active) {
      await applyProEntitlement(c.env.DB, userId, verified)
    }

    const status = await getUserSubscription(c.env.DB, userId)
    return c.json(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Subscription sync error:', message)
    return c.json({ error: 'Subscription verification failed', detail: message }, 500)
  }
})

// サブスク状態の取得（認証必須）
app.get('/api/user/subscription', async (c, next) => {
  const mw = authMiddleware(c.env.JWT_SECRET)
  return mw(c, next)
}, async (c) => {
  try {
    const userId = c.get('userId')
    const status = await getUserSubscription(c.env.DB, userId)
    return c.json(status)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ========================================
// デバッグ用エンドポイント（手動テスト）
// ========================================

// 1. レビュー取得（既存）
app.get('/api/debug/fetch-reviews', async (c) => {
  console.log('Manual review fetch triggered')
  const result = await fetchAndStoreReviews(c.env.DB)
  return c.json({
    message: 'Review fetch completed',
    ...result
  })
})

// 深掘りバックフィル（過去分レビュー pages 2+ の一度きりキャッチアップ）
// signal backfill と同じチャンク方式。?offset= を進めて done=true まで繰り返す。
app.get('/api/debug/deep-fetch', async (c) => {
  const offset = parseInt(c.req.query('offset') || '0') || 0
  console.log(`Deep fetch backfill triggered (offset=${offset})`)
  const result = await deepBackfillReviews(c.env.DB, offset)
  return c.json({
    message: 'Deep fetch chunk completed',
    ...result
  })
})

// Hacker News からアプリ言及コメントを取得（Apple RSS とは別の新データ源）
// reviews に region='hackernews' で保存 → 既存の sentiment / pain-point パイプラインが自動処理。
// チャンク方式: ?offset= を進めて done=true まで繰り返す。
app.get('/api/debug/fetch-hn', async (c) => {
  const offset = parseInt(c.req.query('offset') || '0') || 0
  console.log(`Hacker News fetch triggered (offset=${offset})`)
  const result = await fetchHackerNewsMentions(c.env.DB, offset)
  return c.json({
    message: 'Hacker News fetch chunk completed',
    ...result
  })
})

// 2. 感情分析（NEW）
app.get('/api/debug/analyze-sentiment', async (c) => {
  console.log('Manual sentiment analysis triggered')
  // デフォルトは安全な40件（レート制限の内側）。batch でも limit でも指定可。
  // 大きい値を渡すとレート制限に当たり大量エラーになるので注意。
  const batchSize = parseInt(c.req.query('batch') || c.req.query('limit') || '40')
  const result = await analyzeSentiment(c.env.DB, c.env.AI, batchSize)
  return c.json({
    message: 'Sentiment analysis completed',
    ...result
  })
})

// 3. ペインポイント生成（NEW）
app.get('/api/debug/generate-pain-points', async (c) => {
  console.log('Manual pain point generation triggered')
  const appsPerRun = parseInt(c.req.query('apps') || '10')
  const result = await generatePainPoints(c.env.DB, c.env.AI, appsPerRun)
  return c.json({
    message: 'Pain point generation completed',
    ...result
  })
})

// 監視: テストメール（Resendが動くかの確認。叩くと即送信）
app.get('/api/debug/send-test-email', async (c) => {
  const sent = await sendTestEmail(c.env)
  return c.json({ sent })
})

// 監視: 週報を今すぐ送る（中身の確認用。叩くと即送信）
app.get('/api/debug/send-weekly-report', async (c) => {
  const sent = await sendWeeklyReportNow(c.env)
  return c.json({ sent })
})

// 監視: 監視ロジックを今すぐ実行（評価結果をJSONで返す。条件を満たせばメール送信）
app.get('/api/debug/run-monitor', async (c) => {
  const result = await runMonitor(c.env)
  return c.json(result)
})

// ダッシュボード: スナップショットを今すぐ記録（推移グラフ用・手動テスト）
// 初回はこれを1回叩いておくと、推移グラフに最初の点が入る。
app.get('/api/debug/record-snapshot', async (c) => {
  const recorded = await recordDailySnapshot(c.env.DB)
  return c.json({ recorded })
})

// 4. 全パイプライン実行（NEW — Cronと同じ処理を手動実行）
app.get('/api/debug/run-pipeline', async (c) => {
  console.log('Manual full pipeline triggered')

  // Step 1: レビュー取得
  const fetchResult = await fetchAndStoreReviews(c.env.DB)
  console.log('Step 1 (fetch) done:', JSON.stringify(fetchResult))

  // Step 2: 感情分析（新しいレビューのみ）
  const sentimentResult = await analyzeSentiment(c.env.DB, c.env.AI, 500)
  console.log('Step 2 (sentiment) done:', JSON.stringify(sentimentResult))

  // Step 3: ペインポイント生成
  const painPointResult = await generatePainPoints(c.env.DB, c.env.AI, 10)
  console.log('Step 3 (pain points) done:', JSON.stringify(painPointResult))

  return c.json({
    message: 'Full pipeline completed',
    steps: {
      fetch_reviews: fetchResult,
      analyze_sentiment: sentimentResult,
      generate_pain_points: painPointResult
    }
  })
})

// 5. DB統計情報（NEW）
app.get('/api/debug/stats', async (c) => {
  try {
    const stats = await c.env.DB.batch([
      c.env.DB.prepare('SELECT COUNT(*) as count FROM tracked_apps'),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM reviews'),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM reviews WHERE sentiment_score IS NOT NULL'),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM reviews WHERE sentiment_label = ?').bind('NEGATIVE'),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM reviews WHERE sentiment_label = ?').bind('POSITIVE'),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM pain_points'),
    ])

    return c.json({
      tracked_apps: (stats[0].results?.[0] as any)?.count ?? 0,
      total_reviews: (stats[1].results?.[0] as any)?.count ?? 0,
      analyzed_reviews: (stats[2].results?.[0] as any)?.count ?? 0,
      negative_reviews: (stats[3].results?.[0] as any)?.count ?? 0,
      positive_reviews: (stats[4].results?.[0] as any)?.count ?? 0,
      pain_points: (stats[5].results?.[0] as any)?.count ?? 0,
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// 6. 既存ペインポイントの重複クリーンアップ（NEW）
app.get('/api/debug/dedup-pain-points', async (c) => {
  console.log('Manual pain point deduplication triggered')
  const result = await deduplicateExistingPainPoints(c.env.DB)
  return c.json({
    message: 'Deduplication completed',
    ...result
  })
})

// 8. 既存ペインポイントのseverity_scoreをルールベースで再計算
app.get('/api/debug/recalculate-severity', async (c) => {
  console.log('Manual severity recalculation triggered')
  const result = await recalculateSeverityScores(c.env.DB)
  return c.json({
    message: 'Severity recalculation completed',
    ...result
  })
})

// 9. 弱信号ペインポイントのクリーンアップ（2件未満の裏付けを削除）
//    安全のためデフォルトは dry run（削除せず件数だけ表示）。
//    実際に削除するには ?confirm=true を付ける。
app.get('/api/debug/cleanup-weak-pain-points', async (c) => {
  const confirm = c.req.query('confirm') === 'true'
  console.log(`Weak-signal cleanup triggered (confirm=${confirm})`)
  const result = await cleanupWeaklySupportedPainPoints(c.env.DB, !confirm)
  return c.json({
    message: confirm
      ? 'Weak-signal pain points deleted'
      : 'DRY RUN — nothing deleted. Add ?confirm=true to actually delete.',
    ...result
  })
})

// 10. 案B: 信号強度(mention_count / sample_size)を既存ペインに一括計算
//     分割実行: 1回20件ずつ処理して next_offset を返す。done=true まで繰り返す。
//     例: /api/debug/backfill-signal?offset=0 → offset=20 → offset=40 ...
app.get('/api/debug/backfill-signal', async (c) => {
  const offset = parseInt(c.req.query('offset') || '0') || 0
  console.log(`Signal backfill triggered (offset=${offset})`)
  const result = await backfillMentionSignal(c.env.DB, offset)
  return c.json({
    message: 'Signal backfill chunk completed',
    ...result
  })
})

// 既存ペインの related_topics を keywords からトピック語に作り直す（"feature_category"等を除去）
// Llama不使用・neuron消費ゼロ・1回で完結。
app.get('/api/debug/backfill-topics', async (c) => {
  console.log('Related topics backfill triggered')
  const result = await backfillRelatedTopics(c.env.DB)
  return c.json({
    message: 'Related topics backfill completed',
    ...result
  })
})

// 既存の保存アイデアで idea_title が "App Idea" のものを ai_generated_idea から実名に置換
// （FM非対応端末で保存した分の修復）。Llama不使用・neuron消費ゼロ・1回で完結。
app.get('/api/debug/backfill-idea-titles', async (c) => {
  console.log('Idea titles backfill triggered')
  const result = await backfillIdeaTitles(c.env.DB)
  return c.json({
    message: 'Idea titles backfill completed',
    ...result
  })
})

// 7. Deep Dive テスト（認証なし、テストユーザーID=1使用）
app.get('/api/debug/deep-dive/:id', async (c) => {
  try {
    const painPointId = parseInt(c.req.param('id'))
    if (isNaN(painPointId)) {
      return c.json({ error: 'Invalid pain point ID' }, 400)
    }
    const testUserId = 1
    const limit = await checkDeepDiveLimit(c.env.DB, testUserId)
    if (!limit.allowed) {
      return c.json({ error: 'Daily limit reached', used: limit.used, limit: limit.limit }, 429)
    }
    const { result, cached } = await getDeepDive(c.env.DB, c.env.CLAUDE_API_KEY, painPointId)
    await recordDeepDiveUsage(c.env.DB, testUserId)
    return c.json({ deep_dive: result, cached, usage: { used: limit.used + 1, limit: limit.limit, remaining: limit.limit - limit.used - 1 } })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

// ======================================== 
// Cron ジョブ（6時間ごとにレビュー取得・分析）
// ========================================
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    // どのCronスケジュールが起動したかで処理を分ける
    // "*/15 * * * *" = 感情分析ファストレーン（15分ごと・少量）
    // "0 */3 * * *"  = ペインポイント生成（3時間ごと・専用）
    // それ以外（"0 */6 * * *"）= レビュー取得 + 感情分析
    if (controller.cron === '*/15 * * * *') {
      // 【高頻度・15分ごと】感情分析だけを安全な少量（40件）で処理。
      // 40件はレート制限（約48件）の内側なので、ほぼ全件成功する。
      // 40件 × 96回/日 ≒ 3,840件/日 → 未分析バックログを高速消化。
      console.log('Cron (sentiment fast lane) started:', new Date().toISOString())
      ctx.waitUntil(
        (async () => {
          try {
            const r = await analyzeSentiment(env.DB, env.AI, 40)
            console.log('Sentiment fast lane:', JSON.stringify(r))
          } catch (err) {
            console.error('Sentiment fast lane error:', err)
          }
        })()
      )
      return
    }

    if (controller.cron === '0 */3 * * *') {
      // 【3時間ごと・専用レーン】ペインポイント生成だけを単独で実行。
      // 以前はフルパイプラインの最後にあり、前段が長引くと生成まで届かず
      // 増えなかった。専用Cronに分離して確実に回す。5アプリ/回。
      // 「ペインポイントが少ないアプリ優先」なので、回るたび手つかずのアプリが掘られる。
      console.log('Cron (pain point generation) started:', new Date().toISOString())
      ctx.waitUntil(
        (async () => {
          try {
            const r = await generatePainPoints(env.DB, env.AI, 5)
            console.log('Pain point generation:', JSON.stringify(r))
          } catch (err) {
            console.error('Pain point generation error:', err)
          }
        })()
      )
      return
    }

    // 【6時間ごと】レビュー取得 + 感情分析
    // （ペインポイント生成は上の専用Cronが担当するのでここでは行わない）
    console.log('Cron (fetch + sentiment) started:', new Date().toISOString())
    ctx.waitUntil(
      (async () => {
        try {
          // Step 1: レビュー取得（20アプリ分）
          const fetchResult = await fetchAndStoreReviews(env.DB)
          console.log('Cron Step 1 (fetch):', JSON.stringify(fetchResult))

          // Step 2: 感情分析（安全な少量。バルク消化は15分ごとのファストレーンが担当）
          const sentimentResult = await analyzeSentiment(env.DB, env.AI, 40)
          console.log('Cron Step 2 (sentiment):', JSON.stringify(sentimentResult))

          console.log('Cron job completed successfully')
        } catch (err) {
          console.error('Cron error:', err)
        }
      })()
    )

    // Hacker News 取得（巡回・6時間ごとに少量ずつ全アプリを一巡）。
    // 取得/分析とは独立して実行（互いに影響しないよう別の waitUntil にする）。
    ctx.waitUntil(
      (async () => {
        try {
          const hn = await runHackerNewsCron(env.DB)
          console.log('Cron Step 3 (hacker news):', JSON.stringify(hn))
        } catch (err) {
          console.error('Hacker News cron error:', err)
        }
      })()
    )

    // 運用監視（週報＋アラート）。6時間ごとに評価し、必要なときだけメールを送る。
    // 取得/分析とは独立して実行（互いに影響しないよう別の waitUntil にする）。
    ctx.waitUntil(
      (async () => {
        try {
          const r = await runMonitor(env)
          console.log('Monitor:', JSON.stringify(r))
        } catch (err) {
          console.error('Monitor error:', err)
        }
      })()
    )

    // ダッシュボード用の日次スナップショット記録（推移グラフ用）。
    // snapshot_date でUPSERTするので、6時間ごとに呼んでも1日1行（その日の最新値で上書き）。
    ctx.waitUntil(
      (async () => {
        try {
          const r = await recordDailySnapshot(env.DB)
          console.log('Snapshot:', JSON.stringify(r))
        } catch (err) {
          console.error('Snapshot error:', err)
        }
      })()
    )
  }
}
