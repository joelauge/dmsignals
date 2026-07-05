# dmsignals

Daily Reddit lead-gen worker for [The Ultimate Game Master](https://theultimategamemaster.com). Finds DMs/GMs describing an equipment need, drafts short value-first replies with Claude Haiku for **human review only**, tracks replies to your posted comments, and feeds a GitHub Pages dashboard. Nothing is ever posted, commented, or messaged automatically.

## Architecture

```
cron (every 2h)   -> poll r/DMAcademy, r/DungeonMasters, r/DnD, r/dndnext, r/rpg
                     score with keyword tiers (src/scoring.js), dedupe in KV,
                     queue leads scoring >= 30

cron (13:00 UTC)  -> Claude Haiku selects the top 3-5 leads and drafts replies
                     Reddit inbox check (read-only) for replies to your comments
                     store the day's JSON in KV ("latest"), email a Resend digest
                     GET /data serves that JSON to the dashboard

GitHub Pages (docs/) -> fetches GET <worker-url>/data
                        copy-paste drafts, posted-tracking + history in browser localStorage
```

Reddit access is via the official API (script-type app). Reddit blocks scraping from datacenter IPs, including Workers, so this is the only reliable path — it also gives read-only inbox access for the reply-tracking feature.

## Setup

### 1. Reddit API credentials
1. https://www.reddit.com/prefs/apps -> "create another app...". Type **script**, redirect URI `http://localhost` (unused). Note the client ID (under the app name) and secret.
2. In `src/index.js`, replace `REPLACE_WITH_YOUR_USERNAME` in `USER_AGENT` with your Reddit username (Reddit throttles generic user agents).
3. Inbox reads need your Reddit username/password (password-grant token). If your account has 2FA, see https://github.com/reddit-archive/reddit/wiki/OAuth2 for the `password:otp` format or use an app password.

### 2. Anthropic API key
https://console.anthropic.com — the worker drafts with Claude Haiku (`claude-haiku-4-5-20251001`); expect roughly a cent or two per day.

### 3. Resend (email)
Free account at https://resend.com, verify a sending domain (e.g. theultimategamemaster.com) or use `onboarding@resend.dev` for testing. Note the API key.

### 4. Deploy

```bash
npm install -g wrangler
wrangler login

wrangler secret put REDDIT_CLIENT_ID
wrangler secret put REDDIT_CLIENT_SECRET
wrangler secret put REDDIT_USERNAME
wrangler secret put REDDIT_PASSWORD
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put ADMIN_KEY        # any random string

wrangler deploy
```

Note the deployed URL (e.g. `https://dmsignals.<your-subdomain>.workers.dev`).

Manual test endpoints (guarded by `ADMIN_KEY`):
```
https://dmsignals.<subdomain>.workers.dev/run?key=YOUR_ADMIN_KEY      # poll now
https://dmsignals.<subdomain>.workers.dev/digest?key=YOUR_ADMIN_KEY   # Haiku draft + inbox check + email now
```
`GET /data` is public (no key) — it's what the dashboard fetches.

### 5. Dashboard on GitHub Pages
1. In `docs/index.html`, set `WORKER_URL` to your deployed worker URL.
2. Push to GitHub, then repo Settings -> Pages -> Deploy from branch -> `main` / `/docs`.
3. Dashboard lives at `https://joelauge.github.io/dmsignals/`.

### 6. Auto-deploy on push
Add a `CLOUDFLARE_API_TOKEN` repo secret (Cloudflare dashboard -> API Tokens -> "Edit Cloudflare Workers" template). `.github/workflows/deploy.yml` deploys on every push touching `src/**`, `wrangler.toml`, or `package.json`.

## Tuning

- **Score threshold**: `THRESHOLD` in `src/scoring.js` (default 30).
- **Phrases**: tier regexes in `src/scoring.js`.
- **Subreddits**: `SUBREDDITS` in `src/index.js`.
- **Cadence**: crons in `wrangler.toml`.
- **Drafting rules / product context**: `PRODUCT_CONTEXT` and `STYLE_RULES` in `src/index.js` — see the non-negotiable content rules in `CLAUDE.md`.

## dm-radar/ (Devvit app — the primary pipeline)

`dm-radar/` is a Devvit app (the `@devvit/web` React + Hono template) that runs natively on Reddit and is the **primary** system: daily scan, Redis dedup, Haiku drafts, thread-based reply tracking (re-scans drafted threads for replies to your comments), digest as a Reddit PM and optionally as a Resend email, and a pinnable dashboard custom post (splash + expanded React views). It needs no Reddit OAuth credentials — Devvit apps get native API access. The Cloudflare Worker above is a dormant alternative: it covers true inbox reading and a public web dashboard, but requires script-app credentials (client ID/secret + account password), which Reddit now steers developers away from in favor of Devvit. See `dm-radar/README.md` for setup and commands.

## Notes

- **Drafts are never auto-posted.** The worker is read-only against Reddit; you copy/paste manually from the dashboard or the email.
- History and "posted" state live in the dashboard's browser localStorage (per-browser). Server-side dedup of already-covered posts lives in Worker KV, so a thread is never redrafted even from a fresh browser.
- FIRSTTIMEGM coupon (free Session Zero Checklist) is offered only to brand-new GMs heading into a first session / session zero.
- This account has prior mod-removals for promotion in r/DMAcademy, r/DnDHomebrew, r/DnDBehindTheScreen; the drafting prompt leans conservative there.

## Costs

Cloudflare Workers free tier (cron included), KV free tier, Resend free tier (100 emails/day), Anthropic Haiku ≈ $0.01-0.05/day. Effectively free.
