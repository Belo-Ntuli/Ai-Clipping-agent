import { describe, expect, test } from 'bun:test'
import { parseSegmentIndex } from '../runner/src/buffer'

describe('parseSegmentIndex', () => {
  test('reads ffmpeg csv rows in order', () => {
    const csv = [
      '/tmp/seg_00001.ts,0.000000,6.000000',
      '/tmp/seg_00002.ts,6.000000,12.000000',
      '/tmp/seg_00003.ts,12.000000,17.500000',
      '',
    ].join('\n')
    const segments = parseSegmentIndex(csv)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toEqual({
      path: '/tmp/seg_00001.ts',
      start: 0,
      end: 6,
    })
    expect(segments[2]!.end).toBe(17.5)
  })

  test('sorts rows that arrive out of order', () => {
    const segments = parseSegmentIndex(
      'b.ts,6,12\na.ts,0,6\n',
    )
    expect(segments.map((segment) => segment.path)).toEqual(['a.ts', 'b.ts'])
  })

  test('skips a partial trailing line while ffmpeg is still writing', () => {
    const segments = parseSegmentIndex('a.ts,0,6\nb.ts,6,')
    expect(segments).toHaveLength(1)
  })

  test('skips malformed rows instead of throwing', () => {
    const segments = parseSegmentIndex(
      ['', 'garbage', 'a.ts,notanumber,6', 'b.ts,0,6'].join('\n'),
    )
    expect(segments).toHaveLength(1)
    expect(segments[0]!.path).toBe('b.ts')
  })
})
