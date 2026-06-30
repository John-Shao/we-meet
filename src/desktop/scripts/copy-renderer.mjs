// Copies the built frontend (src/frontend/dist) into dist/renderer so
// electron-builder packages it. Run after `npm run build:renderer`.
import { cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const src = new URL('../../frontend/dist/', import.meta.url)
const dest = new URL('../dist/renderer/', import.meta.url)

if (!existsSync(src)) {
  console.error(
    'frontend/dist not found — run `npm run build:renderer` first.\n' +
      '注意：Electron prod 走 file://，前端需用相对资源路径构建' +
      '（vite base: "./" 或 app:// 协议），否则 /assets 解析不到。见 README。',
  )
  process.exit(1)
}

await rm(dest, { recursive: true, force: true })
await cp(src, dest, { recursive: true })
console.log('copied frontend/dist → dist/renderer')
