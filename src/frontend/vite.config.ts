import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import semiTheming from '@douyinfe/semi-vite-plugin'

/**
 * Semi Design 只用在运营管理台 /admin(见 features/admin)。C 端不引入。
 *
 * 这里覆盖两个 Semi 的 scss 变量,原因是 Semi 的 global.scss 会往 **body** 上写
 * 全局规则(字体、字体平滑、几百个 --semi-* 变量)。CSS 一旦注入就不随路由卸载 ——
 * 访问过一次 /admin,整个应用的字体就被换成 Inter 且回不去。
 *
 * 与其事后再写一条 body 规则压回去(依赖 CSS 加载顺序,构建产物一变就翻车),
 * 不如从官方入口把 token 本身改掉:
 *   $font-family-regular  → 与 panda 的 fonts.sans 逐字一致,于是「污染」后的
 *                           结果和原样相同,C 端无感;
 *   $color-primary-*      → 飞书蓝 #3370FF(Semi 默认是自己的 #0064FA),
 *                           让 admin 里的 Semi 组件和 C 端主色一致。
 *
 * 类名前缀没有替换:panda 生成的是原子类名(bg-c_brand.50 / h_control.md),
 * 和 `semi-` 前缀不可能碰撞,省一步构建开销。
 */
const SEMI_FONT_STACK =
  "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())
  return {
    plugins: [
      react(),
      tsconfigPaths(),
      semiTheming({
        variables: {
          '$font-family-regular': SEMI_FONT_STACK,
          // 飞书蓝主色阶(对齐 panda 的 primary.400/500/600/700)
          '$color-primary-4': '#5C8DFF',
          '$color-primary-5': '#3370FF',
          '$color-primary-6': '#2860D9',
          '$color-primary-7': '#1E4DB3',
        },
      }),
    ],
    build: {
      sourcemap: env.VITE_BUILD_SOURCEMAP === 'true',
    },
    server: {
      port: parseInt(env.VITE_PORT) || 3000,
      host: env.VITE_HOST ?? 'localhost',
      allowedHosts: ['.nip.io'],
      // In a local dev setup, we proxy the media server ourselves to avoid CORS issues
      proxy: {
        '/media': {
          target: 'http://localhost:8083',
          changeOrigin: true,
          secure: false
        }
      }
    },
  }
})
