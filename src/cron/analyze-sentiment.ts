// Workers AI (DistilBERT) で感情分析を実行
// 未分析のレビューを取得 → DistilBERT で POSITIVE/NEGATIVE 判定 → D1に保存

interface UnanalyzedReview {
  id: number
  title: string
  body: string
}

interface SentimentResult {
  label: string   // 'POSITIVE' or 'NEGATIVE'
  score: number   // 0.0 - 1.0 confidence
}

/**
 * 感情分析パイプライン
 * - 1回の実行で最大 batchSize 件を処理
 * - DistilBERT: ~0.5 neurons/call → 500件 ≈ 250 neurons
 * - ニューロン予算に優しい
 */
export async function analyzeSentiment(
  db: D1Database,
  ai: Ai,
  batchSize: number = 500
): Promise<{
  analyzed: number
  positive: number
  negative: number
  errors: number
}> {
  let analyzed = 0
  let positive = 0
  let negative = 0
  let errors = 0

  // sentiment_score が NULL のレビューを取得（未分析）
  const reviews = await db.prepare(
    `SELECT id, title, body FROM reviews 
     WHERE sentiment_score IS NULL 
     ORDER BY id ASC 
     LIMIT ?`
  ).bind(batchSize).all<UnanalyzedReview>()

  if (!reviews.results || reviews.results.length === 0) {
    console.log('No unanalyzed reviews found')
    return { analyzed: 0, positive: 0, negative: 0, errors: 0 }
  }

  console.log(`Analyzing sentiment for ${reviews.results.length} reviews...`)

  // バッチ更新用のステートメント
  const updateStmt = db.prepare(
    `UPDATE reviews SET sentiment_score = ?, sentiment_label = ? WHERE id = ?`
  )

  // 50件ずつDBバッチ更新（D1 batch APIの効率化）
  const DB_BATCH_SIZE = 50
  let batchUpdates: D1PreparedStatement[] = []

  for (const review of reviews.results) {
    try {
      // レビューのタイトル + 本文を結合（DistilBERTに渡すテキスト）
      // DistilBERTは最大512トークン。長文レビューはトークン超過(AiError 3030)になるため、
      // 安全な長さ(800文字)に切り詰める。感情判定は冒頭で十分なので精度影響はほぼない。
      const MAX_CHARS = 800
      const combined = `${review.title} ${review.body}`.trim()
      const text = combined.length > MAX_CHARS ? combined.slice(0, MAX_CHARS) : combined

      if (text.length === 0) {
        // 空テキストはスキップ（中立として保存）
        batchUpdates.push(updateStmt.bind(0.0, 'NEUTRAL', review.id))
        analyzed++
        continue
      }

      // Workers AI DistilBERT 実行
      const result = await ai.run(
        '@cf/huggingface/distilbert-sst-2-int8',
        { text }
      ) as SentimentResult[]

      if (result && result.length > 0) {
        // DistilBERT は [NEGATIVE, POSITIVE] の2つのスコアを返す
        // 最もスコアが高いものが判定結果
        const topResult = result.reduce((a, b) => a.score > b.score ? a : b)
        
        // sentiment_score: -1.0 (negative) 〜 +1.0 (positive) に変換
        const normalizedScore = topResult.label === 'POSITIVE'
          ? topResult.score    // 0.5 ~ 1.0
          : -topResult.score   // -1.0 ~ -0.5

        batchUpdates.push(
          updateStmt.bind(normalizedScore, topResult.label, review.id)
        )

        if (topResult.label === 'POSITIVE') positive++
        else negative++
        analyzed++
      }

      // 50件たまったらDBに一括書き込み
      if (batchUpdates.length >= DB_BATCH_SIZE) {
        await db.batch(batchUpdates)
        console.log(`  Batch saved: ${analyzed} analyzed so far`)
        batchUpdates = []
      }

    } catch (e) {
      const msg = String(e)
      console.error(`  Sentiment error for review ${review.id}:`, e)
      // 恒久的エラー（トークン超過 3030 = 本文が原因。再試行しても無駄）だけ
      // NEUTRALで確定し、キューに居座らせない。
      // レート制限などの一時的エラーは未分析(NULL)のまま残し、次回再試行させる。
      if (msg.includes('max tokens') || msg.includes('3030')) {
        batchUpdates.push(updateStmt.bind(0.0, 'NEUTRAL', review.id))
      }
      errors++
    }
  }

  // 残りのバッチを書き込み
  if (batchUpdates.length > 0) {
    await db.batch(batchUpdates)
  }

  console.log(`Sentiment analysis complete: ${analyzed} analyzed (${positive} positive, ${negative} negative, ${errors} errors)`)
  return { analyzed, positive, negative, errors }
}
