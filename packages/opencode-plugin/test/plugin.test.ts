import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { instanceStore, type JournalRecord, type ReviewAck } from '../../protocol/src/index.ts'
import { OpencodeReviewPlugin } from '../dist/opencode-review-plugin.js'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('captures exact file writes in the nearest nested repo without gating subsequent tools', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-plugin-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const workspace = path.join(temp, 'workspace')
    const nested = path.join(workspace, 'services', 'api')
    const file = path.join(nested, 'src', 'value.ts')
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'export const value = 1\n')

    const hooks: any = await OpencodeReviewPlugin({ directory: workspace, worktree: workspace })
    await hooks['tool.execute.before'](
      { tool: 'edit', sessionID: 'ses-1', callID: 'call-1' },
      { args: { filePath: file } },
    )
    fs.writeFileSync(file, 'export const value = 2\n')
    await hooks['tool.execute.after']({ tool: 'edit', sessionID: 'ses-1', callID: 'call-1' }, {})
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-1' } } })

    const store = instanceStore(workspace)
    const records = fs
      .readFileSync(path.join(store, 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const begin = records.find((record) => record.type === 'tool.begin')
    const end = records.find((record) => record.type === 'tool.end')
    assert.equal(begin?.type, 'tool.begin')
    assert.equal(begin?.captures[0].repoRoot, nested)
    assert.equal(begin?.captures[0].relativePath, 'src/value.ts')
    assert.notEqual(begin?.captures[0].snapshot.hash, end?.type === 'tool.end' ? end.captures[0].snapshot.hash : undefined)
    assert.equal(records.at(-1)?.type, 'epoch.closed')

    await hooks['tool.execute.before'](
      { tool: 'custom-search', sessionID: 'ses-1', callID: 'call-custom' },
      { args: { query: 'value' } },
    )
    await hooks['tool.execute.after']({ tool: 'custom-search', sessionID: 'ses-1', callID: 'call-custom' }, {})
    await hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'ses-1', callID: 'call-2' },
      { args: { filePath: file } },
    )
    fs.writeFileSync(file, 'export const value = 3\n')
    await hooks['tool.execute.after']({ tool: 'write', sessionID: 'ses-1', callID: 'call-2' }, {})
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-1' } } })

    const ungated = fs.readFileSync(path.join(store, 'journal.jsonl'), 'utf8')
    assert.match(ungated, /"callID":"call-custom"/)
    assert.match(ungated, /"type":"coverage.gap"/)
    assert.match(ungated, /"callID":"call-2"/)
    const pending = JSON.parse(fs.readFileSync(path.join(store, 'pending.json'), 'utf8')) as { epochs: unknown[] }
    assert.equal(pending.epochs.length, 2)

    const epochID = (records.at(-1) as Extract<JournalRecord, { type: 'epoch.closed' }>).epochID
    const ack: ReviewAck = {
      v: 1,
      updatedAt: Date.now(),
      heartbeatAt: Date.now(),
      acknowledgedEpochs: [epochID],
    }
    fs.writeFileSync(path.join(store, 'review-ack.json'), JSON.stringify(ack))
    await hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'ses-1', callID: 'call-3' },
      { args: { filePath: file } },
    )
    fs.writeFileSync(file, 'export const value = 4\n')
    await hooks['tool.execute.after']({ tool: 'write', sessionID: 'ses-1', callID: 'call-3' }, {})
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-1' } } })
    const compacted = fs.readFileSync(path.join(store, 'journal.jsonl'), 'utf8')
    assert.doesNotMatch(compacted, /call-1/)
    assert.match(compacted, /call-2/)
    assert.match(compacted, /call-3/)
    const clearedAck = JSON.parse(fs.readFileSync(path.join(store, 'review-ack.json'), 'utf8')) as ReviewAck
    assert.deepEqual(clearedAck.acknowledgedEpochs, [])
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('audit mode records an undeclared shell mutation without blocking it', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-shell-audit-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const workspace = path.join(temp, 'workspace')
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
    const hooks: any = await OpencodeReviewPlugin({ directory: workspace, worktree: workspace })
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses-shell', callID: 'call-shell' },
      { args: { command: 'cp source.txt target.txt' } },
    )
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses-shell', callID: 'call-shell' }, {})
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-shell' } } })

    const store = instanceStore(workspace)
    const records = fs
      .readFileSync(path.join(store, 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const gap = records.find((record) => record.type === 'coverage.gap')
    assert.equal(gap?.type, 'coverage.gap')
    assert.equal(gap?.callID, 'call-shell')
    assert.match(gap?.reason ?? '', /no declared output paths/)
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('advertises and captures structured shell writes without forwarding review metadata', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-shell-writes-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const workspace = path.join(temp, 'workspace')
    const target = path.join(workspace, 'target.txt')
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
    fs.writeFileSync(target, 'before\n')
    const hooks: any = await OpencodeReviewPlugin({ directory: workspace, worktree: workspace })

    const definition: any = {
      description: 'Run a shell command.',
      parameters: {},
      jsonSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    }
    await hooks['tool.definition']({ toolID: 'shell' }, definition)
    assert.equal(definition.jsonSchema.properties.writes.type, 'array')
    assert.deepEqual(definition.jsonSchema.required, ['command'])
    assert.match(definition.description, /optional `writes` argument/)

    const output: any = {
      args: {
        command: 'node mutate-target.js',
        writes: [' target.txt ', 'target.txt'],
      },
    }
    await hooks['tool.execute.before'](
      { tool: 'shell', sessionID: 'ses-structured', callID: 'call-structured' },
      output,
    )
    assert.deepEqual(output.args, { command: 'node mutate-target.js' })
    fs.writeFileSync(target, 'after\n')
    await hooks['tool.execute.after'](
      { tool: 'shell', sessionID: 'ses-structured', callID: 'call-structured' },
      {},
    )
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-structured' } } })

    const records = fs
      .readFileSync(path.join(instanceStore(workspace), 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const begin = records.find((record) => record.type === 'tool.begin')
    const end = records.find((record) => record.type === 'tool.end')
    assert.equal(begin?.type, 'tool.begin')
    assert.deepEqual(begin?.captures.map((capture) => capture.relativePath), ['target.txt'])
    assert.equal(end?.type === 'tool.end' ? end.changed : false, true)
    assert.equal(records.some((record) => record.type === 'coverage.gap'), false)
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('recovers a changed epoch when OpenCode restarts before session idle', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-recovery-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const workspace = path.join(temp, 'workspace')
    const file = path.join(workspace, 'value.txt')
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
    fs.writeFileSync(file, 'before')
    const first: any = await OpencodeReviewPlugin({ directory: workspace, worktree: workspace })
    await first['tool.execute.before'](
      { tool: 'write', sessionID: 'ses-crash', callID: 'call-crash' },
      { args: { filePath: file } },
    )
    fs.writeFileSync(file, 'after')
    await first['tool.execute.after']({ tool: 'write', sessionID: 'ses-crash', callID: 'call-crash' }, {})

    await OpencodeReviewPlugin({ directory: workspace, worktree: workspace })
    const store = instanceStore(workspace)
    const pending = JSON.parse(fs.readFileSync(path.join(store, 'pending.json'), 'utf8')) as { epochs: unknown[] }
    assert.equal(pending.epochs.length, 1)
    const journal = fs.readFileSync(path.join(store, 'journal.jsonl'), 'utf8')
    assert.match(journal, /"type":"epoch.closed"/)
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('reconstructs an exact direct write when the after hook was lost', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-incomplete-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const workspace = path.join(temp, 'workspace')
    const file = path.join(workspace, 'value.txt')
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
    fs.writeFileSync(file, 'before')
    const first: any = await OpencodeReviewPlugin({ directory: workspace, worktree: workspace })
    await first['tool.execute.before'](
      { tool: 'write', sessionID: 'ses-incomplete', callID: 'call-incomplete' },
      { args: { filePath: file } },
    )
    fs.writeFileSync(file, 'after')

    await OpencodeReviewPlugin({ directory: workspace, worktree: workspace })
    const store = instanceStore(workspace)
    const records = fs
      .readFileSync(path.join(store, 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const recoveredEnd = records.find(
      (record): record is Extract<JournalRecord, { type: 'tool.end' }> => record.type === 'tool.end',
    )
    assert.equal(recoveredEnd?.changed, true)
    assert.equal(records.some((record) => record.type === 'coverage.gap'), false)
    assert.equal(records.at(-1)?.type, 'epoch.closed')
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('session idle captures an applied write when the after hook is delayed', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-idle-race-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const workspace = path.join(temp, 'workspace')
    const file = path.join(workspace, 'value.txt')
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
    fs.writeFileSync(file, 'before')
    const hooks: any = await OpencodeReviewPlugin({ directory: workspace, worktree: workspace })
    await hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'ses-idle-race', callID: 'call-idle-race' },
      { args: { filePath: file } },
    )
    fs.writeFileSync(file, 'after')
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-idle-race' } } })
    await hooks['tool.execute.after'](
      { tool: 'write', sessionID: 'ses-idle-race', callID: 'call-idle-race' },
      {},
    )

    const records = fs
      .readFileSync(path.join(instanceStore(workspace), 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const ends = records.filter((record) => record.type === 'tool.end')
    assert.equal(ends.length, 1)
    assert.equal(ends[0].type === 'tool.end' && ends[0].changed, true)
    assert.equal(records.at(-1)?.type, 'epoch.closed')
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('captures a successful git cherry-pick from commit trees', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-git-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const repo = path.join(temp, 'repo')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'OC Review Test'])
    git(repo, ['config', 'user.email', 'oc-review@example.invalid'])
    fs.writeFileSync(path.join(repo, 'value.txt'), 'base\n')
    fs.writeFileSync(path.join(repo, 'local.txt'), 'clean\n')
    git(repo, ['add', 'value.txt', 'local.txt'])
    git(repo, ['commit', '-qm', 'base'])
    const baseBranch = git(repo, ['branch', '--show-current'])
    git(repo, ['checkout', '-qb', 'feature'])
    fs.writeFileSync(path.join(repo, 'value.txt'), 'feature\n')
    git(repo, ['commit', '-qam', 'feature'])
    const feature = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['checkout', '-q', baseBranch])
    fs.writeFileSync(path.join(repo, 'local.txt'), 'uncommitted user work\n')

    const hooks: any = await OpencodeReviewPlugin({ directory: repo, worktree: repo })
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses-git', callID: 'call-git' },
      { args: { command: `git cherry-pick ${feature}` } },
    )
    git(repo, ['cherry-pick', feature])
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses-git', callID: 'call-git' }, {})
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-git' } } })

    const records = fs
      .readFileSync(path.join(instanceStore(repo), 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const end = records.find((record): record is Extract<JournalRecord, { type: 'tool.end' }> => record.type === 'tool.end')
    assert.equal(end?.changed, true)
    const beforeByPath = new Map(end?.beforeCaptures?.map((item) => [item.relativePath, item.snapshot.hash]))
    const afterByPath = new Map(end?.captures.map((item) => [item.relativePath, item.snapshot.hash]))
    assert.notEqual(beforeByPath.get('value.txt'), afterByPath.get('value.txt'))
    assert.equal(beforeByPath.get('local.txt'), afterByPath.get('local.txt'))
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('captures large git transitions with scoped batched tree reads', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-git-batch-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const repo = path.join(temp, 'repo')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'OC Review Test'])
    git(repo, ['config', 'user.email', 'oc-review@example.invalid'])
    const files = Array.from({ length: 260 }, (_, index) => `src/group ${index % 7}/value-${index}.txt`)
    for (const relativePath of files) {
      const file = path.join(repo, relativePath)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `base ${relativePath}\n`)
    }
    git(repo, ['add', 'src'])
    git(repo, ['commit', '-qm', 'base'])
    const baseBranch = git(repo, ['branch', '--show-current'])
    git(repo, ['checkout', '-qb', 'feature'])
    for (const relativePath of files) fs.writeFileSync(path.join(repo, relativePath), `feature ${relativePath}\n`)
    git(repo, ['commit', '-qam', 'feature'])
    const feature = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['checkout', '-q', baseBranch])

    const hooks: any = await OpencodeReviewPlugin({ directory: repo, worktree: repo })
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses-git-batch', callID: 'call-git-batch' },
      { args: { command: `git cherry-pick ${feature}` } },
    )
    git(repo, ['cherry-pick', feature])
    await hooks['tool.execute.after'](
      { tool: 'bash', sessionID: 'ses-git-batch', callID: 'call-git-batch' },
      {},
    )

    const records = fs
      .readFileSync(path.join(instanceStore(repo), 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const end = records.find(
      (record): record is Extract<JournalRecord, { type: 'tool.end' }> => record.type === 'tool.end',
    )
    assert.equal(end?.beforeCaptures?.length, files.length)
    assert.equal(end?.captures.length, files.length)
    assert.equal(records.some((record) => record.type === 'coverage.gap'), false)
    assert.ok(end?.beforeCaptures?.every((item) => item.snapshot.kind === 'file'))
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('captures git merge --no-commit when HEAD does not move', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-no-commit-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const repo = path.join(temp, 'repo')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'OC Review Test'])
    git(repo, ['config', 'user.email', 'oc-review@example.invalid'])
    fs.writeFileSync(path.join(repo, 'value.txt'), 'base\n')
    git(repo, ['add', 'value.txt'])
    git(repo, ['commit', '-qm', 'base'])
    const baseBranch = git(repo, ['branch', '--show-current'])
    git(repo, ['checkout', '-qb', 'feature'])
    fs.writeFileSync(path.join(repo, 'value.txt'), 'feature\n')
    git(repo, ['commit', '-qam', 'feature'])
    git(repo, ['checkout', '-q', baseBranch])
    fs.writeFileSync(path.join(repo, 'main-only.txt'), 'main\n')
    git(repo, ['add', 'main-only.txt'])
    git(repo, ['commit', '-qm', 'main diverges'])
    const beforeHead = git(repo, ['rev-parse', 'HEAD'])

    const hooks: any = await OpencodeReviewPlugin({ directory: repo, worktree: repo })
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses-merge', callID: 'call-merge' },
      { args: { command: 'git merge --no-commit --no-ff feature' } },
    )
    git(repo, ['merge', '--no-commit', '--no-ff', 'feature'])
    assert.equal(git(repo, ['rev-parse', 'HEAD']), beforeHead)
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses-merge', callID: 'call-merge' }, {})

    const records = fs
      .readFileSync(path.join(instanceStore(repo), 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const end = records.find((record): record is Extract<JournalRecord, { type: 'tool.end' }> => record.type === 'tool.end')
    assert.equal(end?.changed, true)
    assert.ok(end?.captures.some((item) => item.relativePath === 'value.txt'))
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('captures a git restore that removes a pre-existing dirty change', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-git-restore-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const repo = path.join(temp, 'repo')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'OC Review Test'])
    git(repo, ['config', 'user.email', 'oc-review@example.invalid'])
    const file = path.join(repo, 'value.txt')
    fs.writeFileSync(file, 'committed\n')
    git(repo, ['add', 'value.txt'])
    git(repo, ['commit', '-qm', 'base'])
    fs.writeFileSync(file, 'dirty content that must stay recoverable\n')

    const hooks: any = await OpencodeReviewPlugin({ directory: repo, worktree: repo })
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses-restore', callID: 'call-restore' },
      { args: { command: 'git restore value.txt' } },
    )
    git(repo, ['restore', 'value.txt'])
    await hooks['tool.execute.after'](
      { tool: 'bash', sessionID: 'ses-restore', callID: 'call-restore' },
      {},
    )

    const records = fs
      .readFileSync(path.join(instanceStore(repo), 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const end = records.find(
      (record): record is Extract<JournalRecord, { type: 'tool.end' }> => record.type === 'tool.end',
    )
    assert.equal(end?.changed, true)
    assert.equal(end?.beforeCaptures?.[0].relativePath, 'value.txt')
    const beforeHash = end?.beforeCaptures?.[0].snapshot.hash
    assert.ok(beforeHash)
    assert.equal(
      fs.readFileSync(path.join(process.env.OC_REVIEW_HOME!, 'blobs', beforeHash!), 'utf8'),
      'dirty content that must stay recoverable\n',
    )
    assert.equal(fs.readFileSync(file, 'utf8'), 'committed\n')
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('captures base, ours, and theirs for a merge conflict', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-conflict-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const repo = path.join(temp, 'repo')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.name', 'OC Review Test'])
    git(repo, ['config', 'user.email', 'oc-review@example.invalid'])
    fs.writeFileSync(path.join(repo, 'value.txt'), 'base\n')
    git(repo, ['add', 'value.txt'])
    git(repo, ['commit', '-qm', 'base'])
    const baseBranch = git(repo, ['branch', '--show-current'])
    git(repo, ['checkout', '-qb', 'feature'])
    fs.writeFileSync(path.join(repo, 'value.txt'), 'theirs\n')
    git(repo, ['commit', '-qam', 'theirs'])
    git(repo, ['checkout', '-q', baseBranch])
    fs.writeFileSync(path.join(repo, 'value.txt'), 'ours\n')
    git(repo, ['commit', '-qam', 'ours'])

    const hooks: any = await OpencodeReviewPlugin({ directory: repo, worktree: repo })
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses-conflict', callID: 'call-conflict' },
      { args: { command: 'git merge feature' } },
    )
    const merge = spawnSync('git', ['merge', 'feature'], { cwd: repo, encoding: 'utf8' })
    assert.notEqual(merge.status, 0)
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses-conflict', callID: 'call-conflict' }, {})

    const records = fs
      .readFileSync(path.join(instanceStore(repo), 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const end = records.find((record): record is Extract<JournalRecord, { type: 'tool.end' }> => record.type === 'tool.end')
    const conflict = end?.conflicts?.find((item) => item.relativePath === 'value.txt')
    assert.ok(conflict?.base?.hash)
    assert.ok(conflict?.ours?.hash)
    assert.ok(conflict?.theirs?.hash)
    assert.notEqual(conflict.ours.hash, conflict.theirs.hash)
    assert.match(fs.readFileSync(path.join(repo, 'value.txt'), 'utf8'), /<<<<<<< HEAD/)
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('captures a mode-only file edit', { skip: process.platform === 'win32' }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-mode-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const workspace = path.join(temp, 'workspace')
    const file = path.join(workspace, 'run.sh')
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
    fs.writeFileSync(file, '#!/bin/sh\n')
    fs.chmodSync(file, 0o644)
    const hooks: any = await OpencodeReviewPlugin({ directory: workspace, worktree: workspace })
    await hooks['tool.execute.before'](
      { tool: 'edit', sessionID: 'ses-mode', callID: 'call-mode' },
      { args: { filePath: file } },
    )
    fs.chmodSync(file, 0o755)
    await hooks['tool.execute.after']({ tool: 'edit', sessionID: 'ses-mode', callID: 'call-mode' }, {})
    const records = fs
      .readFileSync(path.join(instanceStore(workspace), 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord)
    const begin = records.find((record): record is Extract<JournalRecord, { type: 'tool.begin' }> => record.type === 'tool.begin')
    const end = records.find((record): record is Extract<JournalRecord, { type: 'tool.end' }> => record.type === 'tool.end')
    assert.equal(end?.changed, true)
    assert.equal(begin?.captures[0].snapshot.hash, end?.captures[0].snapshot.hash)
    assert.notEqual(begin?.captures[0].snapshot.mode, end?.captures[0].snapshot.mode)
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('drops a no-op epoch instead of growing the journal', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-noop-'))
  const previousHome = process.env.OC_REVIEW_HOME
  process.env.OC_REVIEW_HOME = path.join(temp, 'data')
  try {
    const workspace = path.join(temp, 'workspace')
    const file = path.join(workspace, 'same.txt')
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
    fs.writeFileSync(file, 'same\n')
    const hooks: any = await OpencodeReviewPlugin({ directory: workspace, worktree: workspace })
    await hooks['tool.execute.before'](
      { tool: 'edit', sessionID: 'ses-noop', callID: 'call-noop' },
      { args: { filePath: file } },
    )
    await hooks['tool.execute.after']({ tool: 'edit', sessionID: 'ses-noop', callID: 'call-noop' }, {})
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses-noop' } } })
    const store = instanceStore(workspace)
    assert.equal(fs.readFileSync(path.join(store, 'journal.jsonl'), 'utf8'), '')
    assert.equal(fs.existsSync(path.join(store, 'pending.json')), false)
  } finally {
    if (previousHome === undefined) delete process.env.OC_REVIEW_HOME
    else process.env.OC_REVIEW_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
