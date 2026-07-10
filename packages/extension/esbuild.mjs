import { build } from 'esbuild'

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
}

// Main extension bundle — runs in the VSCode extension host.
await build({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
})

// Engine worker bundle — forked as a child process so synchronous git calls
// (the engine uses spawnSync) never block the extension host / UI.
await build({
  ...common,
  entryPoints: ['src/engineHost.ts'],
  outfile: 'dist/engineHost.js',
})
