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
  recognised after it happened, so the ring buffer holds the tail and the cut is
  taken from it. Never design a flow that starts recording on detection.
- **Nothing publishes without approval.** Phase A records the decision only.
  When posting lands, the default policy stays `always` and any automatic mode
  must be explicit, per campaign.
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
- **Chat signal only, for now.** Phase A scores message velocity, hit words and
  emote bursts. The UI says so. Do not label a phase A candidate as anything
  more than that.

## Layout

```
src/worker/    Hono app: /api/* dashboard routes, /api/runner/* token routes
src/client/    React dashboard (poll /api/overview every 3s)
src/shared/    types shared by worker, client and runner
runner/src/    config, twitch, kick, score, api client, mock, CLI
docs/          platform-apis.md (verified API facts), ffmpeg-recipes.md
```

## Commands

```sh
bun install
bun run dev          # dashboard on 0.0.0.0
bun run typecheck    # client + worker + runner
bun test             # real D1 through Miniflare
bun run build

bun run runner doctor   # config, credentials, ffmpeg, disk
bun run runner mock     # synthetic chat, no credentials needed
bun run runner start    # watch the dashboard watchlist
```

## Conventions

- Chat thresholds and weights live in `runner/src/score.ts`, not inline.
- Schema changes are appended to `schema` in `src/worker/db.ts`; it is
  idempotent and applied on demand.
- Verify platform behaviour against `docs/platform-apis.md` before adding a
  request. If the doc is wrong, correct the doc in the same change.
- Never invent an endpoint. There is no Kick clip API, no chat-read REST, no
  retention metric, and no Content Rewards submission API.
