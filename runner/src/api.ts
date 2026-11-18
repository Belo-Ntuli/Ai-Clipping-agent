import type { Policy, Source } from '../../src/shared/types'

export type Observed = {
  sourceId: string
  live: boolean
  viewers: number | null
  /** Whatever category the platform reports; drives the owner's allowlist. */
  category: string | null
}

export type ClipPayload = {
  fileName: string
  bytes: number
  durationMs: number
}

export type CandidatePayload = {
  sourceId: string
  platform: 'twitch' | 'kick'
  channel: string
  score: number
  signals: {
    chatZ: number
    messages: number
    keywords: string[]
    emoteBurst: number
    windowSeconds: number
  }
  sample: string[]
  windowStart: number
  windowEnd: number
  clip?: ClipPayload
}

export type EventPayload = {
  level: 'info' | 'warn' | 'error'
  stage: string
  message: string
}

export class DashboardClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      let detail: string | undefined
      try {
        const body = (await response.json()) as { error?: unknown }
        if (typeof body?.error === 'string') detail = body.error
      } catch {
        detail = undefined
      }
      throw new Error(detail || `${path} failed (${response.status})`)
    }
    return (await response.json()) as T
  }

  /**
   * Proves the runner is alive and returns the current watchlist plus the
   * owner's policy, so a moment can be refused before any encoding work.
   */
  heartbeat(
    observed: Observed[],
  ): Promise<{ sources: Source[]; policy: Policy }> {
    return this.call('/api/runner/heartbeat', { observed })
  }

  candidates(candidates: CandidatePayload[]): Promise<{ accepted: unknown[] }> {
    return this.call('/api/runner/candidates', { candidates })
  }

  events(events: EventPayload[]): Promise<{ ok: boolean }> {
    return this.call('/api/runner/events', { events })
  }
}
