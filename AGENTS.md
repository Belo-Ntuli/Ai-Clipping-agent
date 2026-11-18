# Clipper — working notes

Watch live Twitch/Kick streams, surface candidate moments, review them, and
(eventually) render and post clips. Two processes:

- **Dashboard** — this repo's Sites app: D1, R2 (phase B), Freebuff auth, the
  review UI. Always public and always up.
- **Runner** — `runner/`, runs on the owner's Mac. Watches streams, scores chat,
  and later captures and renders. Never exposed to the internet.

## Invariants

- **The runner pulls; nothing pushes to it.** The dashboard is the source of
  truth for the watchlist, jobs and decisions. No cron, no inbound port, no
  tunnel on the Mac. This is what makes it work from a home network.
- **Capture is continuous, detection reaches backwards.** A moment is only
  recognised after it happened, so the ring buffer (`runner/src/buffer.ts`) holds
  the tail and the cut is taken from it. Never design a flow that starts
  recording on detection.
- **Clip media stays on the runner.** The dashboard stores clip *metadata*
  (file name, bytes, duration) and nothing else. Do not stream or upload media
  until a real storage step exists; a home Mac is not a media host.
- **Nothing publishes without approval.** Phase A records the decision only.
  When posting lands, the default policy stays `always` and any automatic mode
  must be explicit, per campaign.
- **Clip only channels the owner approved, only content the owner allows.** A
  source without `approved_at` is never captured. The owner's policy (`paused`,
  `allowed_categories`, `blocked_terms` in the `policies` table) is checked on
  the runner *before* a clip is cut and re-checked on the dashboard when the
  candidate arrives. A filtered moment is stored with `status='blocked'` and a
  human-readable reason so the owner can see what was refused — never silently
  dropped, never queued for review.
- **One owner per row.** Every table carries `owner_sub` and every query binds
  it. Runner rows own their own `owner_sub`; a runner token only ever reads and
  writes its owner's data.
- **Secrets never leave the server.** Platform tokens are encrypted at rest and
  never sent to the browser. Runner tokens are stored as SHA-256 hashes and
  printed once. No secret in a route response, log line or fixture.
- **The runner stays portable.** No absolute paths; config from
  `runner/runner.json` plus `runner/.env`, resolved from the runner directory so
  launchd and any cwd behave identically. `bun run doctor` is the single gate
  before starting.
- **The score is chat-only.** Velocity, whole-word hit words and emote bursts
  counted across distinct messages. Audio loudness is not in the score yet, so a
  candidate with a clip proves video was buffered, not that sound was analysed.

## Layout

```
src/worker/    Hono app: /api/* dashboard routes, /api/runner/* token routes
src/client/    React dashboard (poll /api/overview every 3s)
src/shared/    types and the content-policy screen shared by worker, runner,
               client and tests
runner/src/    config, twitch, kick, score, buffer (ring + cut), stream
               (resolver), api client, mock, CLI
docs/          platform-apis.md (verified API facts), ffmpeg-recipes.md,
               youtube-setup.md (Google Cloud + OAuth walkthrough)
```

## Commands

```sh
bun install
bun run dev          # dashboard on 0.0.0.0
bun run typecheck    # client + worker + runner
bun test             # real D1 through Miniflare
bun run build

bun run runner doctor   # config, credentials, ffmpeg, resolvers, disk
bun run runner demo     # buffer + cut a synthetic stream (no credentials)
bun run runner replay F # buffer a local video, cut and post a real clip
bun run runner mock     # synthetic chat and video, no credentials
bun run runner start    # watch the dashboard watchlist
```

## Conventions

- Chat thresholds and weights live in `runner/src/score.ts`, not inline.
- The UI is quiet and classic, not a HUD: cream paper, deep green ink and
  buttons, muted gold for emphasis, burgundy only for refusals and errors.
  Serif headings, small-caps labels, hairline rules, no glow, no gradients on
  text, no animation beyond a single live indicator. If a change needs a
  drop shadow to read, it is the wrong change.
- Policy decisions live in `src/shared/policy.ts` as one pure function so the
  runner, the dashboard and the tests share exactly the same rules — there is
  no second copy to drift. The runner uses it to skip work, and the dashboard
  re-runs it on arrival because the runner is the fast path, not the authority.
- Do not add a default blocklist term without also keeping it short and
  literal — no fuzzy matching, no guessing at intent.
- Schema changes are appended to `schema` in `src/worker/db.ts`; it is
  idempotent and applied on demand.
- Verify platform behaviour against `docs/platform-apis.md` before adding a
  request. If the doc is wrong, correct the doc in the same change.
- Never invent an endpoint. There is no Kick clip API, no chat-read REST, no
  retention metric, and no Content Rewards submission API.
- **YouTube is a posting target, not a live source.** Twitch and Kick feed the
  buffer. Capturing YouTube live streams to re-upload is out of bounds; clip
  campaign-supplied VODs instead. There is no Shorts endpoint or flag —
  vertical + ≤3 minutes is the whole rule.
