export type ShellPolicy = 'strict' | 'audit' | 'off'

export type ShellClassification = {
  kind: 'read-only' | 'declared' | 'git-transition' | 'mutation' | 'unknown'
  command: string
  paths: string[]
  reason?: string
  gitDirectories?: string[]
}

const MARKER = /^\s*#\s*oc-review-writes:\s*(\[[^\r\n]*\])\s*(?:\r?\n|$)/i

export function extractDeclaredWrites(command: string): { command: string; paths: string[] } | undefined {
  const match = command.match(MARKER)
  if (!match) return undefined
  try {
    const parsed = JSON.parse(match[1])
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || item.length === 0)) return undefined
    return { command: command.slice(match[0].length), paths: [...new Set(parsed)] }
  } catch {
    return undefined
  }
}

const WRITE_SYNTAX = /(?:^|[;&|]\s*)(?:cp|mv|rm|rmdir|mkdir|touch|truncate|install|patch|tee)\b|\bsed\s+[^\n]*-[a-z]*i\b|\bperl\s+[^\n]*-[a-z]*i\b|\bawk\s+[^\n]*\s-i\b|\bfind\b[^\n]*(?:-delete|-exec\s+(?:rm|mv|cp))\b|(^|[^<>])>{1,2}(?![>&])|\bgit\s+(?:apply|clean|mv|rm)\b|\bgit\b[^\n]*\s--output(?:=|\s)|\b(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|New-Item|Rename-Item)\b/i
const GIT_TRANSITION = /\bgit(?<options>(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))*)\s+(?<operation>merge|rebase|cherry-pick|revert|pull|am|commit|checkout|switch|reset|restore|stash)\b/gi
const UNSCOPED_GIT_DELETE = /\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))*\s+(?:stash\b[^\n]*(?:^|\s)(?:-u|--include-untracked|--all)(?:\s|$)|checkout\b[^\n]*(?:^|\s)(?:-f|--force)(?:\s|$))/i

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function gitTransition(command: string): { directories: string[] } | undefined {
  const matches = [...command.matchAll(GIT_TRANSITION)]
  if (matches.length !== 1) return undefined
  const match = matches[0]
  const directories: string[] = []
  const prefix = command.slice(0, match.index)
  const cd = prefix.match(/(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|[^;&|\s]+)\s*&&\s*$/i)
  if (cd) directories.push(unquote(cd[1]))
  for (const option of (match.groups?.options ?? '').matchAll(/-C\s+("[^"]+"|'[^']+'|\S+)/gi)) {
    directories.push(unquote(option[1]))
  }
  return { directories }
}

const READ_ONLY_SEGMENT = /^\s*(?:git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))*\s+(?:status|diff|log|show|grep|rev-parse|branch|ls-files|ls-tree|cat-file|remote|add|fetch|tag)(?:\s|$)|cd(?:\s|$)|(?:Set-Location|Push-Location|Pop-Location)(?:\s|$)|rg(?:\s|$)|grep(?:\s|$)|find(?:\s|$)|ls(?:\s|$)|pwd(?:\s|$)|cat(?:\s|$)|head(?:\s|$)|tail(?:\s|$)|wc(?:\s|$)|stat(?:\s|$)|file(?:\s|$)|which(?:\s|$)|where(?:\s|$)|Get-Content(?:\s|$)|Get-ChildItem(?:\s|$)|Select-String(?:\s|$))/i

function looksReadOnly(command: string): boolean {
  if (/[>]|\b(?:tee|xargs\s+rm)\b/i.test(command)) return false
  const segments = command.split(/&&|\|\||[;|]|\r?\n/).map((item) => item.trim()).filter(Boolean)
  return segments.length > 0 && segments.every((segment) => READ_ONLY_SEGMENT.test(segment))
}

export function classifyShell(command: string): ShellClassification {
  const declared = extractDeclaredWrites(command)
  if (declared) return { kind: 'declared', command: declared.command, paths: declared.paths }
  if (UNSCOPED_GIT_DELETE.test(command)) {
    return {
      kind: 'mutation',
      command,
      paths: [],
      reason: 'Git command can delete untracked files without a bounded write set',
    }
  }
  const transition = gitTransition(command)
  if (transition) return { kind: 'git-transition', command, paths: [], gitDirectories: transition.directories }
  if (WRITE_SYNTAX.test(command)) {
    return {
      kind: 'mutation',
      command,
      paths: [],
      reason: 'mutating shell command has no declared output paths',
    }
  }
  if (looksReadOnly(command)) return { kind: 'read-only', command, paths: [] }
  return {
    kind: 'unknown',
    command,
    paths: [],
    reason: 'shell command is not provably read-only',
  }
}
