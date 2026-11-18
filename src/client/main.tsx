import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  Candidate,
  Overview,
  Platform,
  Policy,
  Session,
} from '../shared/types'
import './style.css'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => {
    throw new Error('Could not reach the dashboard. Please try again.')
  })) as T & { error?: string }
  if (!response.ok)
    throw new Error(body.error || 'The request failed. Please try again.')
  return body
}

const age = (at: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

type View = 'live' | 'review' | 'sources' | 'runners'

const emptyOverview: Overview = {
  sources: [],
  candidates: [],
  events: [],
  runners: [],
  policy: { paused: false, allowedCategories: [], blockedTerms: [], updatedAt: 0 },
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [overview, setOverview] = useState<Overview>(emptyOverview)
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<View>('live')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [issuedToken, setIssuedToken] = useState('')
  const [runnerName, setRunnerName] = useState('This Mac')
  const [platform, setPlatform] = useState<Platform>('twitch')
  const [channel, setChannel] = useState('')
  const [label, setLabel] = useState('')
  const [categoryDraft, setCategoryDraft] = useState('')
  const [termDraft, setTermDraft] = useState('')
  const sessionRef = useRef<Session | null>(null)

  const enabled = Boolean(loaded && session?.user && session.database)

  const refresh = useCallback(async () => {
    if (!sessionRef.current?.user) return
    try {
      setOverview(await request<Overview>('/api/overview'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lost the dashboard connection.')
    }
  }, [])

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const current = await request<Session>('/api/session')
        if (!live) return
        sessionRef.current = current
        setSession(current)
        if (current.user && current.database) {
          const first = await request<Overview>('/api/overview')
          if (live) setOverview(first)
        }
      } catch (e) {
        if (live)
          setError(
            e instanceof Error ? e.message : 'Could not load the dashboard.',
          )
      } finally {
        if (live) setLoaded(true)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  // Phase A uses polling: one small request every 3s keeps the feed live
  // without a second transport. Realtime rooms land with multi-runner support.
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [enabled, refresh])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  const pending = useMemo(
    () => overview.candidates.filter((item) => item.status === 'new'),
    [overview.candidates],
  )
  // Filtered moments are listed apart: they were never reviewable, and no clip
  // was cut for them.
  const blocked = useMemo(
    () => overview.candidates.filter((item) => item.status === 'blocked'),
    [overview.candidates],
  )
  const queue = useMemo(
    () =>
      overview.candidates.filter(
        (item) => item.status === 'approved' || item.status === 'rejected',
      ),
    [overview.candidates],
  )
  const liveSources = overview.sources.filter((source) => source.active)
  // Categories the platforms report right now, offered as one-click allows.
  const seenCategories = useMemo(() => {
    const seen = new Set<string>()
    for (const source of overview.sources) {
      const category = source.category?.trim()
      if (category) seen.add(category)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [overview.sources])
  const onlineRunners = overview.runners.filter((runner) => runner.online)

  async function addSource(event: React.FormEvent) {
    event.preventDefault()
    if (!enabled || busy || !channel.trim()) return
    await act(async () => {
      await request('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          channel: channel.trim(),
          ...(label.trim() ? { label: label.trim() } : {}),
        }),
      })
      setChannel('')
      setLabel('')
    })
  }

  async function savePolicy(patch: Partial<Policy>) {
    if (!enabled || busy) return
    await act(async () => {
      await request('/api/policy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    })
  }

  async function decide(candidate: Candidate, decision: 'approved' | 'rejected') {
    if (!enabled || busy) return
    await act(async () => {
      await request(`/api/candidates/${candidate.id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
    })
  }

  return (
    <main>
      <header>
        <div className="brand">
          <span className="wordmark">Clipper</span>
          <span className="phase">Phase A · watch &amp; detect</span>
        </div>
        <div className="account">
          <span className={onlineRunners.length ? 'pill on' : 'pill'}>
            <i />
            {onlineRunners.length
              ? `${onlineRunners.length} runner${onlineRunners.length > 1 ? 's' : ''} online`
              : 'no runner online'}
          </span>
          {session?.mode === 'local' ? (
            <span className="badge">Local preview</span>
          ) : session?.user ? (
            <>
              <span>
                {session.user.name || session.user.email || 'Signed in'}
              </span>
              <form method="post" action="/auth/freebuff/signout">
                <button className="quiet">Sign out</button>
              </form>
            </>
          ) : session?.mode === 'freebuff' ? (
            <a className="button" href="/auth/freebuff/signin?returnTo=%2F">
              Sign in with Freebuff
            </a>
          ) : null}
        </div>
      </header>

      {session && !enabled && (
        <p className="notice">
          {session.mode === 'setup' || !session.database
            ? 'This app is still being set up. Please try again later.'
            : 'Sign in with Freebuff to open your clipper.'}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <nav className="tabs" aria-label="Sections">
        {(['live', 'review', 'sources', 'runners'] as View[]).map((item) => (
          <button
            key={item}
            className={view === item ? 'tab active' : 'tab'}
            onClick={() => setView(item)}
            aria-current={view === item ? 'page' : undefined}
          >
            {item === 'live'
              ? 'Live'
              : item === 'review'
                ? `Review${pending.length ? ` · ${pending.length}` : ''}`
                : item === 'sources'
                  ? 'Channels'
                  : 'Runners'}
          </button>
        ))}
      </nav>

      {view === 'live' && (
        <div className="layout">
          <section aria-labelledby="channels-title">
            <div className="section-heading">
              <h2 id="channels-title">Watchlist</h2>
              <span>
                {liveSources.filter((source) => source.live).length}/
                {liveSources.length} live
              </span>
            </div>
            {!liveSources.length ? (
              <div className="empty">
                <h3>No channels yet</h3>
                <p>Add a Twitch or Kick channel under Channels.</p>
              </div>
            ) : (
              <ul className="channels">
                {liveSources.map((source) => (
                  <li key={source.id}>
                    <span className={source.live ? 'dot on' : 'dot'} />
                    <div>
                      <strong>{source.label || source.channel}</strong>
                      <em>
                        {source.platform} · {source.channel}
                      </em>
                    </div>
                    <span className="viewers">
                      {source.live
                        ? `${(source.viewers ?? 0).toLocaleString()} viewers`
                        : 'offline'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="section-heading spaced">
              <h2>Agent log</h2>
              <span>{overview.events.length}</span>
            </div>
            {!overview.events.length ? (
              <p className="empty-inline">
                Nothing from the runner yet. Start it with{' '}
                <code>bun run doctor</code> then{' '}
                <code>bun run start</code>.
              </p>
            ) : (
              <ul className="log">
                {overview.events.map((event) => (
                  <li key={event.id} className={event.level}>
                    <time>{clock(event.createdAt)}</time>
                    <b>{event.stage}</b>
                    <span>{event.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="moments-title">
            <div className="section-heading">
              <h2 id="moments-title">Moments detected</h2>
              <span>{overview.candidates.length}</span>
            </div>
            {!overview.candidates.length ? (
              <div className="empty">
                <h3>Listening for spikes</h3>
                <p>
                  The runner scores chat every tick. Candidates appear here the
                  moment a channel goes wild.
                </p>
              </div>
            ) : (
              <ul className="moments">
                {overview.candidates.slice(0, 8).map((candidate) => (
                  <li key={candidate.id}>
                    <div className="moment-head">
                      <span className="score">{candidate.score}</span>
                      <div>
                        <strong>{candidate.channel}</strong>
                        <em>
                          {candidate.platform} · {clock(candidate.windowEnd)} ·{' '}
                          {candidate.signals.messages} msgs
                        </em>
                      </div>
                      {candidate.clip && (
                        <span className="clip-badge" title={candidate.clip.fileName}>
                          clip
                        </span>
                      )}
                      <span className={`status ${candidate.status}`}>
                        {candidate.status}
                      </span>
                    </div>
                    {candidate.status === 'blocked' && candidate.blockReason && (
                      <p className="chat-sample filtered">
                        Filtered: {candidate.blockReason}
                      </p>
                    )}
                    {candidate.sample.length > 0 && (
                      <p className="chat-sample">
                        {candidate.sample.slice(0, 3).join('  ·  ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {view === 'review' && (
        <section aria-labelledby="review-title">
          <div className="section-heading">
            <h2 id="review-title">Review queue</h2>
            <span>{pending.length} waiting</span>
          </div>
          <p className="hint">
            Approving marks a moment as keep. Clips are cut on the runner and
            stay there: there is no upload or auto-poster connected yet.
          </p>
          {!pending.length ? (
            <div className="empty">
              <h3>Nothing to review</h3>
              <p>Detected moments land here for approval.</p>
            </div>
          ) : (
            <ul className="review">
              {pending.map((candidate) => (
                <li key={candidate.id}>
                  <div className="review-body">
                    <div className="moment-head">
                      <span className="score">{candidate.score}</span>
                      <div>
                        <strong>
                          {candidate.channel} on {candidate.platform}
                        </strong>
                        <em>
                          {clock(candidate.windowStart)} –{' '}
                          {clock(candidate.windowEnd)} ·{' '}
                          {candidate.signals.windowSeconds}s window ·{' '}
                          {candidate.signals.messages} messages
                        </em>
                      </div>
                    </div>
                    <div className="signals">
                      <span>chat ×{candidate.signals.chatZ.toFixed(1)}</span>
                      {candidate.signals.keywords.map((word) => (
                        <span key={word} className="keyword">
                          {word}
                        </span>
                      ))}
                      {candidate.signals.emoteBurst > 0 && (
                        <span>emote burst ×{candidate.signals.emoteBurst}</span>
                      )}
                      <span className="muted">chat signal only</span>
                    </div>
                    {candidate.clip ? (
                      <p className="clip-line">
                        Clip cut on the runner · {candidate.clip.fileName} ·{' '}
                        {(candidate.clip.durationMs / 1000).toFixed(1)}s ·{' '}
                        {(candidate.clip.bytes / 1_048_576).toFixed(1)} MB
                      </p>
                    ) : (
                      <p className="clip-line muted">
                        No clip: this moment was detected from chat only.
                      </p>
                    )}
                    {candidate.sample.length > 0 && (
                      <ul className="chat-lines">
                        {candidate.sample.map((line, index) => (
                          <li key={index}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="review-actions">
                    <button
                      disabled={busy}
                      onClick={() => void decide(candidate, 'approved')}
                    >
                      Approve
                    </button>
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() => void decide(candidate, 'rejected')}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {blocked.length > 0 && (
            <>
              <div className="section-heading spaced">
                <h2>Filtered by your rules</h2>
                <span>{blocked.length}</span>
              </div>
              <p className="hint">
                These never reached the queue and no clip was cut for them.
                Reasons come from your content rules.
              </p>
              <ul className="decided">
                {blocked.slice(0, 12).map((candidate) => (
                  <li key={candidate.id}>
                    <span className="status blocked">blocked</span>
                    <span>
                      {candidate.channel} · {clock(candidate.windowEnd)}
                    </span>
                    <span className="muted">
                      {candidate.blockReason ?? 'content rule'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {queue.length > 0 && (
            <>
              <div className="section-heading spaced">
                <h2>Decided</h2>
                <span>{queue.length}</span>
              </div>
              <ul className="decided">
                {queue.slice(0, 12).map((candidate) => (
                  <li key={candidate.id}>
                    <span className={`status ${candidate.status}`}>
                      {candidate.status}
                    </span>
                    <span>
                      {candidate.channel} · {clock(candidate.windowEnd)}
                    </span>
                    <span className="muted">score {candidate.score}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {view === 'sources' && (
        <div className="layout">
          <section aria-labelledby="add-title">
            <h2 id="add-title">Add a channel</h2>
            <form onSubmit={addSource} className="stack">
              <label htmlFor="platform">Platform</label>
              <select
                id="platform"
                value={platform}
                onChange={(e) => setPlatform(e.target.value as Platform)}
              >
                <option value="twitch">Twitch</option>
                <option value="kick">Kick</option>
              </select>
              <label htmlFor="channel">Channel name</label>
              <input
                id="channel"
                required
                maxLength={50}
                placeholder="e.g. xqc"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              />
              <label htmlFor="label">Label (optional)</label>
              <input
                id="label"
                maxLength={60}
                placeholder="Launch night"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <button disabled={!enabled || busy || !channel.trim()}>
                {busy ? 'Saving…' : 'Add to watchlist'}
              </button>
            </form>
            <p className="hint">
              Kick chat needs a public webhook receiver, so Kick channels are
              detected at stream level first. Twitch chat is read directly by
              the runner.
            </p>
          </section>
          <section aria-labelledby="watchlist-title">
            <div className="section-heading">
              <h2 id="watchlist-title">Channels</h2>
              <span>{overview.sources.length}</span>
            </div>
            {!overview.sources.length ? (
              <div className="empty">
                <h3>Nothing watched yet</h3>
                <p>Add your first channel to start scanning.</p>
              </div>
            ) : (
              <ul className="channels editable">
                {overview.sources.map((source) => (
                  <li key={source.id}>
                    <span
                      className={source.live && source.active ? 'dot on' : 'dot'}
                    />
                    <div>
                      <strong>{source.label || source.channel}</strong>
                      <em>
                        {source.platform} · {source.channel}
                        {source.category ? ` · ${source.category}` : ''}
                        {source.active ? '' : ' · paused'}
                      </em>
                      {source.approvedAt === null && (
                        <span className="status blocked">not approved</span>
                      )}
                    </div>
                    <div className="row-actions">
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await request(`/api/sources/${source.id}`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ active: !source.active }),
                            })
                          })
                        }
                      >
                        {source.active ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await request(`/api/sources/${source.id}`, {
                              method: 'DELETE',
                            })
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="rules-title" className="rules">
            <div className="section-heading">
              <h2 id="rules-title">Content rules</h2>
              <span>
                {overview.policy.paused ? 'paused' : 'enforced'}
              </span>
            </div>
            <p className="hint">
              Every moment is checked against these before anything is cut. A
              refused moment is listed as filtered, with its reason.
            </p>
            <label className="switch" htmlFor="paused">
              <input
                id="paused"
                type="checkbox"
                checked={overview.policy.paused}
                disabled={!enabled || busy}
                onChange={() =>
                  void savePolicy({ paused: !overview.policy.paused })
                }
              />
              Pause all clipping
            </label>

            <div className="rule-group">
              <h3>Only these categories</h3>
              <p className="hint">
                Empty means any category. Categories come from the platform, so
                a channel with no reported category is refused while this list
                is set.
              </p>
              <ul className="chips">
                {overview.policy.allowedCategories.map((entry) => (
                  <li key={entry}>
                    {entry}
                    <button
                      aria-label={`Remove ${entry}`}
                      disabled={busy}
                      onClick={() =>
                        void savePolicy({
                          allowedCategories:
                            overview.policy.allowedCategories.filter(
                              (item) => item !== entry,
                            ),
                        })
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <form
                className="inline-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const entry = categoryDraft.trim()
                  if (!entry) return
                  void savePolicy({
                    allowedCategories: [
                      ...overview.policy.allowedCategories,
                      entry,
                    ],
                  }).then(() => setCategoryDraft(''))
                }}
              >
                <input
                  aria-label="Category to allow"
                  maxLength={60}
                  placeholder="e.g. Grand Theft Auto V"
                  value={categoryDraft}
                  onChange={(e) => setCategoryDraft(e.target.value)}
                />
                <button disabled={!enabled || busy || !categoryDraft.trim()}>
                  Add
                </button>
              </form>
              {seenCategories.length > 0 && (
                <p className="hint">
                  Seen now:{' '}
                  {seenCategories.map((entry) => (
                    <button
                      key={entry}
                      className="quiet"
                      disabled={busy}
                      onClick={() =>
                        void savePolicy({
                          allowedCategories: [
                            ...overview.policy.allowedCategories,
                            entry,
                          ],
                        })
                      }
                    >
                      {entry}
                    </button>
                  ))}
                </p>
              )}
            </div>

            <div className="rule-group">
              <h3>Never clip these words</h3>
              <p className="hint">
                If one of these appears in the chat around a moment, the moment
                is refused and no clip is cut.
              </p>
              <ul className="chips blocked">
                {overview.policy.blockedTerms.map((entry) => (
                  <li key={entry}>
                    {entry}
                    <button
                      aria-label={`Remove ${entry}`}
                      disabled={busy}
                      onClick={() =>
                        void savePolicy({
                          blockedTerms: overview.policy.blockedTerms.filter(
                            (item) => item !== entry,
                          ),
                        })
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <form
                className="inline-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const entry = termDraft.trim()
                  if (!entry) return
                  void savePolicy({
                    blockedTerms: [...overview.policy.blockedTerms, entry],
                  }).then(() => setTermDraft(''))
                }}
              >
                <input
                  aria-label="Word to block"
                  maxLength={40}
                  placeholder="e.g. a topic you never want clipped"
                  value={termDraft}
                  onChange={(e) => setTermDraft(e.target.value)}
                />
                <button disabled={!enabled || busy || !termDraft.trim()}>
                  Block
                </button>
              </form>
            </div>
          </section>
        </div>
      )}

      {view === 'runners' && (
        <section aria-labelledby="runners-title">
          <div className="section-heading">
            <h2 id="runners-title">Runners</h2>
            <span>{onlineRunners.length} online</span>
          </div>
          <p className="hint">
            A runner is the process that watches streams on your Mac. Each one
            gets its own token, valid until you delete it.
          </p>
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!enabled || busy || !runnerName.trim()) return
              void act(async () => {
                const result = await request<{ token: string }>('/api/runners', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: runnerName.trim() }),
                })
                setIssuedToken(result.token)
              })
            }}
          >
            <input
              aria-label="Runner name"
              maxLength={40}
              value={runnerName}
              onChange={(e) => setRunnerName(e.target.value)}
            />
            <button disabled={!enabled || busy || !runnerName.trim()}>
              Create runner
            </button>
          </form>
          {issuedToken && (
            <div className="token">
              <p>
                Copy this token into <code>runner/.env</code> as{' '}
                <code>CLIPPER_RUNNER_TOKEN</code>. It is shown once.
              </p>
              <code className="secret">{issuedToken}</code>
            </div>
          )}
          {!overview.runners.length ? (
            <div className="empty">
              <h3>No runners yet</h3>
              <p>Create one, then start the runner on your Mac.</p>
            </div>
          ) : (
            <ul className="channels">
              {overview.runners.map((runner) => (
                <li key={runner.id}>
                  <span className={runner.online ? 'dot on' : 'dot'} />
                  <div>
                    <strong>{runner.name}</strong>
                    <em>
                      {runner.lastSeenAt
                        ? `seen ${age(runner.lastSeenAt)}`
                        : 'never connected'}
                    </em>
                  </div>
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await request(`/api/runners/${runner.id}`, {
                          method: 'DELETE',
                        })
                      })
                    }
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
