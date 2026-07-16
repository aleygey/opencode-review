import { createRequire } from 'node:module'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
let build
try {
  ;({ build } = require('esbuild'))
} catch {
  ;({ build } = require(join(here, '../extension/node_modules/esbuild')))
}

await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: join(here, 'dist/opencode-review-plugin.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  banner: { js: '// OC Review companion plugin v0.12.2' },
  logLevel: 'info',
})

await mkdir(join(here, '../extension/media'), { recursive: true })
await copyFile(join(here, 'dist/opencode-review-plugin.js'), join(here, '../extension/media/opencode-review-plugin.js'))
