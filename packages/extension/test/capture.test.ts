import test from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { materializeChange, sameCapturedSnapshot } from '../src/capture/diff.ts'

const sha256 = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex')

test('materialized hunk can reverse-apply to a path with spaces and unicode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-review-diff-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const rel = 'src/space name-测试.txt'
    const abs = path.join(root, rel)
    const blobs = path.join(root, '.cas', 'blobs')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.mkdirSync(blobs, { recursive: true })
    const before = Buffer.from('before\n', 'utf8')
    const after = Buffer.from('after\n', 'utf8')
    const beforeHash = sha256(before)
    const afterHash = sha256(after)
    fs.writeFileSync(path.join(blobs, beforeHash), before)
    fs.writeFileSync(path.join(blobs, afterHash), after)
    fs.writeFileSync(abs, after)

    const item = await materializeChange({
      abs,
      repoRoot: root,
      relativePath: rel,
      before: { kind: 'file', hash: beforeHash, size: before.length },
      recordedAfter: { kind: 'file', hash: afterHash, size: after.length },
      blobs,
      epochIDs: ['epoch-1'],
      sessionIDs: ['session-1'],
      tools: ['edit'],
      reviewKey: 'review-1',
      instanceRoots: [path.dirname(blobs)],
    })
    assert.ok(item)
    assert.equal(item.coTouchedByUser, false)
    assert.equal(item.hunks.length, 1)
    fs.writeFileSync(abs, 'manual follow-up\n')
    const drifted = await materializeChange({
      abs,
      repoRoot: root,
      relativePath: rel,
      before: { kind: 'file', hash: beforeHash, size: before.length },
      recordedAfter: { kind: 'file', hash: afterHash, size: after.length },
      blobs,
      epochIDs: ['epoch-1'],
      sessionIDs: ['session-1'],
      tools: ['edit'],
      reviewKey: 'review-1',
      instanceRoots: [path.dirname(blobs)],
    })
    assert.equal(drifted?.coTouchedByUser, true)
    assert.notEqual(drifted?.reviewKey, item.reviewKey)
    fs.writeFileSync(abs, after)
    const hunk = item.hunks[0]
    const patchFile = path.join(root, 'reverse.patch')
    fs.writeFileSync(patchFile, `${item.patchHeader}${hunk.header}\n${hunk.body}\n`)
    execFileSync('git', ['apply', '-R', patchFile], { cwd: root })
    assert.equal(fs.readFileSync(abs, 'utf8'), 'before\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('snapshot continuity detects edits between OpenCode tool calls', () => {
  const one = { kind: 'file' as const, hash: 'a', mode: 0o644 }
  const same = { kind: 'file' as const, hash: 'a', mode: 0o644 }
  const manual = { kind: 'file' as const, hash: 'b', mode: 0o644 }
  assert.equal(sameCapturedSnapshot(one, same), true)
  assert.equal(sameCapturedSnapshot(one, manual), false)
  assert.equal(sameCapturedSnapshot({ kind: 'missing' }, { kind: 'missing' }), true)
})
