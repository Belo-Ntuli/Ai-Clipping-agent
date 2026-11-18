import { describe, expect, test } from 'bun:test'
import { ChatMeter, scoreSignal, type Signal } from '../runner/src/score'

const WINDOW = 10
const empty: Signal = {
  chatZ: 0,
  messages: 0,
  keywords: [],
  emoteBurst: 0,
  windowSeconds: WINDOW,
}

/** Feeds lines at a fixed instant, then ticks once for that window. */
function tickWith(lines: string[], now = 1_000_000): Signal {
  const meter = new ChatMeter()
  for (const line of lines) meter.add(line, now)
  return meter.tick(now, WINDOW)
}

describe('emote bursts', () => {
  test('ordinary repeated words are not emotes', () => {
    const signal = tickWith(
      Array.from({ length: 12 }, () => 'this mission is taking forever again'),
    )
    expect(signal.emoteBurst).toBe(0)
    // Lower-cased copies of the same words must not leak in either.
    expect(tickWith(Array.from({ length: 6 }, () => 'chat the same thing')).emoteBurst).toBe(0)
  })

  test('known emotes count once per message', () => {
    const signal = tickWith([
      'KEKW',
      'kekw that was clean',
      'KEKW KEKW KEKW',
      'KEKW',
      'nice',
    ])
    // Four distinct messages mention KEKW, even though one repeats it.
    expect(signal.emoteBurst).toBe(4)
  })

  test('one person spamming is not a burst', () => {
    const signal = tickWith([Array.from({ length: 40 }, () => 'KEKW').join(' ')])
    expect(signal.emoteBurst).toBe(1)
    // A burst of one contributes nothing to the score.
    expect(scoreSignal(signal)).toBe(scoreSignal({ ...signal, emoteBurst: 0 }))
  })

  test('all-caps tokens count, lower-case words do not', () => {
    expect(tickWith(['BASED', 'BASED', 'BASED']).emoteBurst).toBe(3)
    // Ordinary words, however often they repeat, are not emotes.
    expect(tickWith(['based', 'based', 'based']).emoteBurst).toBe(0)
    expect(tickWith(['clap', 'clap', 'clap']).emoteBurst).toBe(0)
    // Three-letter caps are ordinary shouty words, not emotes.
    expect(tickWith(['NO', 'WAY', 'WAY']).emoteBurst).toBe(0)
  })

  test('mixed case custom emote resolves to one emote', () => {
    expect(tickWith(['Poggers', 'POGGERS', 'poggers']).emoteBurst).toBe(3)
  })
})

describe('keywords', () => {
  test('match whole words only', () => {
    const signal = tickWith(['you should know somewhat about this'])
    expect(signal.keywords).not.toContain('yo')
    expect(signal.keywords).not.toContain('what')
  })

  test('multi-word phrases and short words still match', () => {
    const signal = tickWith(['NO WAY he just did that', 'clip it right now'])
    expect(signal.keywords).toContain('no way')
    expect(signal.keywords).toContain('clip it')
    expect(signal.keywords).toContain('clip')
  })

  test('are de-duplicated across messages', () => {
    const signal = tickWith(['lol that was insane', 'lol insane again'])
    expect(signal.keywords.filter((word) => word === 'lol')).toHaveLength(1)
    expect(signal.keywords).toContain('insane')
  })
})

describe('chat velocity', () => {
  test('stays flat for a steady baseline', () => {
    const meter = new ChatMeter()
    let now = 1_000_000
    for (let bucket = 0; bucket < 4; bucket += 1) {
      meter.add('yo', now)
      meter.add('nice', now)
      expect(meter.tick(now, WINDOW).chatZ).toBe(0)
      now += 30_000
    }
  })

  test('rises when the window spikes', () => {
    const meter = new ChatMeter()
    let now = 1_000_000
    for (let bucket = 0; bucket < 4; bucket += 1) {
      meter.add('yo', now)
      meter.add('nice', now)
      meter.tick(now, WINDOW)
      now += 30_000
    }
    for (let index = 0; index < 40; index += 1) meter.add('LOL', now)
    const signal = meter.tick(now, WINDOW)
    expect(signal.chatZ).toBeGreaterThan(2)
    expect(signal.messages).toBe(40)
  })
})

describe('scoreSignal', () => {
  test('an empty window scores zero', () => {
    expect(scoreSignal(empty)).toBe(0)
  })

  test('clamps to 0-100', () => {
    expect(scoreSignal({ ...empty, chatZ: 50 })).toBe(100)
    expect(scoreSignal({ ...empty, chatZ: -5 })).toBe(0)
  })

  test('a spike plus hit words and a real emote burst clears the default threshold', () => {
    const score = scoreSignal({
      ...empty,
      chatZ: 3,
      messages: 20,
      keywords: ['lol', 'no way'],
      emoteBurst: 6,
    })
    expect(score).toBeGreaterThanOrEqual(55)
  })

  test('ordinary chatter repeated by many people stays under the threshold', () => {
    // The regression this guards: repeated plain words must not inflate a score.
    const score = scoreSignal(tickWith(Array.from({ length: 30 }, () => 'this game is so good')))
    expect(score).toBeLessThan(55)
  })
})

describe('sample', () => {
  test('prefers keyword lines, de-duplicates and caps the list', () => {
    const meter = new ChatMeter()
    const now = 1_000_000
    meter.add('ok then', now)
    meter.add('no way KEKW', now)
    meter.add('ok then', now)
    meter.add('WTF was that', now)
    const lines = meter.sample(now, WINDOW, 3)
    expect(lines).toHaveLength(3)
    expect(new Set(lines.map((line) => line.toLowerCase())).size).toBe(3)
    expect(lines[0]).toContain('no way')
    expect(lines[1]).toContain('WTF')
  })
})
