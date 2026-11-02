import base from './vite.config.mjs'

// Live benchmarks against a real node: no MSW, Node environment, only *.live.ts files.
// Run: pnpm exec vitest run --config vitest.live.config.mjs --mode mainnet
export default {
  ...base,
  test: {
    name: 'reti-ui-live',
    dir: './src',
    watch: false,
    globals: true,
    include: ['**/*.live.ts'],
    environment: 'node',
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 60 * 1000,
  },
}
