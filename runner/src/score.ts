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
  'clap',
  'nodders',
])

const MAX_AGE_MS = 10 * 60_000

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

    const lowered = recent.map((message) => message.text.toLowerCase())
    const keywords = KEYWORDS.filter((word) =>
      lowered.some((text) => text.includes(word)),
    )

    // A burst is the same token repeated by many people: the strongest
    // cheap proxy for "the whole chat reacted to the same thing".
    const counts = new Map<string, number>()
    for (const text of lowered)
      for (const token of text.split(/[^a-z0-9]+/)) {
        if (!token) continue
        const isEmote =
          KNOWN_EMOTES.has(token) || (token.length >= 3 && !/[^a-z]/.test(token) && token.length >= 4)
        if (!isEmote) continue
        counts.set(token, (counts.get(token) ?? 0) + 1)
      }
    let emoteBurst = 0
    for (const value of counts.values()) emoteBurst = Math.max(emoteBurst, value)

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
      return KEYWORDS.some((word) => text.includes(word))
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
  const burst = Math.max(0, signal.emoteBurst - 1) * 6
  const volume = signal.messages >= 12 ? 6 : 0
  return Math.max(0, Math.min(100, Math.round(velocity + words + burst + volume)))
}
