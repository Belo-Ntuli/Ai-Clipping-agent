/**
 * Phase A detection is chat-only: no stream bytes are captured yet, so the
 * score is a function of message velocity, hit words and emote bursts.
 * The audio signal is added with the clip capture in phase B, and the shape
 * below leaves room for it without changing callers.
 */
export type ChatMessage = { text: string; at: number }

export type Signal = {
  chatZ: number
  messages: number
  keywords: string[]
  emoteBurst: number
  windowSeconds: number
}

const KEYWORDS = [
  'lol',
  'lmao',
  'lmfao',
  'kekw',
  'omegalul',
  'lulw',
  'clip',
  'clip it',
  'no way',
  'what',
  'wtf',
  'holy',
  'sheesh',
  'bro',
  'omg',
  'insane',
  'nah',
  'yo',
  'chat',
  'sniped',
  'cooked',
  'unlucky',
  'gg',
]

/**
 * Twitch/Kick emotes people type as words, compared lower-cased.
 * Deliberately excludes ambiguous everyday words (`based`, `clap`, `pog` as a
 * word): those still register in caps via CAPS_EMOTE, but a normal sentence
 * must never inflate an emote burst.
 */
const KNOWN_EMOTES = new Set([
  'kekw',
  'lulw',
  'omegalul',
  'pog',
  'poggers',
  'lul',
  'trihard',
  'monkas',
  'pepehands',
  'sadge',
  'copium',
  'jebaited',
  'nodders',
  'catjam',
  'widepeepohappy',
])

const MAX_AGE_MS = 10 * 60_000

/**
 * An emote in raw text is either a known emote name, or an all-caps token of
 * four or more characters (`KEKW`, `BASED`, `POGGERS`). Case matters: the raw
 * message is tested, never the lower-cased copy, so ordinary repeated words
 * ("this", "mission") can never register as an emote.
 */
const CAPS_EMOTE = /^[A-Z][A-Z0-9]{3,}$/

/** Whole-word match, so `yo` does not fire inside "you" or `what` in "somewhat". */
export function hasWord(text: string, word: string): boolean {
  let from = 0
  while (from <= text.length - word.length) {
    const index = text.indexOf(word, from)
    if (index === -1) return false
    const before = index === 0 ? undefined : text[index - 1]
    const after = text[index + word.length]
    const boundary = (char: string | undefined) =>
      char === undefined || !/[a-z0-9]/i.test(char)
    if (boundary(before) && boundary(after)) return true
    from = index + 1
  }
  return false
}

export class ChatMeter {
  private messages: ChatMessage[] = []
  private history: number[] = []

  constructor(private readonly historyBuckets = 8) {}

  add(text: string, at = Date.now()) {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return
    this.messages.push({ text: clean.slice(0, 300), at })
    this.prune(at)
  }

  private prune(now: number) {
    const cutoff = now - MAX_AGE_MS
    if (this.messages.length && this.messages[0]!.at < cutoff)
      this.messages = this.messages.filter((message) => message.at >= cutoff)
  }

  get size() {
    return this.messages.length
  }

  /** Called once per tick; returns the window's signal breakdown. */
  tick(now: number, windowSeconds: number): Signal {
    this.prune(now)
    const windowStart = now - windowSeconds * 1000
    const recent = this.messages.filter((message) => message.at >= windowStart)
    const count = recent.length

    const previous = this.history
    let chatZ = 0
    if (previous.length >= 3) {
      const mean = previous.reduce((sum, value) => sum + value, 0) / previous.length
      const variance =
        previous.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        previous.length
      const deviation = Math.sqrt(variance)
      // A flat baseline (quiet chat) still counts if the window is loud.
      chatZ =
        deviation > 0.5 ? (count - mean) / deviation : count >= 8 ? 3 : 0
    }
    this.history.push(count)
    if (this.history.length > this.historyBuckets) this.history.shift()

    const keywords = KEYWORDS.filter((word) =>
      recent.some((message) => hasWord(message.text.toLowerCase(), word)),
    )

    // A burst is many *people* typing the same emote, so count distinct
    // messages rather than raw occurrences: one person spamming is not a burst.
    const perEmote = new Map<string, Set<number>>()
    recent.forEach((message, index) => {
      for (const token of message.text.split(/[^A-Za-z0-9]+/)) {
        if (!token) continue
        const lower = token.toLowerCase()
        const isEmote = KNOWN_EMOTES.has(lower) || CAPS_EMOTE.test(token)
        if (!isEmote) continue
        let seen = perEmote.get(lower)
        if (!seen) {
          seen = new Set()
          perEmote.set(lower, seen)
        }
        seen.add(index)
      }
    })
    let emoteBurst = 0
    for (const seen of perEmote.values())
      emoteBurst = Math.max(emoteBurst, seen.size)

    return {
      chatZ: Number(chatZ.toFixed(2)),
      messages: count,
      keywords,
      emoteBurst,
      windowSeconds,
    }
  }

  /** A few readable lines to show in the review card. */
  sample(now: number, windowSeconds: number, limit = 4): string[] {
    const windowStart = now - windowSeconds * 1000
    const recent = this.messages
      .filter((message) => message.at >= windowStart)
      .sort((left, right) => right.at - left.at)
    const interesting = recent.filter((message) => {
      const text = message.text.toLowerCase()
      return KEYWORDS.some((word) => hasWord(text, word))
    })
    const chosen = [...interesting, ...recent]
    const seen = new Set<string>()
    const out: string[] = []
    for (const message of chosen) {
      const key = message.text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(message.text)
      if (out.length >= limit) break
    }
    return out
  }
}

/** Score 0-100. Tuned so a clear chat spike plus hit words clears ~55. */
export function scoreSignal(signal: Signal): number {
  const velocity = Math.max(0, signal.chatZ) * 20
  const words = signal.keywords.length * 9
  // Burst is a count of distinct messages; a single message is not a burst.
  const burst = Math.max(0, signal.emoteBurst - 1) * 6
  const volume = signal.messages >= 12 ? 6 : 0
  return Math.max(0, Math.min(100, Math.round(velocity + words + burst + volume)))
}
