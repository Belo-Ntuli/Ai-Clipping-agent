import type { Platform, Policy } from './types'

export type ScreenInput = {
  platform: Platform
  channel: string
  /** Observed category, when the platform reports one. */
  category: string | null
  /** What was actually said in the window: chat lines, later a transcript. */
  sample: string[]
}

export type ScreenVerdict =
  | { allowed: true }
  | { allowed: false; reason: string }

/**
 * The owner's content rules, in one pure place so the runner and the dashboard
 * cannot drift. Deliberately literal: no fuzzy matching, no guessing intent.
 * Anything not clearly allowed is refused, and the reason is recorded so the
 * owner can see what was filtered and why.
 */
export function screenMoment(input: ScreenInput, policy: Policy): ScreenVerdict {
  if (policy.paused) return { allowed: false, reason: 'clipping is paused' }

  const allowed = policy.allowedCategories
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (allowed.length > 0) {
    const category = (input.category ?? '').trim().toLowerCase()
    if (!category)
      return {
        allowed: false,
        reason: 'category unknown, and only approved categories may be clipped',
      }
    if (!allowed.includes(category))
      return { allowed: false, reason: `category not allowed: ${input.category}` }
  }

  const haystack = input.sample.join('\n').toLowerCase()
  for (const raw of policy.blockedTerms) {
    const term = raw.trim().toLowerCase()
    if (term && haystack.includes(term))
      return { allowed: false, reason: `blocked term: ${raw.trim()}` }
  }

  return { allowed: true }
}

/** Case-insensitive category comparison, used by the UI's allow chips. */
export function sameCategory(a: string | null, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase()
}

/** Clean an owner-edited list: trimmed, de-duplicated, capped, no empties. */
export function cleanList(value: unknown, max: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim().slice(0, maxLength)
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}
