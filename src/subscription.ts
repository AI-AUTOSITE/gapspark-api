// サブスクリプション検証（GapSpark Pro）
//
// iOS が購入後に送ってくる transactionId を、Apple の「App Store Server API」で
// サーバー側から検証する。App Store Server API は Apple 署名済みの正式データを返すので、
// クライアントの自己申告に依存せず「本当にProか」を確定できる。
//
// フロー:
//   1. iOS: 購入 → StoreKit から transactionId 取得 → POST /api/user/subscription
//   2. Backend(ここ): App Store Connect API キーで ES256 JWT を生成
//   3. Backend: GET /inApps/v1/subscriptions/{transactionId} を叩く
//   4. Backend: 返ってきた署名付き取引情報(JWS)をデコードして expiresDate 等を読む
//   5. Backend: 有効なら users.subscription_tier='pro' + 有効期限を保存
//
// 必要なシークレット（wrangler secret put で設定）:
//   - APPSTORE_ISSUER_ID   : App Store Connect の Issuer ID（Users and Access → Integrations → App Store Connect API）
//   - APPSTORE_KEY_ID      : 生成したAPIキーの Key ID
//   - APPSTORE_PRIVATE_KEY : ダウンロードした .p8 の中身（-----BEGIN PRIVATE KEY----- から END まで全部）

import * as jose from 'jose'

// ========================================
// 設定
// ========================================

/// Pro の商品ID（App Store Connect / .storekit と一致させること）
export const PRO_PRODUCT_IDS = ['com.gapspark.GapSpark.pro.monthly']

const PROD_HOST = 'api.storekit.itunes.apple.com'
const SANDBOX_HOST = 'api.storekit-sandbox.itunes.apple.com'

// App Store Server API 検証に必要な環境（index.ts の Bindings のサブセット）
export interface SubscriptionEnv {
  APPLE_BUNDLE_ID: string
  APPSTORE_ISSUER_ID: string
  APPSTORE_KEY_ID: string
  APPSTORE_PRIVATE_KEY: string
}

// ========================================
// 型
// ========================================

/// 検証結果（サーバーが信頼できると判断したPro状態）
export interface VerifiedSub {
  active: boolean
  expiresDate: number | null // ms epoch（署名付き取引の expiresDate）
  originalTransactionId: string | null
  productId: string | null
}

/// Apple の /subscriptions/{id} レスポンス（必要部分のみ）
interface AppleSubStatusResponse {
  environment?: string
  bundleId?: string
  data?: {
    subscriptionGroupIdentifier?: string
    lastTransactions?: {
      originalTransactionId?: string
      status?: number // 1=active, 2=expired, 3=billing retry, 4=grace, 5=revoked
      signedTransactionInfo?: string
      signedRenewalInfo?: string
    }[]
  }[]
}

/// signedTransactionInfo(JWS) の payload（必要部分のみ）
interface DecodedTransaction {
  bundleId?: string
  productId?: string
  originalTransactionId?: string
  expiresDate?: number // ms epoch
  type?: string
}

// ========================================
// App Store Connect API 用 JWT 生成
// ========================================

/**
 * wrangler secret に登録した .p8 秘密鍵を、jose.importPKCS8 が読める正しい PEM に整える。
 *
 * ありがちな事故を吸収する:
 *  - .p8 全体を base64 化して保存している → デコードして PEM に戻す（最も安全な保存方法）
 *  - 改行が "\n"（バックスラッシュ+n の2文字）として保存されている → 本物の改行に戻す
 *  - 改行がすべて潰れて1行になっている → 64文字ごとに改行を入れ直す
 *  - 前後の空白や、CRLF(\r) が混ざっている
 */
function normalizePrivateKey(raw: string): string {
  const header = '-----BEGIN PRIVATE KEY-----'
  const footer = '-----END PRIVATE KEY-----'

  let key = raw.trim().replace(/\r/g, '')

  // ケース1: すでに PEM（ヘッダを含む）
  if (key.includes(header)) {
    key = key.replace(/\\n/g, '\n') // 文字列の "\n" を本物の改行に
    if (key.includes('\n')) {
      return key // 複数行 PEM → そのまま
    }
    // 1行 PEM → 本体を64文字ごとに折り返す
    const body = key.replace(header, '').replace(footer, '').replace(/\s+/g, '')
    const wrapped = body.match(/.{1,64}/g) ?? []
    return [header, ...wrapped, footer].join('\n')
  }

  // ケース2: ヘッダが無い → .p8 全体を base64 化したもの、とみなしてデコード
  const compact = key.replace(/\s+/g, '')
  try {
    const decoded = atob(compact)
    if (decoded.includes(header)) {
      return decoded.replace(/\r/g, '').trim()
    }
  } catch {
    // base64 ではなかった → 次へ
  }

  // ケース3: 最終手段 — 本体だけの base64（DER）とみなしてヘッダ/フッタで包む
  const wrapped = compact.match(/.{1,64}/g) ?? []
  return [header, ...wrapped, footer].join('\n')
}

/**
 * App Store Server API を呼ぶための ES256 JWT を作る。
 * .p8 は PKCS#8 PEM なので jose.importPKCS8 で読める（保存形式は normalizePrivateKey が吸収）。
 */
async function makeAppStoreJWT(env: SubscriptionEnv): Promise<string> {
  const alg = 'ES256'
  const pem = normalizePrivateKey(env.APPSTORE_PRIVATE_KEY)

  let privateKey: CryptoKey
  try {
    privateKey = await jose.importPKCS8(pem, alg)
  } catch (e) {
    // 秘密情報は出さず、構造だけログ（ヘッダは公開情報なので安全）
    console.error(
      'Private key import failed.',
      'head=', JSON.stringify(pem.slice(0, 27)),
      'lines=', pem.split('\n').length,
      'pemLen=', pem.length,
      'rawLen=', env.APPSTORE_PRIVATE_KEY.length,
      'rawHasLiteralBackslashN=', env.APPSTORE_PRIVATE_KEY.includes('\\n'),
      'rawHasRealNewline=', env.APPSTORE_PRIVATE_KEY.includes('\n')
    )
    throw e
  }

  return await new jose.SignJWT({ bid: env.APPLE_BUNDLE_ID })
    .setProtectedHeader({ alg, kid: env.APPSTORE_KEY_ID, typ: 'JWT' })
    .setIssuer(env.APPSTORE_ISSUER_ID)
    .setIssuedAt()
    .setExpirationTime('30m') // Apple の上限は60分。余裕をもって30分
    .setAudience('appstoreconnect-v1')
    .sign(privateKey)
}

// ========================================
// Apple 呼び出し
// ========================================

async function fetchSubscriptionStatus(
  env: SubscriptionEnv,
  transactionId: string,
  host: string
): Promise<Response> {
  const token = await makeAppStoreJWT(env)
  return fetch(`https://${host}/inApps/v1/subscriptions/${transactionId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// ========================================
// 検証本体
// ========================================

/**
 * transactionId を Apple で検証し、Pro が有効かどうかを返す。
 * - iOS から渡された environment（"Production"/"Sandbox"）で先に叩き、404なら他方にフォールバック。
 * - 返ってきた署名付き取引情報をデコードして expiresDate / productId を確認。
 *   （Apple への認証済み接続で得たデータなので、payload デコードのみで信頼できる）
 */
export async function verifySubscription(
  env: SubscriptionEnv,
  transactionId: string,
  environment: string
): Promise<VerifiedSub> {
  const primary = environment.toLowerCase() === 'sandbox' ? SANDBOX_HOST : PROD_HOST
  const secondary = primary === PROD_HOST ? SANDBOX_HOST : PROD_HOST

  let res = await fetchSubscriptionStatus(env, transactionId, primary)
  if (res.status === 404) {
    // 環境違いの可能性 → もう一方を試す
    res = await fetchSubscriptionStatus(env, transactionId, secondary)
  }

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`App Store Server API ${res.status}: ${body.substring(0, 200)}`)
  }

  const data = (await res.json()) as AppleSubStatusResponse

  // 自分の Pro 商品を含む最新トランザクションを探す（expiresDate が最大のもの）
  let best: { status: number; info: DecodedTransaction } | null = null

  for (const group of data.data ?? []) {
    for (const tx of group.lastTransactions ?? []) {
      if (!tx.signedTransactionInfo) continue

      let info: DecodedTransaction
      try {
        info = jose.decodeJwt(tx.signedTransactionInfo) as DecodedTransaction
      } catch {
        continue
      }

      // 自分の商品でなければ無視
      if (!info.productId || !PRO_PRODUCT_IDS.includes(info.productId)) continue
      // bundleId 照合（安全確認）
      if (info.bundleId && info.bundleId !== env.APPLE_BUNDLE_ID) continue

      const exp = typeof info.expiresDate === 'number' ? info.expiresDate : 0
      const bestExp = best?.info.expiresDate ?? 0
      if (!best || exp > bestExp) {
        best = { status: tx.status ?? 0, info }
      }
    }
  }

  if (!best) {
    return { active: false, expiresDate: null, originalTransactionId: null, productId: null }
  }

  const expiresMs = typeof best.info.expiresDate === 'number' ? best.info.expiresDate : null
  const notExpired = expiresMs ? expiresMs > Date.now() : false
  // status 1=Active, 4=Grace Period → 有効（かつ期限内）
  const active = (best.status === 1 || best.status === 4) && notExpired

  return {
    active,
    expiresDate: expiresMs,
    originalTransactionId: best.info.originalTransactionId ?? null,
    productId: best.info.productId ?? null,
  }
}

// ========================================
// D1 更新 / 参照
// ========================================

/**
 * 検証済みの Pro 権利を users に反映する。
 * 有効な場合のみ tier='pro' + 期限を保存。
 * （期限切れ後の降格は isUserPro / getUserSubscription が「期限 < 現在」で自動判定するので、
 *   ここで明示的に free に戻す処理は不要。解約後も期間終了までは Pro を維持できる。）
 */
export async function applyProEntitlement(
  db: D1Database,
  userId: number,
  sub: VerifiedSub
): Promise<void> {
  if (!sub.active || !sub.expiresDate) return

  const iso = new Date(sub.expiresDate).toISOString()
  await db
    .prepare(
      `UPDATE users
       SET subscription_tier = 'pro',
           subscription_expires_at = ?,
           original_transaction_id = ?
       WHERE id = ?`
    )
    .bind(iso, sub.originalTransactionId, userId)
    .run()
}

/**
 * ユーザーが現在 Pro かどうか（tier='pro' かつ 有効期限が未来）。
 * Deep Dive の上限判定で使用。
 */
export async function isUserPro(db: D1Database, userId: number): Promise<boolean> {
  const u = await db
    .prepare('SELECT subscription_tier, subscription_expires_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ subscription_tier: string; subscription_expires_at: string | null }>()

  if (!u) return false
  if (u.subscription_tier !== 'pro') return false
  if (!u.subscription_expires_at) return false
  return new Date(u.subscription_expires_at).getTime() > Date.now()
}

/**
 * サブスク状態を返す（iOS の SubscriptionStatus にデコードされる）。
 */
export async function getUserSubscription(
  db: D1Database,
  userId: number
): Promise<{ tier: string; active: boolean; expires_at: string | null }> {
  const u = await db
    .prepare('SELECT subscription_tier, subscription_expires_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ subscription_tier: string; subscription_expires_at: string | null }>()

  const active =
    !!u &&
    u.subscription_tier === 'pro' &&
    !!u.subscription_expires_at &&
    new Date(u.subscription_expires_at).getTime() > Date.now()

  return {
    tier: active ? 'pro' : 'free',
    active,
    expires_at: u?.subscription_expires_at ?? null,
  }
}

// ========================================
// App Store Server Notifications V2
// ========================================

/**
 * Apple から届く App Store Server Notification (V2) を処理する。
 * Apple はサブスクの更新・解約・返金・失効などが起きると、指定URLに
 * 署名付きJSON `{ signedPayload }` を POST してくる。
 *
 * ★セキュリティ設計（重要）★
 *   通知の署名(JWS x5c チェーン)を自前で完全検証する代わりに、通知からは
 *   originalTransactionId だけを取り出し、既存の verifySubscription()
 *   （App Store Server API = Apple認証済みの権威データ）で「実際の現在状態」を
 *   取り直して users を更新する。
 *   → なりすまし通知が来ても、結果は「Appleの真実に同期される」だけなので安全
 *     （攻撃者が勝手に自分を Pro にすることは不可能。API が本当の状態を返す）。
 *   → さらに、DBに紐付く originalTransactionId のときだけ API を叩くので、
 *     未知IDでの無駄なAPI呼び出し（乱用/DoS）も防げる。
 *
 * verifySubscription が一時的に失敗したときは throw する。呼び出し側で 5xx を返し、
 * Apple に再送させる（一時障害からの回復用）。それ以外は 200 を返す想定。
 */
export async function handleAppStoreNotification(
  db: D1Database,
  env: SubscriptionEnv,
  signedPayload: string
): Promise<{ handled: boolean; notificationType?: string; subtype?: string; userUpdated?: boolean }> {
  // 1. 外側JWSのペイロードを取り出す（署名検証はしない：抽出目的）
  let payload: any
  try {
    payload = jose.decodeJwt(signedPayload)
  } catch {
    console.error('ASSN: signedPayload decode failed')
    return { handled: false }
  }

  const notificationType: string | undefined = payload?.notificationType
  const subtype: string | undefined = payload?.subtype
  const environment: string = payload?.data?.environment ?? 'Production'

  // 2. data.signedTransactionInfo（さらに内側のJWS）から originalTransactionId を取り出す
  let originalTransactionId: string | undefined
  const signedTx: string | undefined = payload?.data?.signedTransactionInfo
  if (signedTx) {
    try {
      const txInfo: any = jose.decodeJwt(signedTx)
      originalTransactionId = txInfo?.originalTransactionId
    } catch {
      /* ignore */
    }
  }

  console.log(
    `ASSN: type=${notificationType} subtype=${subtype ?? '-'} env=${environment} origTxId=${originalTransactionId ?? '-'}`
  )

  // TEST通知や取引情報なしの通知は、受理だけして終了（200）
  if (!originalTransactionId) {
    return { handled: true, notificationType, subtype }
  }

  // 3. まず自分のDBに紐付くユーザーか確認（未知IDなら API を叩かない = 乱用防止）
  const user = await db
    .prepare('SELECT id FROM users WHERE original_transaction_id = ?')
    .bind(originalTransactionId)
    .first<{ id: number }>()

  if (!user) {
    console.log(`ASSN: no user for origTxId ${originalTransactionId} (skip)`)
    return { handled: true, notificationType, subtype }
  }

  // 4. App Store Server API で権威的に現在状態を取り直す（失敗時は throw → 呼び出し側が 5xx で再送）
  const sub = await verifySubscription(env, originalTransactionId, environment)

  // 5. 権威的状態に合わせて users を更新
  if (sub.active) {
    await applyProEntitlement(db, user.id, sub) // pro + 期限更新
    console.log(`ASSN: user ${user.id} -> pro (expires ${sub.expiresDate})`)
  } else {
    // 失効・返金・剥奪など → free に降格（isUserPro も期限で弾くが、剥奪等の期限内無効化に対応）
    const expiresIso = sub.expiresDate ? new Date(sub.expiresDate).toISOString() : null
    await db
      .prepare("UPDATE users SET subscription_tier = 'free', subscription_expires_at = ? WHERE id = ?")
      .bind(expiresIso, user.id)
      .run()
    console.log(`ASSN: user ${user.id} -> free`)
  }

  return { handled: true, notificationType, subtype, userUpdated: true }
}
