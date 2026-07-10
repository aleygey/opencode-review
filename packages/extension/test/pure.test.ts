import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHunkHeader, mapHunkToNewFile, mapFileMarks, hunkFirstLine } from '../src/lib/hunkmap.ts'
import { SseParser, normalizeOcEvent, extractToolEvent, extractTextDelta, parseModelString } from '../src/lib/sse.ts'

// ---------- hunkmap ----------

test('parseHunkHeader: full and count-omitted forms', () => {
  assert.deepEqual(parseHunkHeader('@@ -3,4 +5,6 @@ fn foo()'), { oldStart: 3, oldCount: 4, newStart: 5, newCount: 6 })
  assert.deepEqual(parseHunkHeader('@@ -1 +1 @@'), { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 })
  assert.equal(parseHunkHeader('not a header'), undefined)
})

test('mapHunkToNewFile: modification (replace one line)', () => {
  // old l2 'b' -> new l2 'B', unified=1 context
  const m = mapHunkToNewFile('@@ -1,3 +1,3 @@', [' a', '-b', '+B', ' c'].join('\n'))
  assert.deepEqual(m.added, [1]) // 0-based line 1 == line 2
  assert.equal(m.deletions.length, 1)
  assert.deepEqual(m.deletions[0].text, ['b'])
})

test('mapHunkToNewFile: pure addition', () => {
  const m = mapHunkToNewFile('@@ -2,0 +3,2 @@', ['+x', '+y'].join('\n'))
  assert.deepEqual(m.added, [2, 3])
  assert.equal(m.deletions.length, 0)
})

test('mapHunkToNewFile: pure deletion anchors above following content', () => {
  // deleting old lines 5-6; new file position "after new line 4"
  const m = mapHunkToNewFile('@@ -5,2 +4,0 @@', ['-gone1', '-gone2'].join('\n'))
  assert.equal(m.added.length, 0)
  assert.equal(m.deletions.length, 1)
  assert.deepEqual(m.deletions[0].text, ['gone1', 'gone2'])
  assert.equal(m.deletions[0].line, 3) // sits after 0-based line 3 (new line 4)
})

test('mapHunkToNewFile: ignores no-newline marker', () => {
  const m = mapHunkToNewFile('@@ -1,1 +1,1 @@', ['-a', '\\ No newline at end of file', '+b'].join('\n'))
  assert.deepEqual(m.added, [0])
  assert.equal(m.deletions.length, 1)
})

test('mapFileMarks + hunkFirstLine aggregate correctly', () => {
  const hunks = [
    { header: '@@ -1,1 +1,1 @@', body: '-a\n+A' },
    { header: '@@ -9,1 +9,2 @@', body: ' ctx\n+tail' },
  ]
  const m = mapFileMarks(hunks)
  assert.deepEqual(m.added, [0, 9])
  assert.equal(hunkFirstLine(hunks[1].header, hunks[1].body), 9)
})

// ---------- sse ----------

test('SseParser: splits events, joins multi-data, ignores comments/fields', () => {
  const p = new SseParser()
  const out1 = p.feed('event: message\ndata: {"a"')
  assert.equal(out1.length, 0) // incomplete
  const out2 = p.feed(':1}\n\n:heartbeat\n\ndata: line1\ndata: line2\n\n')
  assert.deepEqual(out2, ['{"a":1}', 'line1\nline2'])
})

test('SseParser: handles CRLF framing', () => {
  const p = new SseParser()
  const out = p.feed('data: x\r\n\r\ndata: y\r\n\r\n')
  assert.deepEqual(out, ['x', 'y'])
})

test('SseParser: CRLF split across chunk boundary is one terminator, not two', () => {
  const p = new SseParser()
  // '\r\n\r\n' delivered as '…\r' + '\n\r\n…' must yield exactly one event boundary
  const a = p.feed('data: x\r')
  assert.deepEqual(a, [])
  const b = p.feed('\n\r\ndata: y\r\n\r\n')
  assert.deepEqual(b, ['x', 'y'])
})

test('SseParser: CR state survives empty chunks and a bare-\\n chunk consumes the pair', () => {
  const p = new SseParser()
  assert.deepEqual(p.feed('data: a\r'), [])
  assert.deepEqual(p.feed(''), []) // TextDecoder can emit empty chunks — must not reset CR state
  assert.deepEqual(p.feed('\n'), []) // completes the split CRLF — exactly one line break, no event yet
  assert.deepEqual(p.feed('\r\n'), ['a']) // blank line terminates the event
  // and a following normal event still parses
  assert.deepEqual(p.feed('data: b\n\n'), ['b'])
})

test('SseParser: lone-CR line terminators work (\\r\\r ends an event)', () => {
  const p = new SseParser()
  assert.deepEqual(p.feed('data: x\r\rdata: y\r\r'), ['x', 'y'])
})

test('normalizeOcEvent: v1 {type,properties} and v2 {payload} envelopes', () => {
  const v1 = normalizeOcEvent({ type: 'file.edited', properties: { file: '/a/b.ts' } })
  assert.equal(v1?.type, 'file.edited')
  assert.equal(v1?.props.file, '/a/b.ts')

  const v2 = normalizeOcEvent({ payload: { type: 'session.idle', properties: { sessionID: 's1' } }, workspace: 'w' })
  assert.equal(v2?.type, 'session.idle')
  assert.equal(v2?.props.sessionID, 's1')

  const inline = normalizeOcEvent({ payload: { type: 'x.y', foo: 1 } })
  assert.equal(inline?.props.foo, 1)

  assert.equal(normalizeOcEvent({ nope: true }), undefined)
})

test('extractToolEvent: completed edit with filePath variants', () => {
  const mk = (input: any) =>
    extractToolEvent({ part: { type: 'tool', tool: 'edit', sessionID: 's', state: { status: 'completed', input } } })
  assert.equal(mk({ filePath: '/x/a.ts' })?.filePath, '/x/a.ts')
  assert.equal(mk({ file_path: '/x/b.ts' })?.filePath, '/x/b.ts')
  assert.equal(mk({ path: '/x/c.ts' })?.filePath, '/x/c.ts')
  assert.equal(extractToolEvent({ part: { type: 'tool', tool: 'bash', state: { status: 'completed' } } }), undefined)
  assert.equal(extractToolEvent({ part: { type: 'text' } }), undefined)
})

test('extractTextDelta: session + delta routing', () => {
  const d = extractTextDelta({ part: { type: 'text', text: 'hello', sessionID: 's9' }, delta: 'lo' })
  assert.equal(d?.sessionID, 's9')
  assert.equal(d?.text, 'hello')
  assert.equal(d?.delta, 'lo')
})

test('parseModelString', () => {
  assert.deepEqual(parseModelString('anthropic/claude-sonnet-4-5'), { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' })
  assert.deepEqual(parseModelString('a/b/c'), { providerID: 'a', modelID: 'b/c' })
  assert.equal(parseModelString(''), undefined)
  assert.equal(parseModelString('nomodel'), undefined)
})
