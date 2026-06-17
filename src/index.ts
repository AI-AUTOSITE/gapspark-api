import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { fetchAndStoreReviews } from './cron/fetch-reviews'
import { analyzeSentiment } from './cron/analyze-sentiment'
import { generatePainPoints, deduplicateExistingPainPoints, recalculateSeverityScores } from './cron/generate-pain-points'
import { getDeepDive, checkDeepDiveLimit, recordDeepDiveUsage } from './deep-dive'
import { unifiedSearch, getPopularTopics, getAppsByTopic, getPainPointsByTopic } from './search'
import { handleAppleAuth, authMiddleware, type AuthVariables } from './auth'

// Cloudflare Workers の環境変数型定義
type Bindings = {
  DB: D1Database
  AI: Ai
  CLAUDE_API_KEY: string
  JWT_SECRET: string        // 自前JWT署名用シークレット
  APPLE_BUNDLE_ID: string   // Apple Bundle ID（例: com.gapspark.app）
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

    // キャッシュヒットでもカウント（ユーザー体験上の公平性）
    await recordDeepDiveUsage(c.env.DB, userId)

    return c.json({
      deep_dive: result,
      cached,
      usage: {
        used: limit.used + 1,
        limit: limit.limit,
        remaining: limit.limit - limit.used - 1
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

// 2. 感情分析（NEW）
app.get('/api/debug/analyze-sentiment', async (c) => {
  console.log('Manual sentiment analysis triggered')
  const batchSize = parseInt(c.req.query('batch') || '500')
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
    // それ以外（"0 */6 * * *"）= フルパイプライン（6時間ごと）
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

    // 【6時間ごと】フルパイプライン: レビュー取得 → 感情分析 → ペインポイント生成
    console.log('Cron (full pipeline) started:', new Date().toISOString())
    ctx.waitUntil(
      (async () => {
        try {
          // Step 1: レビュー取得（20アプリ分）
          const fetchResult = await fetchAndStoreReviews(env.DB)
          console.log('Cron Step 1 (fetch):', JSON.stringify(fetchResult))

          // Step 2: 感情分析（安全な少量。バルク消化は15分ごとのファストレーンが担当）
          const sentimentResult = await analyzeSentiment(env.DB, env.AI, 40)
          console.log('Cron Step 2 (sentiment):', JSON.stringify(sentimentResult))

          // Step 3: ペインポイント生成（最大10アプリ）
          const painPointResult = await generatePainPoints(env.DB, env.AI, 10)
          console.log('Cron Step 3 (pain points):', JSON.stringify(painPointResult))

          console.log('Cron job completed successfully')
        } catch (err) {
          console.error('Cron error:', err)
        }
      })()
    )
  }
}
