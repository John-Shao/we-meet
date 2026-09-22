import { createHash } from 'node:crypto'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const file = `We-Meet-${pkg.version}-setup.exe`
const digest = async target => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(target)) hash.update(chunk)
  return hash.digest('hex')
}
const artifact = path.join(root, 'release', file)
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const manifest = {
  version: pkg.version, file, bytes: (await stat(artifact)).size, sha256: await digest(artifact),
  packagedAsarSha256: await digest(path.join(root, 'release/win-unpacked/resources/app.asar')),
  desktopLockSha256: await digest(path.join(root, 'package-lock.json')),
  frontendLockSha256: await digest(path.join(root, '../frontend/package-lock.json')),
  sourceRevision: git(['rev-parse', 'HEAD']), workingTreeDirty: !!git(['status', '--porcelain']),
  electron: pkg.devDependencies.electron, builder: pkg.devDependencies['electron-builder'],
  runtimeConfig: JSON.parse(await readFile(path.join(root, 'dist/runtime-config.json'), 'utf8')),
  builtAt: new Date().toISOString(), intendedUse: 'Internal D0 acceptance; signing and acceptance are separate checks',
}
await writeFile(path.join(root, 'release', `We-Meet-${pkg.version}-manifest.json`), JSON.stringify(manifest, null, 2) + '\n')
console.log(`${file} SHA256 ${manifest.sha256}; dirty source tree: ${manifest.workingTreeDirty}`)
