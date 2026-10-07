import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const CONTRACT = 'we-meet-renderer-build/v1'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
export const inventoryDigest = entries => sha256(JSON.stringify([...entries].sort((a, b) => compare(a.path, b.path))))

async function tree(root, prefix = '', exclude = () => false) {
  const files = []
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (exclude(relative)) continue
    if (entry.isSymbolicLink()) throw new Error(`Renderer input/output links are unsupported: ${relative}`)
    if (entry.isDirectory()) files.push(...await tree(root, relative, exclude))
    else if (entry.isFile()) files.push({ path: relative, sha256: sha256(await readFile(path.join(root, relative))) })
    else throw new Error(`Unsupported renderer file: ${relative}`)
  }
  return files
}

export async function rendererInputHash(frontend, desktop, config, env = process.env) {
  const files = await tree(frontend, '', relative => {
    const [top] = relative.split('/')
    if (top === 'src') return relative === 'src/styled-system' || relative.endsWith('.tsbuildinfo')
    if (top === 'public') return false
    return relative.includes('/') || !/^(?:package(?:-lock)?\.json|index\.html|(?:vite|panda|postcss)\.config\..+|tsconfig(?:\..+)?\.json|\.env(?:\..*)?)$/.test(relative)
  })
  for (const name of ['build-renderer.mjs', 'renderer-config.mjs', 'renderer-provenance.mjs']) {
    files.push({ path: `desktop/scripts/${name}`, sha256: sha256(await readFile(path.join(desktop, 'scripts', name))) })
  }
  // Only opaque hashes leave the build process; .env contents and VITE values
  // are never written to metadata. Explicit desktop overrides match the child.
  const effective = { ...env, VITE_API_BASE_URL: '', VITE_JUSI_IM_BASE_URL: config.imBaseUrl, VITE_APP_TITLE: config.appTitle }
  const vite = Object.keys(effective).filter(key => key.startsWith('VITE_')).sort().map(key => [key, effective[key]])
  return sha256(JSON.stringify({ files: inventoryDigest(files), config, environment: sha256(JSON.stringify(vite)) }))
}

const productionAsset = relative => relative !== 'desktop-build.json' && !relative.endsWith('.map')
export async function rendererOutputInventory(directory) {
  const entries = await tree(directory, '', relative => !productionAsset(relative))
  if (!entries.some(entry => entry.path === 'index.html')) throw new Error('Renderer index.html is missing')
  return entries
}

export async function rendererBuildRecord(frontend, desktop, directory, config, env = process.env) {
  const entries = await rendererOutputInventory(directory)
  return { ...config, build: { contract: CONTRACT, input_sha256: await rendererInputHash(frontend, desktop, config, env), output_sha256: inventoryDigest(entries), output_files: entries.length } }
}

export async function verifyRenderer(frontend, desktop, directory, config, env = process.env) {
  const record = JSON.parse(await readFile(path.join(directory, 'desktop-build.json'), 'utf8'))
  const { build, ...builtConfig } = record
  if (build?.contract !== CONTRACT) throw new Error('Renderer build provenance missing: rerun build:renderer and copy:renderer')
  if (JSON.stringify(builtConfig) !== JSON.stringify(config)) throw new Error('Renderer configuration changed: rerun build:renderer and copy:renderer')
  if (build.input_sha256 !== await rendererInputHash(frontend, desktop, config, env)) throw new Error('Renderer sources or build inputs changed: rerun build:renderer and copy:renderer')
  const entries = await rendererOutputInventory(directory)
  if (build.output_sha256 !== inventoryDigest(entries) || build.output_files !== entries.length) throw new Error('Renderer output changed: rerun build:renderer and copy:renderer')
  return record
}

export function verifyPackagedRenderer(archive, record) {
  const require = createRequire(import.meta.url)
  const asar = require('@electron/asar')
  asar.uncache(archive)
  const packagedRecord = JSON.parse(asar.extractFile(archive, path.join('dist', 'renderer', 'desktop-build.json')).toString('utf8'))
  if (JSON.stringify(packagedRecord) !== JSON.stringify(record)) throw new Error('Packaged renderer provenance does not match the verified build')
  const entries = []
  for (const item of asar.listPackage(archive)) {
    const name = item.replaceAll('\\', '/').replace(/^\//, '')
    if (!name.startsWith('dist/renderer/')) continue
    const relative = name.slice('dist/renderer/'.length)
    const nativeName = name.replaceAll('/', path.sep)
    const info = asar.statFile(archive, nativeName, false)
    if (info.link) throw new Error('Packaged renderer links are unsupported')
    if (info.files || !productionAsset(relative)) continue
    entries.push({ path: relative, sha256: sha256(asar.extractFile(archive, nativeName)) })
  }
  if (inventoryDigest(entries) !== record.build.output_sha256 || entries.length !== record.build.output_files) throw new Error('Packaged renderer assets do not match the verified build')
  return { contract: CONTRACT, input_sha256: record.build.input_sha256, output_sha256: record.build.output_sha256, output_files: entries.length, packaged_assets_verified: true }
}
