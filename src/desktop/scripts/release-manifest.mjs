import { createHash } from 'node:crypto'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rendererConfig } from './renderer-config.mjs'
import { verifyRenderer, verifyPackagedRenderer } from './renderer-provenance.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const file = `We-Meet-${pkg.version}-setup.exe`
const digest = async target => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(target)) hash.update(chunk)
  return hash.digest('hex')
}
const artifact = path.join(root, 'release', file)
const renderer = await verifyRenderer(path.resolve(root, '../frontend'), root, path.join(root, 'dist/renderer'), rendererConfig())
const rendererProvenance = verifyPackagedRenderer(path.join(root, 'release/win-unpacked/resources/app.asar'), renderer)
const signature = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s = Get-AuthenticodeSignature -LiteralPath $env:WEMEET_RELEASE_ARTIFACT; @{ status = [string]$s.Status; thumbprint = $s.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, WEMEET_RELEASE_ARTIFACT: artifact } }).trim())
if (process.argv.includes('--formal') && signature.status !== 'Valid') throw new Error('Formal release installer Authenticode verification failed')
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const manifest = {
  version: pkg.version, file, bytes: (await stat(artifact)).size, sha256: await digest(artifact),
  signature,
  bundledRuntime: JSON.parse(await readFile(path.join(root, 'dist/bundled-runtime.json'), 'utf8')),
  packagedAsarSha256: await digest(path.join(root, 'release/win-unpacked/resources/app.asar')),
  rendererProvenance,
  desktopLockSha256: await digest(path.join(root, 'package-lock.json')),
  frontendLockSha256: await digest(path.join(root, '../frontend/package-lock.json')),
  sourceRevision: git(['rev-parse', 'HEAD']), workingTreeDirty: !!git(['status', '--porcelain']),
  electron: pkg.devDependencies.electron, builder: pkg.devDependencies['electron-builder'],
  runtimeConfig: JSON.parse(await readFile(path.join(root, 'dist/runtime-config.json'), 'utf8')),
  builtAt: new Date().toISOString(), intendedUse: process.argv.includes('--formal') ? 'Signed release' : 'Internal acceptance; unsigned installers are not formal releases',
}
await writeFile(path.join(root, 'release', `We-Meet-${pkg.version}-manifest.json`), JSON.stringify(manifest, null, 2) + '\n')
console.log(`${file} SHA256 ${manifest.sha256}; dirty source tree: ${manifest.workingTreeDirty}`)
