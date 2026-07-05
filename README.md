# New DM Radar — Cloudflare Worker

Monitors r/DMAcademy, r/DnD, r/DungeonMasters, r/dndnext for first-time-DM signals ("first time DM", "running my first campaign", "session zero", etc.), scores them, dedupes, and emails you a daily digest. Runs entirely on Cloudflare's free tier.

## How it works

- **Every 2 hours** (cron): pulls the 50 newest posts per subreddit via the Reddit API, scores each with keyword tiers + subreddit/recency bonuses, skips anything already seen (KV, 14-day memory), and stores leads scoring ≥ 30.
- **Daily at 9am ET** (cron): emails all pending leads, sorted by score, via Resend.
- Set `INSTANT_HOT = "true"` in wrangler.toml to also get an immediate email when a lead scores ≥ 60.

Free-tier math: 4 subreddits × 12 polls/day = 48 Reddit calls/day (Reddit free limit: 100 queries/min). Worker: ~13 invocations/day (limit: 100k/day). KV: a few hundred ops/day (limit: 100k reads / 1k writes/day). Resend: 1–2 emails/day (limit: 100/day). All comfortably free.

## Setup (~10 minutes)

1. **Reddit app** — you already have credentials. Confirm the app type is "script" or "web app" at https://www.reddit.com/prefs/apps. Note the client ID (under the app name) and secret. Edit `USER_AGENT` in `src/index.js` to include your Reddit username — Reddit throttles generic user agents.

2. **Resend** — free account at https://resend.com, verify theultimategamemaster.com as a sending domain (add their DNS records — trivial since your DNS is likely already on Cloudflare), create an API key. If you'd rather not verify a domain, use their onboarding sender `onboarding@resend.dev` as `EMAIL_FROM` for testing.

3. **Deploy**

```bash
npm i -g wrangler
wrangler login

cd new-dm-radar
wrangler kv namespace create LEADS
# paste the returned id into wrangler.toml

wrangler secret put REDDIT_CLIENT_ID
wrangler secret put REDDIT_CLIENT_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put ADMIN_KEY        # any random string

wrangler deploy
```

4. **Test** — hit the manual endpoints:

```
https://new-dm-radar.<your-subdomain>.workers.dev/run?key=YOUR_ADMIN_KEY     # runs a poll now
https://new-dm-radar.<your-subdomain>.workers.dev/digest?key=YOUR_ADMIN_KEY # emails pending leads now
```

## Tuning

- **Threshold**: `THRESHOLD` in `src/scoring.js` (default 30). Raise to 50 for only self-declared first-timers.
- **Phrases**: add/remove regexes in the tier arrays in `src/scoring.js`.
- **Subreddits**: `SUBREDDITS` in `src/index.js`. Candidates: r/NewDM, r/rpg, r/mattcolville.
- **Cadence**: crons in `wrangler.toml`.

## Extending later

- Pipe leads to a Discord webhook (one extra `fetch` in `poll()`).
- Add Workers AI (free) to draft a suggested helpful reply per lead.
- Mirror the same phrases into your Google Ads keywords — same intent shows up in search ("what does a new DM need", "DM starter kit").
