# dm-radar (Devvit companion app)

Daily DM/GM equipment-signal scanner for The Ultimate Game Master, running natively on Reddit via [Devvit](https://developers.reddit.com/). Complementary to the Cloudflare Worker in the repo root — this app is the on-Reddit convenience surface (PM digest, pinnable dashboard), while the Worker stays the source of truth (email digest, web dashboard, inbox reply tracking).

## What it does

1. Daily cron (`0 11 * * *` UTC = 7am Toronto during EDT) reads new posts from target subreddits via the native Reddit API — no scraping, no OAuth setup.
2. Dedupes against Redis so a thread is never drafted twice.
3. Sends candidates to Claude Haiku (`claude-haiku-4-5-20251001`) to select the top 3-5 signals and write Reddit-plain drafts.
4. Stores the day's results in Redis and DMs a digest (with full drafts) to the subreddit's configured recipient.
5. Renders a dashboard as a pinnable custom post (`src/client/game.tsx` expanded view, `src/client/splash.tsx` inline teaser).

It **never** posts or comments anywhere — drafts arrive in the digest PM and the dashboard for manual copy-paste. This app runs as its own account, so it cannot read the owner's personal inbox; reply tracking to your own comments stays in the Cloudflare Worker (`../src/index.js`).

## Layout

- `src/server/core/scan.ts` — the pipeline: fetch, dedupe, Haiku draft, persist, digest PM.
- `src/server/routes/scheduler.ts` — cron endpoint (`/internal/scheduler/daily-scan`), wired in `devvit.json`.
- `src/server/routes/menu.ts` — moderator menu: create dashboard post, scan now.
- `src/server/routes/api.ts` — `GET /api/latest` for the dashboard client.
- `src/client/` — React dashboard (Vite): `splash.tsx` (inline feed teaser) + `game.tsx` (expanded dashboard).
- `devvit.json` — app config: permissions (`redis`, `reddit` user-scope, `http` allowlisting `api.anthropic.com`), settings, scheduler, menu.

## Setup

1. `npm install`
2. `npm run login` (or `devvit login`) if not already authenticated.
3. Set the app-scope secret: `devvit settings set anthropic-api-key` (or via the app's settings page after install).
4. Install to a private test subreddit, then set the subreddit-scope `digest-username` setting to the Reddit username that should receive the PM digest.
5. `npm run dev` (`devvit playtest`) to iterate live, or `npm run deploy` to upload a new version.
6. From the subreddit's mod menu: "DM Radar: create dashboard post" to pin the dashboard, "DM Radar: scan now" to trigger the pipeline manually.

## Commands

- `npm run dev`: `devvit playtest` — live development against your test subreddit.
- `npm run build`: builds client + server.
- `npm run deploy`: type-checks, lints, then `devvit upload`.
- `npm run launch`: deploy + `devvit publish` (review).
- `npm run type-check` / `npm run lint`: as named.

## Content rules

Same non-negotiable drafting rules as the Worker (see root `CLAUDE.md`): human review only, Reddit-plain style, product mention only when it truly fits with disclosure, FIRSTTIMEGM coupon only for brand-new GMs prepping session zero, and extra caution (no product mention) in r/DMAcademy, r/DnDHomebrew, r/DnDBehindTheScreen. `PRODUCT_CONTEXT` / `STYLE_RULES` in `src/server/core/scan.ts` encode these.
