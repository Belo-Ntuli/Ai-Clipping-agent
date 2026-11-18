export type LiveInfo = { live: boolean; viewers: number | null }

/**
 * Twitch: app access token for public reads, and anonymous IRC for chat.
 * Anonymous chat needs no OAuth and no inbound port, which is why it is the
 * phase A chat source. Clipping via the Helix clip API is phase B.
 */
export class TwitchClient {
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
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
    })
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok)
      throw new Error(`Twitch token request failed (${response.status})`)
    const payload = (await response.json()) as {
      access_token?: string
      expires_in?: number
    }
    if (!payload.access_token) throw new Error('Twitch token response was empty')
    this.token = {
      value: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    }
    return this.token.value
  }

  /** One request covers up to 100 channels. */
  async liveStatus(logins: string[]): Promise<Map<string, LiveInfo>> {
    const result = new Map<string, LiveInfo>()
    for (const login of logins) result.set(login, { live: false, viewers: null })
    if (!this.configured || logins.length === 0) return result
    const token = await this.appToken()
    const params = new URLSearchParams()
    for (const login of logins.slice(0, 100)) params.append('user_login', login)
    const response = await fetch(
      `https://api.twitch.tv/helix/streams?${params.toString()}`,
      {
        headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!response.ok)
      throw new Error(`Twitch streams request failed (${response.status})`)
    const payload = (await response.json()) as {
      data?: Array<{ user_login?: string; viewer_count?: number }>
    }
    for (const stream of payload.data ?? []) {
      const login = stream.user_login?.toLowerCase()
      if (!login) continue
      result.set(login, {
        live: true,
        viewers:
          typeof stream.viewer_count === 'number' ? stream.viewer_count : null,
      })
    }
    return result
  }

  /**
   * Reads chat for one channel. Returns a stop function. Reconnects with
   * backoff so a dropped socket does not silently end detection.
   */
  watchChat(
    channel: string,
    onMessage: (text: string) => void,
    onState?: (state: 'open' | 'closed') => void,
  ): () => void {
    const nickname = `justinfan${Math.floor(Math.random() * 90_000) + 10_000}`
    let stopped = false
    let attempt = 0
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (stopped) return
      attempt += 1
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
      retry = setTimeout(connect, wait)
    }

    const connect = () => {
      if (stopped) return
      try {
        socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
      } catch {
        schedule()
        return
      }
      socket.addEventListener('open', () => {
        attempt = 0
        onState?.('open')
        socket?.send(`PASS ${nickname}`)
        socket?.send(`NICK ${nickname}`)
        socket?.send('CAP REQ :twitch.tv/tags')
        socket?.send(`JOIN #${channel}`)
      })
      socket.addEventListener('message', (event) => {
        const raw = typeof event.data === 'string' ? event.data : ''
        for (const line of raw.split('\r\n')) {
          if (!line) continue
          if (line.startsWith('PING')) {
            socket?.send('PONG :tmi.twitch.tv')
            continue
          }
          const marker = line.indexOf('PRIVMSG')
          if (marker === -1) continue
          const rest = line.slice(marker)
          const separator = rest.indexOf(' :')
          if (separator === -1) continue
          const text = rest.slice(separator + 2)
          if (text) onMessage(text)
        }
      })
      socket.addEventListener('close', () => {
        onState?.('closed')
        if (!stopped) schedule()
      })
      socket.addEventListener('error', () => {
        try {
          socket?.close()
        } catch {
          /* the close handler reschedules */
        }
      })
    }

    connect()
    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      try {
        socket?.close()
      } catch {
        /* already closed */
      }
    }
  }
}
