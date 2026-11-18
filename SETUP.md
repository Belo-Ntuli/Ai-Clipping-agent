# Setup

Phase A needs no third-party credentials to run: `bun run runner mock` exercises
the whole pipe with synthetic chat. Add the items below as you get them.

## 1. Dashboard

```sh
bun install
bun run dev
```

Open the printed URL. On a loopback origin the app uses a labelled local preview
identity; once published it uses Sign in with Freebuff.

That fallback is deliberately **loopback-only**. Opening the app through any
other hostname (a tunnel, a LAN IP, a cloud preview) shows "still being set
up" instead of a user — that is the guard working, not a bug. To use the
dashboard from another device, publish it and sign in.

While developing you can opt one hostname in, if you need to inspect the real
thing through a tunnel:

```sh
wrangler dev --var LOCAL_PREVIEW_HOSTS:your-tunnel-host
```

It still does nothing once `APP_ORIGIN` or `FREEBUFF_CLIENT_ID` is set, so a
deployment can never inherit it. Never add it to a deployed environment.

## 2. Runner on the Mac

```sh
cd runner
cp .env.example .env    # paste the token from the Runners tab
cp runner.example.json runner.json
bun run doctor
bun run start           # or: bun run mock
```

Create the runner first: dashboard → **Runners** → Create runner. The token is
displayed once. Revoking it in the dashboard stops that runner immediately.

`runner.json`'s `dashboardUrl` must match the URL the dev server actually
printed — set it to `http://localhost:3000` if that is the port in use.

## 3. Video tooling (needed to cut clips)

```sh
brew install ffmpeg streamlink
```

- **ffmpeg / ffprobe** — writes the segment ring buffer and cuts the clip.
  Without it the runner still detects moments from chat, but nothing is cut.
- **streamlink** (or `yt-dlp`) — resolves a playable URL for a Twitch or Kick
  channel, because neither public API exposes one. With neither installed the
  runner logs a warning and capture stays off.

`bun run runner doctor` reports all three, plus free disk. Budget roughly
3 minutes × bitrate per live channel for the buffer (~500 MB for two 1080p60
channels) and keep rejected clips pruned; the buffer overwrites itself, the
clips folder does not.

Check it works without any stream or credentials:

```sh
bun run runner demo     # buffers a synthetic stream, cuts and probes a clip
```

## 4. Keep it running (macOS)

```sh
chmod +x runner/scripts/*.sh
./runner/scripts/install-launchd.sh
```

That installs `~/Library/LaunchAgents/com.clipper.runner.plist`, which runs
`runner/scripts/run.sh` at login and restarts it on crash. The script wraps the
process in `caffeinate -s` so the Mac does not idle to sleep while on power.

Things `caffeinate` cannot fix: a closed lid on a laptop, and a display or disk
sleep setting that still applies. On the iMac also check
`pmset -g custom` and confirm `sleep` is `0` while on AC power.

Logs: `~/Library/Logs/clipper-runner.log`. Stop it with:

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.clipper.runner.plist
```

## 5. Twitch (needed for live status and chat)

1. Enable two-factor authentication on the Twitch account.
2. https://dev.twitch.tv/console/apps → Register Your Application. Any name; the
   OAuth redirect URL can be `http://localhost` for a public-data app.
3. Copy the client ID and generate a client secret.
4. Put them in `runner/.env` as `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`.
5. `bun run runner doctor` should report "Twitch credentials work".

Chat needs nothing extra: the runner reads it anonymously over IRC.

## 6. Kick (stream status now, chat later)

1. Enable two-factor authentication, then account settings → **Developer**.
2. Create an app; copy the client id and secret.
3. Put them in `runner/.env` as `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET`.

Kick chat is webhooks-only and requires a publicly reachable URL. That receiver
belongs on the dashboard (phase B), not on the Mac — do not add a tunnel.

## 7. Later phases

- **TikTok** — register an app, add Content Posting API, request `video.upload`
  first (drafts, avoids the audit gate), then `video.publish`. App review wants
  a real website with a privacy policy, so the published dashboard origin is the
  natural home for it.
- **YouTube** — see [docs/youtube-setup.md](docs/youtube-setup.md) for the full
  walkthrough: project, API, consent screen test user, OAuth client with the
  localhost callback, and the `youtube.upload` scope. Two things bite: refresh
  tokens expire every 7 days while the app is in Testing, and uploads have their
  own 100/day quota bucket. Note YouTube is a **posting target**, not a live
  source: capturing YouTube streams to re-upload is not allowed; clip from
  campaign-supplied VODs instead.
- **Instagram** — the account must be a Business account for Reels publishing.
- **Content Rewards** — connect accounts on contentrewards.com; campaigns supply
  the rate, brief and accepted platforms the dashboard imports.

## Moving the runner to another Mac

State lives in the dashboard, so a move is a copy, not a migration:

```sh
# on the old machine
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.clipper.runner.plist
# copy the runner/ folder (including .env and runner.json) to the new one
bun install
cd runner && bun run doctor && bun run start
./scripts/install-launchd.sh
```

Reuse the same token (the dashboard lists both machines by name) or create a new
runner and revoke the old one. Never run both against the same token expecting
different behaviour — they are identical workers.

## Publishing

The dashboard is a Sites app. When publishing is authorised: create the site,
enable Sign in with Freebuff, provision D1 as `DB`, then deploy with
`deploy.json`. Phase B adds an R2 bucket as `FILES`. Do not publish the runner —
it only makes outbound connections.
