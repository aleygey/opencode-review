import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyShell, extractDeclaredWrites } from '../src/shell.ts'

test('declared writes are parsed and stripped', () => {
  const parsed = extractDeclaredWrites('# oc-review-writes: ["a b.txt", "c"]\ncp x "a b.txt"')
  assert.deepEqual(parsed?.paths, ['a b.txt', 'c'])
  assert.equal(parsed?.command, 'cp x "a b.txt"')
})

test('undeclared write commands are classified as mutations for policy handling', () => {
  assert.equal(classifyShell('sed -i s/a/b/ src/a.ts').kind, 'mutation')
  assert.equal(classifyShell('cp a b').kind, 'mutation')
  assert.equal(classifyShell('cat a > b').kind, 'mutation')
  assert.equal(classifyShell('find . -delete').kind, 'mutation')
  assert.equal(classifyShell('git stash -u').kind, 'mutation')
  assert.equal(classifyShell('git clean -fd').kind, 'mutation')
})

test('git transitions and read-only commands are recognized', () => {
  assert.equal(classifyShell('git merge feature').kind, 'git-transition')
  assert.equal(classifyShell('git restore value.txt').kind, 'git-transition')
  assert.equal(classifyShell('git commit -m done').kind, 'git-transition')
  assert.deepEqual(classifyShell('git -C services/api cherry-pick abc').gitDirectories, ['services/api'])
  assert.deepEqual(classifyShell('cd "services/api" && git rebase main').gitDirectories, ['services/api'])
  assert.equal(classifyShell('git -C services/api status --short').kind, 'read-only')
  assert.equal(classifyShell('git status && git diff').kind, 'read-only')
  assert.equal(classifyShell('rg TODO src').kind, 'read-only')
  assert.equal(classifyShell('cat input | python transform.py').kind, 'unknown')
  assert.equal(classifyShell('npm test').kind, 'unknown')
})
