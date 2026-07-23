import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// 前端单测(vitest + jsdom):别名 @/ 复用 tsconfig paths。刻意不复用
// vite.config 的 dev server/proxy 与 env 加载,保持测试配置纯净、启动快。
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
