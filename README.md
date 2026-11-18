# Clipper

An agent that watches live streams, flags the moments worth clipping, and hands
them to you for approval. Phase A is the watch loop and the dashboard; capture,
rendering, posting and campaign submission follow.

```
runner (your Mac)                          dashboard (Sites)
  watchlist ───────────────────────────────► sources, candidates, review
  30s tick: live check + chat scoring         approve / reject, runner tokens
  candidates ──────────────────────────────►  agent log, live status
```

The runner pulls its watchlist from the dashboard every tick, so the dashboard
is the source of truth and the Mac never needs an inbound port or a tunnel.

## Start

```sh
bun install
bun run dev                     # dashboard

bun run runner mock             # verify the pipe with synthetic chat
bun run runner doctor           # real credentials + environment check
bun run runner start            # watch the dashboard watchlist
```

`mock` needs no credentials at all. For real streams, create a runner in the
dashboard's **Runners** tab, paste the token into `runner/.env`, and add a
Twitch or Kick channel under **Channels**. See [SETUP.md](SETUP.md) for app
registration, auto-start and moving machines.

## What the runner does each tick

1. Reports which channels are live and picks up watchlist changes.
2. Computes a chat signal per channel: message velocity against its own rolling
   baseline (z-score), hit words, and emote bursts.
3. Scores it 0–100. Above the threshold, with a per-channel cooldown, it posts a
   candidate with the numbers and a few sample lines.
4. Everything appears in the dashboard: **Live** for the feed, **Review** to
   approve or reject.

Detection is chat-only in phase A, and the UI says so. Audio loudness joins with
the capture pipeline, where the ring buffer also makes it possible to cut the
moment *before* detection noticed it.

## Layout

```
src/worker/    Hono routes: dashboard API and runner token API
src/client/    React dashboard
src/shared/    shared types
runner/src/    config, twitch, kick, score, api, mock, CLI
docs/          platform-apis.md, ffmpeg-recipes.md
```

Read [AGENTS.md](AGENTS.md) for the invariants, and
[docs/platform-apis.md](docs/platform-apis.md) before touching a platform API.

## Checks

```sh
bun run typecheck
bun test
bun run build
```
