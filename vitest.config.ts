// vitest の設定。Miniflare（Workers の実行環境の偽物）は使わない。
// テスト対象は「純粋な関数」だけ — fetch と D1 は各テストで偽物に差し替える。
// D1 や Workers AI の実物が要るテストは、必要になったときに vitest-pool-workers を検討する。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // console.error を大量に出す関数を試すので、出力は失敗時だけ見えれば十分
    silent: true,
  },
})
