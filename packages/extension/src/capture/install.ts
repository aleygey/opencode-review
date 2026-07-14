import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { normalizedRealPath, PROTOCOL_VERSION, reviewDataRoot } from '../../../protocol/src/index.ts'

const PLUGIN_FILE = 'opencode-review.js'

export type PluginInstallResult = {
  source: string
  target: string
  changed: boolean
}

export function globalPluginPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'opencode', 'plugins', PLUGIN_FILE)
}

export function installCompanionPlugin(extensionPath: string): PluginInstallResult {
  const source = path.join(extensionPath, 'media', 'opencode-review-plugin.js')
  const target = globalPluginPath()
  if (!fs.existsSync(source)) throw new Error(`bundled companion plugin is missing: ${source}`)
  const next = fs.readFileSync(source)
  let changed = true
  try {
    changed = !fs.readFileSync(target).equals(next)
  } catch {}
  if (changed) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, next)
    fs.renameSync(tmp, target)
  }
  return { source, target, changed }
}

export function writePluginConfig(workspaceRoot: string): string {
  const cfg = vscode.workspace.getConfiguration('ocReview')
  const root = reviewDataRoot()
  const file = path.join(root, 'defaults.json')
  fs.mkdirSync(root, { recursive: true })
  let current: any = {}
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  const workspaces = current.workspaces && typeof current.workspaces === 'object' ? current.workspaces : {}
  workspaces[normalizedRealPath(workspaceRoot)] = {
    shellPolicy: cfg.get<string>('shellPolicy', 'audit'),
    enforceReview: cfg.get<boolean>('enforceReview', true),
    maxBlobBytes: cfg.get<number>('maxBlobBytes', 20 * 1024 * 1024),
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ v: PROTOCOL_VERSION, workspaces }, null, 2))
  fs.renameSync(tmp, file)
  return file
}
