import type { LiveInfo } from './twitch'

/**
 * Kick public API: OAuth token via client credentials, then channel lookup.
 * Phase A only asks whether a channel is live. Kick exposes no clip-creation
 * endpoint and delivers chat only through webhooks, so the webhook receiver
 * lives on the dashboard in phase B rather than on this machine.
 *
 * The response shape is read defensively: if Kick changes or rejects a field
 * the runner reports "not live" instead of crashing the watch loop.
 */
export class KickClient {
  private token: { value: string; expiresAt: number } | null = null

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret)
  }

  private async appToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000)
      return this.token.value
    const response = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok)
      throw new Error(`Kick token request failed (${response.status})`)
    const payload = (await response.json()) as {
      access_token?: string
      expires_in?: number
    }
    if (!payload.access_token) throw new Error('Kick token response was empty')
    this.token = {
      value: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    }
    return this.token.value
  }

  async liveStatus(slugs: string[]): Promise<Map<string, LiveInfo>> {
    const result = new Map<string, LiveInfo>()
    for (const slug of slugs)
      result.set(slug, { live: false, viewers: null, category: null })
    if (!this.configured || slugs.length === 0) return result
    const token = await this.appToken()
    for (const slug of slugs.slice(0, 5)) {
      const response = await fetch(
        `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(15_000),
        },
      )
      if (!response.ok)
        throw new Error(`Kick channels request failed (${response.status})`)
      const payload = (await response.json()) as {
        data?: Array<{
          slug?: string
          stream?: { is_live?: boolean; viewer_count?: number }
          is_live?: boolean
        }>
      }
      const channel = payload.data?.[0]
      if (!channel) continue
      const stream = channel.stream
      const live = stream?.is_live ?? channel.is_live ?? false
      result.set(slug, {
        live,
        viewers:
          typeof stream?.viewer_count === 'number' ? stream.viewer_count : null,
        // Kick's category field is not in the response shape we have verified,
        // so it stays null: an allowlist therefore refuses Kick moments until
        // the category is known. Failing closed is the point.
        category: null,
      })
    }
    return result
  }
}
