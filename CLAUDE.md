# DMRadar

Reddit lead-gen system for The Ultimate Game Master (theultimategamemaster.com): find DMs/GMs who need equipment, draft value-first replies for human review, never auto-post.

## What Joel is trying to do

The Ultimate Game Master sells modular magnetic leather GM screens. The highest-quality buying signals are Reddit threads where DMs/GMs describe a need: brand-new DMs asking what to buy, VTT users going in-person, people asking about screens, initiative tracking, table setup, or displaying art at the table. The goal is a daily pipeline that (1) finds those threads, (2) drafts a short, honest, Reddit-plain reply that genuinely answers the question and mentions the product only when it truly solves the stated problem (with disclosure), (3) delivers the drafts to Joel each morning for manual posting, and (4) tracks replies to his posted comments so he can keep conversations alive. The point is trust-building that converts, not ad spam. Repetition is a failure mode: never draft the same thread twice, and keep history of what was answered and what was skipped.

## Production wiring (intended end state)

1. **GitHub** — this folder becomes the repo, pushed to https://github.com/joelauge/dmsignals.git. The included GitHub Action (`dmsignals/.github/workflows/deploy.yml`, needs `CLOUDFLARE_API_TOKEN` repo secret) auto-deploys the worker on push. The dashboard is served by GitHub Pages from a `docs/` folder (`dmsignals/docs/index.html`; set its `WORKER_URL` const to the deployed worker URL).
2. **Cloudflare Worker** — ONE merged worker (see integration task below): root new-dm-radar's polling/scoring/dedup/instant-hot + dmsignals' Haiku drafting, `GET /data` endpoint (feeds the Pages dashboard), inbox reply-check, and Resend digest email to joelauge@gmail.com. KV namespace already provisioned (id in root wrangler.toml). Secrets via `wrangler secret put`: REDDIT_CLIENT_ID/SECRET (existing), REDDIT_USERNAME/PASSWORD (for inbox reads), ANTHROPIC_API_KEY, RESEND_API_KEY, ADMIN_KEY. Reddit access is via the official API script app — never scrape reddit.com HTML/JSON from Workers (datacenter IPs are blocked).
3. **Devvit app (`dm-radar/`)** — the PRIMARY pipeline (decided 2026-07-04: Reddit steers new API apps to Devvit, and script-app credentials were never provisioned). `@devvit/web` React + Hono template, registered with Reddit as `dmradarreact`. Daily scheduled scan, Redis dedup, Haiku drafts, thread-based reply tracking (re-scans threads drafted in the last 7 days for replies to comments by the `digest-username` account), digest as Reddit PM + optional Resend email, dashboard as a pinnable custom post. HTTP allowlist: `api.anthropic.com`, `api.resend.com`. Runs as an app account, so it CANNOT read Joel's personal inbox — the thread-based tracking misses PMs, mentions, and replies in undrafted threads.

Division of labor (updated 2026-07-04): the Devvit app is the operating system (scan, drafts, reply tracking, PM + email digest, pinned dashboard); the Cloudflare Worker is dormant — deployed at https://dmsignals.joelauge.workers.dev with the GitHub Pages dashboard, but inert until Reddit script-app credentials (REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD) are ever obtained. Both share identical drafting rules, product context, and the never-auto-post guarantee.

## Immediate tasks

1. `git init`, commit everything, add remote `https://github.com/joelauge/dmsignals.git`, push.
2. Merge `dmsignals/` features into the root worker (details below); delete or archive the redundant `dmsignals/worker/` copy after the merge.
3. Move the dashboard to a root-level `docs/` for Pages, set `WORKER_URL`, enable Pages on the repo (main branch, /docs).
4. Deploy: set the new secrets, `wrangler deploy`, verify `GET /data` and a manual `/run`.
5. Devvit: overwrite the scaffold's `src/main.tsx` with `dm-radar/src/main.tsx`, playtest in a private subreddit, set the anthropic-api-key app secret and digest-username install setting.

## Layout

- **Root (`src/`, `wrangler.toml`)** — "new-dm-radar": the EXISTING, operational Cloudflare Worker. Polls 4 subreddits every 2h via Reddit API, scores with keyword tiers (`src/scoring.js`), dedupes in KV (namespace already provisioned), emails a daily Resend digest at 13:00 UTC, optional instant-hot alerts. This is the base to build on.
- **`dmsignals/`** — a parallel Worker built in Cowork on 2026-07-04. Overlaps with root but adds: Claude Haiku drafting (select top 3–5 signals + write ready-to-post replies), reply-to-my-comments inbox checking, `GET /data` JSON endpoint, and a GitHub Pages dashboard (`dmsignals/docs/index.html`) with copy buttons, posted-tracking, and localStorage history.
- **`dm-radar/`** — a Devvit app (runs ON Reddit): daily scheduled scan, Redis dedup, Haiku drafts, digest as Reddit PM, dashboard as pinnable custom post. Cannot read the owner's inbox (runs as app account).
- **`dm-signals-dashboard.html`** — standalone local dashboard with embedded 2026-07-04 data (the Cowork artifact version).
- **`reddit-dm-signals-2026-07-04.md`** — first day's signal report, shows expected output format.

## Likely integration task

Merge `dmsignals/` features into the root worker rather than running both: keep root's scoring/polling/dedup/instant-hot, add from dmsignals the Haiku drafting step, the inbox reply-check, the `/data` endpoint, and serve `dmsignals/docs/index.html` as the dashboard. Root's KV id and secrets are already provisioned; dmsignals' README documents the extra secrets (ANTHROPIC_API_KEY; REDDIT_USERNAME/PASSWORD for inbox reads).

## Non-negotiable content rules (apply to ALL drafting code/prompts)

- Drafts are for human review only. Nothing is ever posted, commented, voted, or messaged automatically on public Reddit.
- Reply style: short, Reddit-plain, few paragraphs, no em dashes, no marketing tone, no bullet lists. Answer the question genuinely first; cheap/DIY recommendations when honest.
- Product mention ONLY when it directly solves the stated problem, framed as one option, always with disclosure: "full disclosure, I work on The Ultimate Game Master".
- FIRSTTIMEGM coupon (free Session Zero Checklist): offer ONLY to brand-new GMs preparing for a first session / asking about session zero.
- Account caution: prior mod-removals for promotion in r/DMAcademy, r/DnDHomebrew, r/DnDBehindTheScreen — prefer no product mention in those subs.
- All LLM drafting uses Claude Haiku (`claude-haiku-4-5-20251001`).

## Product context (for drafting prompts)

Modular magnetic leather GM screens. Core screen $139.99 (Portrait 36×12 / Landscape 48×9). Add-ons: Map Pack $54.99, Pouches, Bar Set, Initiative Trackers $17.99, Creature Trackers $17.99, Tablet Holder $16.99, Phone Holder $15.99, Quick-Load Panel $47.99, 5e Rules Pack $24.99. Ultimate Bundle $319.99. Free shipping >$99, 30-night returns. Differentiators: mid-session reconfiguration, dry-erase, magnetic snap-ons, tablet/phone holders for hybrid digital-physical play.
