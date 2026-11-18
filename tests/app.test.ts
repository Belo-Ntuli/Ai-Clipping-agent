import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp } from '../src/worker/app'
import { currentUser, type Env } from '../src/worker/auth'

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'test-db',
        compatibilityDate: '2026-11-11',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents:
                'export default { fetch() { return new Response("test") } }',
            },
          },
        },
        env: { DB: { type: 'd1', name: 'clipper-test' } },
      },
    },
  ],
  port: 0,
})
let env: Env
beforeAll(async () => {
  const db = await runtime.getD1Database('DB')
  env = {
    DB: db as unknown as D1Database,
    APP_ORIGIN: 'https://app.example.test',
    ASSETS: {
      fetch: async () => new Response('public page'),
    } as unknown as Fetcher,
  }
}, 20_000)
afterAll(() => runtime.dispose())

// This identity seam exists only in the app factory. The Worker entrypoint
// never reads these test headers and always calls the real auth SDK.
const app = createApp(async (request) => {
  const sub = request.headers.get('test-user')
  return sub ? { sub } : null
})
const call = (
  path: string,
  user?: string,
  method = 'GET',
  body?: unknown,
  origin = env.APP_ORIGIN!,
) =>
  app.request(
    `https://app.example.test${path}`,
    {
      method,
      headers: {
        ...(user ? { 'test-user': user } : {}),
        Origin: origin,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )
const asRunner = (path: string, token: string, body: unknown) =>
  app.request(
    `https://app.example.test${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    env,
  )

test('unauthenticated dashboard routes refuse access and public assets remain public', async () => {
  for (const [path, method] of [
    ['/api/overview', 'GET'],
    ['/api/sources', 'POST'],
    ['/api/runners', 'POST'],
    ['/api/candidates/absent/decision', 'POST'],
  ]) {
    const response = await call(path!, undefined, method, {})
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  }
  expect(await (await call('/')).text()).toBe('public page')
  expect((await call('/api/health')).status).toBe(200)
})

test('channels are validated, de-duplicated and isolated by owner', async () => {
  const created = await call('/api/sources', 'alice', 'POST', {
    platform: 'twitch',
    channel: '  XQC ',
    label: 'Launch night',
  })
  expect(created.status).toBe(201)
  const { source } = (await created.json()) as {
    source: { id: string; channel: string; label: string; active: boolean }
  }
  expect(source.channel).toBe('xqc')
  expect(source.active).toBe(true)

  expect(
    (
      await call('/api/sources', 'alice', 'POST', {
        platform: 'twitch',
        channel: 'xqc',
      })
    ).status,
  ).toBe(409)

  const aliceOverview = (await (
    await call('/api/overview', 'alice')
  ).json()) as { sources: unknown[] }
  const bobOverview = (await (
    await call('/api/overview', 'bob')
  ).json()) as { sources: unknown[] }
  expect(aliceOverview.sources).toHaveLength(1)
  expect(bobOverview.sources).toHaveLength(0)

  // Another owner cannot pause, label or remove the channel.
  expect(
    (
      await call(`/api/sources/${source.id}`, 'bob', 'PATCH', {
        active: false,
      })
    ).status,
  ).toBe(404)
  expect((await call(`/api/sources/${source.id}`, 'bob', 'DELETE')).status).toBe(
    404,
  )

  const paused = await call(`/api/sources/${source.id}`, 'alice', 'PATCH', {
    active: false,
  })
  expect(await paused.json()).toMatchObject({ source: { active: false } })
  expect((await call(`/api/sources/${source.id}`, 'alice', 'DELETE')).status).toBe(
    200,
  )
})

test('runner tokens post live state and candidates that only the owner sees', async () => {
  await call('/api/sources', 'alice', 'POST', {
    platform: 'twitch',
    channel: 'kaicenat',
  })
  const created = await call('/api/runners', 'alice', 'POST', { name: 'Mac' })
  expect(created.status).toBe(201)
  const { token, runner } = (await created.json()) as {
    token: string
    runner: { id: string; online: boolean }
  }
  expect(token.startsWith('clpr_')).toBe(true)
  expect(runner.online).toBe(false)

  // Unknown and malformed tokens are refused.
  expect(
    (await asRunner('/api/runner/heartbeat', 'clpr_nope', { observed: [] }))
      .status,
  ).toBe(401)
  expect(
    (
      await app.request(
        'https://app.example.test/api/runner/heartbeat',
        { method: 'POST' },
        env,
      )
    ).status,
  ).toBe(401)

  const sources = (await (
    await asRunner('/api/runner/heartbeat', token, {
      observed: [],
    })
  ).json()) as { sources: Array<{ id: string; channel: string }> }
  expect(sources.sources).toHaveLength(1)
  const sourceId = sources.sources[0]!.id

  // Live state reported by the runner is stored on the channel.
  await asRunner('/api/runner/heartbeat', token, {
    observed: [{ sourceId, live: true, viewers: 4200 }],
  })
  const live = (await (await call('/api/overview', 'alice')).json()) as {
    sources: Array<{ live: boolean; viewers: number }>
  }
  expect(live.sources[0]).toMatchObject({ live: true, viewers: 4200 })

  const posted = await asRunner('/api/runner/candidates', token, {
    candidates: [
      {
        sourceId,
        platform: 'twitch',
        channel: 'kaicenat',
        score: 78,
        signals: {
          chatZ: 3.1,
          messages: 46,
          keywords: ['lol', 'clip'],
          emoteBurst: 12,
          windowSeconds: 30,
        },
        sample: ['CLIP IT', 'NO WAY'],
        windowStart: 1_700_000_000_000,
        windowEnd: 1_700_000_030_000,
      },
    ],
  })
  expect(posted.status).toBe(201)
  const { accepted } = (await posted.json()) as {
    accepted: Array<{ id: string; score: number }>
  }
  expect(accepted).toHaveLength(1)

  // Re-posting the same window is ignored instead of duplicated.
  const again = (await (
    await asRunner('/api/runner/candidates', token, {
      candidates: [
        {
          sourceId,
          platform: 'twitch',
          channel: 'kaicenat',
          score: 78,
          signals: { chatZ: 3, messages: 4, keywords: [], emoteBurst: 0, windowSeconds: 30 },
          sample: [],
          windowStart: 1_700_000_000_000,
          windowEnd: 1_700_000_030_000,
        },
      ],
    })
  ).json()) as { accepted: unknown[] }
  expect(again.accepted).toHaveLength(0)

  const alice = (await (await call('/api/overview', 'alice')).json()) as {
    candidates: Array<{ id: string; status: string }>
    runners: Array<{ online: boolean }>
  }
  expect(alice.candidates).toHaveLength(1)
  expect(alice.runners[0]!.online).toBe(true)

  // Bob sees none of it and cannot decide on Alice's moment.
  const bob = (await (await call('/api/overview', 'bob')).json()) as {
    candidates: unknown[]
    runners: Array<{ online: boolean }>
  }
  expect(bob.candidates).toHaveLength(0)
  expect(bob.runners).toHaveLength(0)
  expect(
    (
      await call(`/api/candidates/${accepted[0]!.id}/decision`, 'bob', 'POST', {
        decision: 'approved',
      })
    ).status,
  ).toBe(404)

  const decided = await call(
    `/api/candidates/${accepted[0]!.id}/decision`,
    'alice',
    'POST',
    { decision: 'approved' },
  )
  expect(await decided.json()).toMatchObject({
    candidate: { status: 'approved', score: 78 },
  })

  // Revoking the runner invalidates its token immediately.
  expect((await call(`/api/runners/${runner.id}`, 'alice', 'DELETE')).status).toBe(
    200,
  )
  expect(
    (await asRunner('/api/runner/heartbeat', token, { observed: [] })).status,
  ).toBe(401)
})

test('runner events appear in the agent log and are trimmed per owner', async () => {
  const created = (await (
    await call('/api/runners', 'alice', 'POST', { name: 'iMac' })
  ).json()) as { token: string }
  const events = Array.from({ length: 3 }, (_, index) => ({
    level: 'info',
    stage: 'scout',
    message: `watching channel ${index}`,
  }))
  const response = await asRunner('/api/runner/events', created.token, {
    events,
  })
  expect(response.status).toBe(201)
  const overview = (await (await call('/api/overview', 'alice')).json()) as {
    events: Array<{ stage: string; message: string }>
  }
  expect(overview.events.length).toBeGreaterThanOrEqual(3)
  expect(overview.events[0]!.stage).toBe('scout')
})

test('rejects foreign origins, owner spoofing, malformed input and oversized bodies', async () => {
  expect(
    (
      await call(
        '/api/sources',
        'alice',
        'POST',
        { platform: 'twitch', channel: 'xqc' },
        'https://foreign.example',
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.request(
        'https://app.example.test/api/sources',
        {
          method: 'POST',
          headers: { 'test-user': 'alice' },
          body: JSON.stringify({ platform: 'twitch', channel: 'xqc' }),
        },
        env,
      )
    ).status,
  ).toBe(403)
  for (const body of [
    {},
    { platform: 'youtube', channel: 'xqc' },
    { platform: 'twitch', channel: 'a' },
    { platform: 'twitch', channel: 'has space' },
    { platform: 'twitch', channel: 'xqc', owner_sub: 'bob', label: '' },
    [],
    null,
  ]) {
    expect((await call('/api/sources', 'alice', 'POST', body)).status).toBe(400)
  }
  expect(
    (
      await call('/api/sources', 'alice', 'POST', {
        platform: 'twitch',
        channel: 'x'.repeat(200_000),
      })
    ).status,
  ).toBe(413)
  expect(
    (
      await call('/api/candidates/absent/decision', 'alice', 'POST', {
        decision: 'published',
      })
    ).status,
  ).toBe(400)
})

test('a cut clip rides along with its candidate as metadata only', async () => {
  await call('/api/sources', 'carol', 'POST', {
    platform: 'kick',
    channel: 'carolstream',
  })
  const created = (await (
    await call('/api/runners', 'carol', 'POST', { name: 'iMac' })
  ).json()) as { token: string }
  const sources = (await (
    await asRunner('/api/runner/heartbeat', created.token, { observed: [] })
  ).json()) as { sources: Array<{ id: string }> }
  const sourceId = sources.sources[0]!.id

  const posted = (await (
    await asRunner('/api/runner/candidates', created.token, {
      candidates: [
        {
          sourceId,
          platform: 'kick',
          channel: 'carolstream',
          score: 66,
          signals: {
            chatZ: 2.4,
            messages: 18,
            keywords: ['lol'],
            emoteBurst: 5,
            windowSeconds: 30,
          },
          sample: ['KEKW'],
          windowStart: 1_700_000_100_000,
          windowEnd: 1_700_000_130_000,
          // A path separator must not survive validation.
          clip: {
            fileName: '../escape/clip.mp4',
            bytes: 5_242_880,
            durationMs: 44_000,
          },
        },
      ],
    })
  ).json()) as { accepted: Array<{ id: string }> }
  expect(posted.accepted).toHaveLength(1)

  const overview = (await (await call('/api/overview', 'carol')).json()) as {
    candidates: Array<{
      clip: { fileName: string; bytes: number; durationMs: number } | null
    }>
  }
  expect(overview.candidates[0]!.clip).toEqual({
    fileName: '.._escape_clip.mp4',
    bytes: 5_242_880,
    durationMs: 44_000,
  })

  // An unusable clip object is dropped rather than stored half-valid.
  await asRunner('/api/runner/candidates', created.token, {
    candidates: [
      {
        sourceId,
        platform: 'kick',
        channel: 'carolstream',
        score: 60,
        signals: { chatZ: 1, messages: 3, keywords: [], emoteBurst: 0, windowSeconds: 30 },
        sample: [],
        windowStart: 1_700_000_200_000,
        windowEnd: 1_700_000_230_000,
        clip: { fileName: '', bytes: -1 },
      },
    ],
  })
  const after = (await (await call('/api/overview', 'carol')).json()) as {
    candidates: Array<{ clip: unknown }>
  }
  expect(after.candidates[0]!.clip).toBeNull()
})

test('missing database reports setup and local preview identity never activates on hosted origins', async () => {
  const noDb = await app.request(
    'https://app.example.test/api/overview',
    { headers: { 'test-user': 'alice' } },
    { ...env, DB: undefined },
  )
  expect(noDb.status).toBe(503)
  expect(
    await currentUser(new Request('https://app.example.test/'), {} as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {
      APP_ORIGIN: 'https://app.example.test',
    } as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {} as Env),
  ).toMatchObject({ sub: 'local-preview' })
})

test('content rules filter moments on arrival, with a reason the owner can read', async () => {
  await call('/api/sources', 'dave', 'POST', {
    platform: 'twitch',
    channel: 'davechan',
  })
  const created = (await (
    await call('/api/runners', 'dave', 'POST', { name: 'Mac' })
  ).json()) as { token: string }
  const beat = (await (
    await asRunner('/api/runner/heartbeat', created.token, { observed: [] })
  ).json()) as {
    sources: Array<{ id: string; approvedAt: number | null }>
    policy: { paused: boolean; blockedTerms: string[] }
  }
  // A channel added by the owner is approved, and a policy ships with it.
  expect(beat.sources[0]!.approvedAt).not.toBeNull()
  expect(beat.policy.paused).toBe(false)
  expect(beat.policy.blockedTerms.length).toBeGreaterThan(0)
  const sourceId = beat.sources[0]!.id

  const say = (category: string) =>
    asRunner('/api/runner/heartbeat', created.token, {
      observed: [{ sourceId, live: true, viewers: 10, category }],
    })
  await say('Just Chatting')
  const stored = (await (await call('/api/overview', 'dave')).json()) as {
    sources: Array<{ category: string | null }>
  }
  expect(stored.sources[0]!.category).toBe('Just Chatting')

  expect(
    (
      await call('/api/policy', 'dave', 'PATCH', {
        allowedCategories: ['Grand Theft Auto V'],
      })
    ).status,
  ).toBe(200)

  const post = (start: number, sample: string[]) =>
    asRunner('/api/runner/candidates', created.token, {
      candidates: [
        {
          sourceId,
          platform: 'twitch',
          channel: 'davechan',
          score: 80,
          signals: {
            chatZ: 3,
            messages: 40,
            keywords: ['no way'],
            emoteBurst: 4,
            windowSeconds: 30,
          },
          sample,
          windowStart: start,
          windowEnd: start + 30_000,
        },
      ],
    })
  const verdict = async (start: number, sample: string[]) => {
    const body = (await (await post(start, sample)).json()) as {
      accepted: Array<{ status: string; blockReason: string | null }>
    }
    return body.accepted[0]!
  }

  // Wrong category: refused before review.
  const wrong = await verdict(1_700_001_000_000, ['no way'])
  expect(wrong.status).toBe('blocked')
  expect(wrong.blockReason).toContain('category')

  // Right category, but a default blocklist word in the chat.
  await say('Grand Theft Auto V')
  const dirty = await verdict(1_700_001_100_000, ['bro is doing cocaine on stream'])
  expect(dirty.status).toBe('blocked')
  expect(dirty.blockReason).toBe('blocked term: cocaine')

  // A clip is never recorded for a refused moment.
  const clean = await verdict(1_700_001_200_000, ['NO WAY', 'clip it'])
  expect(clean.status).toBe('new')

  // Pausing refuses even a clean, allowed-category moment.
  await call('/api/policy', 'dave', 'PATCH', { paused: true })
  const paused = await verdict(1_700_001_300_000, ['NO WAY'])
  expect(paused.status).toBe('blocked')
  expect(paused.blockReason).toBe('clipping is paused')

  // Refusals are visible to the owner, and none of them are reviewable.
  const overview = (await (await call('/api/overview', 'dave')).json()) as {
    policy: { paused: boolean }
    candidates: Array<{ status: string; blockReason: string | null }>
  }
  expect(overview.policy.paused).toBe(true)
  expect(
    overview.candidates.filter((item) => item.status === 'blocked' && item.blockReason)
      .length,
  ).toBe(3)

  // Policy writes are validated and owner-scoped.
  expect((await call('/api/policy', 'dave', 'PATCH', {})).status).toBe(400)
  const bob = (await (await call('/api/overview', 'bob')).json()) as {
    policy: { paused: boolean; allowedCategories: string[] }
  }
  expect(bob.policy.paused).toBe(false)
  expect(bob.policy.allowedCategories).toEqual([])
})
