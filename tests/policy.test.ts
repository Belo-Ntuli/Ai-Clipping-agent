import { expect, test } from 'bun:test'
import { cleanList, screenMoment, sameCategory } from '../src/shared/policy'
import type { Policy } from '../src/shared/types'

const policy = (patch: Partial<Policy> = {}): Policy => ({
  paused: false,
  allowedCategories: [],
  blockedTerms: [],
  updatedAt: 0,
  ...patch,
})

const moment = (sample: string[], category: string | null = 'Just Chatting') =>
  screenMoment({ platform: 'twitch', channel: 'xqc', category, sample }, policy())

test('an empty policy allows a normal moment', () => {
  expect(moment(['NO WAY', 'clip it'])).toEqual({ allowed: true })
})

test('paused refuses everything and says so', () => {
  const verdict = screenMoment(
    { platform: 'twitch', channel: 'xqc', category: 'GTA V', sample: ['lol'] },
    policy({ paused: true }),
  )
  expect(verdict.allowed).toBe(false)
  if (!verdict.allowed) expect(verdict.reason).toBe('clipping is paused')
})

test('a category allowlist is checked when one is set', () => {
  const gaming = policy({ allowedCategories: ['Grand Theft Auto V'] })
  expect(
    screenMoment(
      { platform: 'twitch', channel: 'a', category: 'Grand Theft Auto V', sample: [] },
      gaming,
    ),
  ).toEqual({ allowed: true })
  // Case and padding are ignored on both sides.
  expect(
    screenMoment(
      { platform: 'twitch', channel: 'a', category: '  grand theft auto v ', sample: [] },
      gaming,
    ),
  ).toEqual({ allowed: true })

  const other = screenMoment(
    { platform: 'twitch', channel: 'a', category: 'Just Chatting', sample: [] },
    gaming,
  )
  expect(other.allowed).toBe(false)
  if (!other.allowed) expect(other.reason).toContain('Just Chatting')
})

test('an unknown category is refused while an allowlist is set', () => {
  const verdict = screenMoment(
    { platform: 'kick', channel: 'a', category: null, sample: [] },
    policy({ allowedCategories: ['Grand Theft Auto V'] }),
  )
  expect(verdict.allowed).toBe(false)
  if (!verdict.allowed) expect(verdict.reason).toContain('category unknown')
})

test('a blocked term anywhere in the sample refuses the moment', () => {
  const verdict = screenMoment(
    { platform: 'twitch', channel: 'a', category: 'GTA V', sample: ['chat noise', 'he is doing COCAINE'] },
    policy({ blockedTerms: ['cocaine'] }),
  )
  expect(verdict.allowed).toBe(false)
  if (!verdict.allowed) expect(verdict.reason).toBe('blocked term: cocaine')
})

test('blocked terms do not match inside other words by accident', () => {
  // Literal substring matching is the documented rule, so this is a guard on
  // the *intent*: short terms need choosing carefully by the owner.
  const verdict = screenMoment(
    { platform: 'twitch', channel: 'a', category: null, sample: ['met him at the meth lab'] },
    policy({ blockedTerms: ['meth'] }),
  )
  expect(verdict.allowed).toBe(false)
})

test('blank and whitespace-only terms are ignored rather than blocking everything', () => {
  expect(
    screenMoment(
      { platform: 'twitch', channel: 'a', category: null, sample: ['hello'] },
      policy({ blockedTerms: ['', '   '] }),
    ),
  ).toEqual({ allowed: true })
})

test('the category check runs before the term check', () => {
  const verdict = screenMoment(
    { platform: 'twitch', channel: 'a', category: 'Politics', sample: ['cocaine'] },
    policy({ allowedCategories: ['GTA V'], blockedTerms: ['cocaine'] }),
  )
  expect(verdict.allowed).toBe(false)
  if (!verdict.allowed) expect(verdict.reason).toContain('category not allowed')
})

test('sameCategory compares case-insensitively and treats null as empty', () => {
  expect(sameCategory('GTA V', 'gta v')).toBe(true)
  expect(sameCategory(null, 'GTA V')).toBe(false)
  expect(sameCategory('  ', '')).toBe(true)
})

test('cleanList trims, drops blanks and duplicates, and caps length', () => {
  expect(cleanList([' Cocaine ', 'cocaine', '', 42, 'meth'], 10, 20)).toEqual([
    'Cocaine',
    'meth',
  ])
  expect(cleanList(['a', 'b', 'c'], 2, 20)).toEqual(['a', 'b'])
  expect(cleanList(['x'.repeat(50)], 5, 10)).toEqual(['x'.repeat(10)])
  expect(cleanList('not a list', 5, 10)).toEqual([])
})
