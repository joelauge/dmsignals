# dm-radar (Devvit app)

DM-equipment-signal scanner running natively ON Reddit via Devvit. Daily scheduled scan of r/DMAcademy, r/DungeonMasters, r/DnD, r/dndnext, r/rpg → Redis dedup → Claude Haiku drafts → digest as a Reddit PM to you → dashboard as a pinned custom post. Read-only: it never posts or comments in the wild.

## Setup

1. Run the three commands from the Devvit "You're all set!" screen on your machine (they scaffold the project bound to your app registration and log you in):
   ```bash
   npm create devvit@latest <your-token>
   cd dm-radar
   ```
2. Replace the scaffold's `src/main.tsx` with the one in this folder.
3. Playtest in a private test subreddit you moderate (create one, e.g. r/dmradar_test):
   ```bash
   npm run dev   # then: devvit playtest r/dmradar_test if it asks
   ```
4. Set the Anthropic key (app-level secret):
   ```bash
   npx devvit settings set anthropic-api-key
   ```
5. Install the app on your test subreddit, then in the app's install settings set **digest-username** to your Reddit username.
6. From the subreddit's mod menu (⋯): **"DM Radar: scan now"** to test, and **"DM Radar: create dashboard post"** to make the pinnable dashboard.

## Important caveats

- **HTTP allowlist:** Devvit blocks external fetches by default. `api.anthropic.com` must be permitted for your app — during playtest you may need to add it under `http` in the devvit config (the scaffold shows where; newer templates use devvit.json's `permissions.http.domains`), and publishing an app with external fetch requires Reddit's approval. For a private, self-installed app this is usually straightforward, but it is Reddit's call.
- **Devvit API drift:** Devvit moves fast. If `npm run dev` flags renamed imports (e.g. `useState` location, `getNewPosts` shape), the fixes are usually one-liners; the structure here follows the 0.11.x public API.
- **No inbox access:** the app runs as its own account and cannot read u/joelauge's inbox, so the replies-to-you feature stays with the Cloudflare Worker (which can, via your script-app credentials). The two coexist fine: Devvit for on-Reddit dashboard + PM digest, Worker for email + replies, or pick one.
- **Platform rules:** a read-only monitoring app for your own use is well within bounds, but if you ever publish it publicly, Reddit reviews what it does. Keep it private/unlisted.
- **Schedule:** cron is UTC. `0 11 * * *` = 7am Toronto in summer, 6am in winter.

## What matches the other builds

Same product context, FIRSTTIMEGM coupon rule (new-GM-first-session only), account caution for subs with past promo removals, strict Reddit-plain style (short, no em dashes, disclosure always), Haiku model, and never-auto-post guarantee.
