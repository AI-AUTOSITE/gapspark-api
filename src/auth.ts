// Sign in with Apple — トークン検証 + 認証ミドルウェア
// 
// フロー:
// 1. iOS: Sign in with Apple → identityToken取得
// 2. iOS → POST /api/auth/apple { identityToken, email?, displayName? }
// 3. Backend: Apple JWKS で identityToken を検証
// 4. Backend: users テーブルに作成/更新 → 自前JWT発行
// 5. iOS: 以降のリクエストに Authorization: Bearer <jwt> ヘッダー付与
// 6. Backend: 認証ミドルウェアがJWT検証 → userId をコンテキストに注入

import * as jose from 'jose'
import type { Context, Next } from 'hono'

// ========================================
// 型定義
// ========================================

interface AuthUser {
  id: number
  apple_user_id: string
  email: string | null
  display_name: string | null
  subscription_tier: string
}

interface AppleAuthRequest {
  identityToken: string
  email?: string       // 初回サインインのみ
  displayName?: string // 初回サインインのみ
}

// Hono の Variables 型（c.get('userId') で取得するため）
export type AuthVariables = {
  userId: number
}

// ========================================
// Apple JWKS（キャッシュ付き）
// ========================================

let cachedJWKS: ReturnType<typeof jose.createRemoteJWKSet> | null = null

function getAppleJWKS() {
  if (!cachedJWKS) {
    cachedJWKS = jose.createRemoteJWKSet(
      new URL('https://appleid.apple.com/auth/keys')
    )
  }
  return cachedJWKS
}

// ========================================
// Apple Identity Token 検証
// ========================================

/**
 * Apple の identityToken (JWT) を検証
 * - Apple の公開鍵 (JWKS) で署名を検証
 * - issuer: https://appleid.apple.com
 * - audience: アプリの Bundle ID
 * - 返り値: sub (Apple User ID)
 */
export async function validateAppleToken(
  identityToken: string,
  bundleId: string
): Promise<{ appleUserId: string; email?: string }> {
  try {
    const JWKS = getAppleJWKS()
    
    const { payload } = await jose.jwtVerify(identityToken, JWKS, {
      issuer: 'https://appleid.apple.com',
      audience: bundleId,
    })

    if (!payload.sub) {
      throw new Error('Missing sub claim in Apple token')
    }

    return {
      appleUserId: payload.sub,
      email: payload.email as string | undefined,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Apple token validation failed:', message)
    throw new Error(`Apple token validation failed: ${message}`)
  }
}

// ========================================
// 自前 JWT 発行（セッション管理用）
// ========================================

/**
 * ユーザーID を含む JWT を発行（有効期限: 30日）
 * Apple の identityToken は短命(~10分)なので、自前JWTで延長
 */
export async function issueSessionJWT(
  userId: number,
  jwtSecret: string
): Promise<string> {
  const secret = new TextEncoder().encode(jwtSecret)
  
  const jwt = await new jose.SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .setIssuer('gapspark-api')
    .sign(secret)

  return jwt
}

/**
 * セッション JWT を検証 → userId を返す
 */
export async function verifySessionJWT(
  token: string,
  jwtSecret: string
): Promise<number> {
  const secret = new TextEncoder().encode(jwtSecret)
  
  const { payload } = await jose.jwtVerify(token, secret, {
    issuer: 'gapspark-api',
  })

  if (typeof payload.userId !== 'number') {
    throw new Error('Invalid JWT payload: missing userId')
  }

  return payload.userId
}

// ========================================
// ユーザー作成/更新
// ========================================

/**
 * Apple User ID でユーザーを検索し、なければ作成
 * email/displayName は初回サインイン時のみ提供される → あれば更新
 */
export async function findOrCreateUser(
  db: D1Database,
  appleUserId: string,
  email?: string,
  displayName?: string
): Promise<AuthUser> {
  // 既存ユーザーを検索
  const existing = await db.prepare(
    'SELECT id, apple_user_id, email, display_name, subscription_tier FROM users WHERE apple_user_id = ?'
  ).bind(appleUserId).first<AuthUser>()

  if (existing) {
    // 既存ユーザー: email/name があれば更新（初回のみ提供されるため保存）
    const updates: string[] = []
    const params: any[] = []

    if (email && !existing.email) {
      updates.push('email = ?')
      params.push(email)
    }
    if (displayName && !existing.display_name) {
      updates.push('display_name = ?')
      params.push(displayName)
    }

    // last_login_at は常に更新
    updates.push("last_login_at = datetime('now')")

    if (updates.length > 0) {
      params.push(existing.id)
      await db.prepare(
        `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...params).run()
    }

    return {
      ...existing,
      email: email || existing.email,
      display_name: displayName || existing.display_name,
    }
  }

  // 新規ユーザー作成
  const result = await db.prepare(
    `INSERT INTO users (apple_user_id, email, display_name, subscription_tier, last_login_at)
     VALUES (?, ?, ?, 'free', datetime('now'))`
  ).bind(appleUserId, email || null, displayName || null).run()

  const newUser = await db.prepare(
    'SELECT id, apple_user_id, email, display_name, subscription_tier FROM users WHERE apple_user_id = ?'
  ).bind(appleUserId).first<AuthUser>()

  if (!newUser) {
    throw new Error('Failed to create user')
  }

  console.log(`New user created: id=${newUser.id}, apple_user_id=${appleUserId}`)
  return newUser
}

// ========================================
// 認証ミドルウェア（Hono用）
// ========================================

/**
 * Authorization: Bearer <jwt> ヘッダーから JWT を検証
 * 成功: c.set('userId', userId) でユーザーIDを注入
 * 失敗: 401 Unauthorized を返す
 */
export function authMiddleware(jwtSecret: string) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization')
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Authentication required', message: 'Include Authorization: Bearer <token> header' }, 401)
    }

    const token = authHeader.slice(7) // "Bearer " を除去

    try {
      const userId = await verifySessionJWT(token, jwtSecret)
      c.set('userId', userId)
      await next()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Auth middleware error:', message)
      return c.json({ error: 'Invalid or expired token', message: 'Please sign in again' }, 401)
    }
  }
}

// ========================================
// Apple Auth ハンドラ（POST /api/auth/apple）
// ========================================

/**
 * Sign in with Apple のメインハンドラ
 * 
 * リクエスト: { identityToken, email?, displayName? }
 * レスポンス: { user, token, expiresIn }
 */
export async function handleAppleAuth(
  db: D1Database,
  jwtSecret: string,
  bundleId: string,
  body: AppleAuthRequest
): Promise<{ user: AuthUser; token: string; expiresIn: string }> {
  
  if (!body.identityToken) {
    throw new Error('identityToken is required')
  }

  // 1. Apple Identity Token を検証
  const { appleUserId, email: tokenEmail } = await validateAppleToken(
    body.identityToken,
    bundleId
  )

  // 2. ユーザー作成/更新
  // email は identityToken からも取れるが、body から渡された方を優先
  const user = await findOrCreateUser(
    db,
    appleUserId,
    body.email || tokenEmail,
    body.displayName
  )

  // 3. セッション JWT 発行（30日有効）
  const token = await issueSessionJWT(user.id, jwtSecret)

  return {
    user,
    token,
    expiresIn: '30 days',
  }
}
