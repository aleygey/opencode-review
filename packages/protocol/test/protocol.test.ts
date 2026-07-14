import assert from 'node:assert/strict'
import test from 'node:test'
import { instanceKey, pathsOverlap, stableReviewKey } from '../src/index.ts'

test('instance keys are stable and path-sensitive', () => {
  assert.equal(instanceKey('.'), instanceKey('.'))
  assert.notEqual(instanceKey('.'), instanceKey('..'))
})

test('pathsOverlap accepts parent/child and rejects siblings', () => {
  assert.equal(pathsOverlap('/work', '/work/repo'), true)
  assert.equal(pathsOverlap('/work/a', '/work/b'), false)
})

test('review key invalidates when content changes', () => {
  const one = stableReviewKey({ epochID: 'e', path: '/a', before: '1', after: '2' })
  const two = stableReviewKey({ epochID: 'e', path: '/a', before: '1', after: '3' })
  assert.notEqual(one, two)
})
