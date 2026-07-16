import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addStructuredWritesParameter,
  classifyShell,
  extractDeclaredWrites,
  extractStructuredWrites,
} from '../src/shell.ts'

test('declared writes are parsed and stripped', () => {
  const parsed = extractDeclaredWrites('# oc-review-writes: ["a b.txt", "c"]\ncp x "a b.txt"')
  assert.deepEqual(parsed?.paths, ['a b.txt', 'c'])
  assert.equal(parsed?.command, 'cp x "a b.txt"')
})

test('structured writes are normalized and invalid declarations are ignored', () => {
  assert.deepEqual(extractStructuredWrites([' a.txt ', 'b.txt', 'a.txt']), ['a.txt', 'b.txt'])
  assert.equal(extractStructuredWrites([]), undefined)
  assert.equal(extractStructuredWrites(['a.txt', 1]), undefined)
  assert.equal(extractStructuredWrites(['\0bad']), undefined)
})

test('structured writes are added as an optional JSON Schema parameter', () => {
  const output: any = {
    jsonSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  }
  assert.equal(addStructuredWritesParameter(output), 'added')
  assert.equal(output.jsonSchema.properties.writes.type, 'array')
  assert.deepEqual(output.jsonSchema.required, ['command'])
  assert.equal(addStructuredWritesParameter(output), 'existing')
  assert.equal(addStructuredWritesParameter({}), 'unsupported')
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
