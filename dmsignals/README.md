# dmsignals

Daily Reddit monitor for The Ultimate Game Master. A Cloudflare Worker scans DM/GM subreddits each morning for equipment-need signals, has Claude Haiku draft value-first replies (never auto-posted), checks your Reddit inbox for responses to your comments, emails you a digest, and feeds a GitHub Pages dashboard.

## Architecture

```
cron (7am) → Cloudflare Worker
              ├─ Reddit API (official OAuth): r/DMAcademy, r/DungeonMasters, r/DnD, r/dndnext, r/rpg + your inbox
              ├─ KV: dedup (seen-urls), latest data, per-day archive
              ├─ Claude Haiku API: signal selection + reply drafts + reply-action suggestions
              └─ Resend: email digest to you

GitHub Pages (docs/) → fetches GET <worker>/data → dashboard with copy-paste drafts,
                       posted-tracking + history in browser localStorage
```

Why the official Reddit API instead of scraping: Reddit blocks datacenter IPs (including Workers) from HTML/JSON scraping. A free script-type app on your own account is the reliable path, and it also gives read-only inbox access for the replies feature.

## Setup (~20 minutes)

### 1. Reddit API credentials (free)
1. Log into Reddit → https://www.reddit.com/prefs/apps → "create another app…"
2. Type: **script**. Redirect URI: `http://localhost` (unused). Note the **client ID** (under the app name) and **secret**.
3. In `worker/worker.js`, replace `REPLACE_WITH_YOUR_USERNAME` in the `UA` constant with your Reddit username (Reddit requires a descriptive User-Agent).

### 2. Anthropic API key
Get one at https://console.anthropic.com. The worker uses Claude Haiku; expect roughly a cent or two per day.

### 3. Resend (email, free tier)
1. Sign up at https://resend.com, verify your sending domain (e.g. theultimategamemaster.com) or use their onboarding sender for testing.
2. Note the API key and your from-address (e.g. `signals@theultimategamemaster.com`).

### 4. Deploy the worker
```bash
npm install -g wrangler
wrangler login
cd worker
wrangler kv namespace create SIGNALS     # copy the id into wrangler.toml
wrangler secret put REDDIT_CLIENT_ID
wrangler secret put REDDIT_CLIENT_SECRET
wrangler secret put REDDIT_USERNAME
wrangler secret put REDDIT_PASSWORD
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put DIGEST_TO            # joelauge@gmail.com
wrangler secret put DIGEST_FROM          # verified Resend sender
wrangler deploy
```
Note the deployed URL (e.g. `https://dmsignals.<your-subdomain>.workers.dev`).

Optional manual-trigger protection: `wrangler kv key put --binding SIGNALS run-key "some-long-secret"` then `curl -X POST -H "x-run-key: some-long-secret" <worker-url>/run` to run on demand.

### 5. Dashboard on GitHub Pages
1. In `docs/index.html`, set `WORKER_URL` to your worker URL.
2. Push to GitHub, then repo Settings → Pages → Deploy from branch → `main` / `/docs`.
3. Dashboard lives at `https://joelauge.github.io/dmsignals/`.

### 6. Auto-deploy on push (optional)
Add a `CLOUDFLARE_API_TOKEN` repo secret (Cloudflare dashboard → API Tokens → "Edit Cloudflare Workers" template). The included GitHub Action deploys the worker on every push to `worker/`.

## Schedule
Cloudflare cron is UTC-only. `0 11 * * *` = 7:00 AM Toronto during daylight time (6:00 AM in winter; change to `0 12 * * *` in November if you care).

## Notes
- **Drafts are never auto-posted.** The worker is read-only against Reddit. You copy/paste manually from the dashboard or the email.
- History and "posted" state live in your browser's localStorage (per-browser). Server-side dedup of already-covered threads lives in KV, so the worker never re-drafts a thread even from a fresh browser.
- FIRSTTIMEGM coupon (free Session Zero Checklist) is baked into the drafting rules: only offered to brand-new GMs heading into a first session / session zero.
- The account has prior mod-removals for promotion in r/DMAcademy, r/DnDHomebrew, and r/DnDBehindTheScreen; the drafting prompt leans extra conservative in those subs.
- If Reddit ever rejects the password grant (script apps on accounts with 2FA need `password:otp` format or an app password), see https://github.com/reddit-archive/reddit/wiki/OAuth2.

## Costs
Cloudflare Workers free tier (cron included), KV free tier, Resend free tier (100 emails/day), Anthropic Haiku ≈ $0.01–0.05/day. Effectively free.
