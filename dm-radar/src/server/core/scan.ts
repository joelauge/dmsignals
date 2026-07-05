import { reddit, redis, settings } from '@devvit/web/server';
import type { Day, Signal } from '../../shared/api';

/**
 * dm-radar pipeline: reads new posts from target subreddits via the native
 * Reddit API, dedupes against Redis so a thread is never drafted twice,
 * sends candidates to Claude Haiku to select the top signals and write
 * Reddit-plain drafts, stores the day's results in Redis, and DMs a digest
 * (with full drafts) to the configured recipient.
 *
 * It NEVER posts or comments anywhere. Drafts arrive in the digest PM for
 * manual copy-paste. This app runs as its own account, so it cannot read
 * the owner's personal inbox — reply tracking stays in the Cloudflare Worker.
 */

const SUBREDDITS = ['DMAcademy', 'DungeonMasters', 'DnD', 'dndnext', 'rpg'];
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const PRODUCT_CONTEXT = `The Ultimate Game Master (theultimategamemaster.com) sells modular, magnetic leather GM screens for D&D, Pathfinder, and all TTRPGs. Core screen $139.99 (Portrait 36"Wx12"H or Landscape 48"Wx9"H, four 9"x12" panels). Snap-on magnetic accessories: Magnetic Map Pack $54.99, Large/Small Magnetic Pouches, Magnetic Bar Set, Initiative Trackers $17.99, Creature Trackers $17.99, Tablet Holder $16.99, Phone Holder $15.99, Quick-Load Panel $47.99, 5e Rules Pack $24.99. Ultimate Bundle $319.99. Free shipping over $99, 30-night returns. Differentiators: reconfigure layout mid-session, dry-erase surfaces, magnetic snap-on everything, tablet/phone holders for hybrid digital-physical play.
COUPON: "FIRSTTIMEGM" gives new GMs the Session Zero Checklist free. Include ONLY when a brand-new GM is preparing for their first session or asking about session zero. Frame as a freebie, keep disclosure.
ACCOUNT CAUTION: the human poster's account has prior mod-removals for promotion in r/DMAcademy, r/DnDHomebrew, r/DnDBehindTheScreen. In those subs prefer NO product mention.`;

const STYLE_RULES = `STYLE (strict): short and Reddit-like, a few brief paragraphs max. Plain words. Polite but not gushing. NO em dashes anywhere (use commas or periods). No marketing language. No bullet lists. Genuinely answer the question first, veteran-GM practical advice, cheap/DIY options included when honest. Mention The Ultimate Game Master ONLY when it directly solves their stated problem, as one option among others, always with "full disclosure, I work on The Ultimate Game Master". General new-DM advice threads get NO product mention (FIRSTTIMEGM freebie is the one exception per coupon rule).`;

const KEYWORDS =
  /\b(new dm|first (session|campaign|game)|becoming a dm|start(ing)? (dm|gm)|dm screen|gm screen|initiative|condition track|dice|miniature|minis|terrain|battle ?ma[pt]|table setup|session zero|session 0|what (do i|should i) (buy|need|get)|recommend|display|portrait|tablet|prep|organiz)/i;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function emptyDay(): Day {
  return { date: today(), scanned: 'no run yet', found: 0, best: 'No scan yet.', signals: [] };
}

export async function getLatest(): Promise<Day> {
  const raw = await redis.get('latest');
  return raw ? (JSON.parse(raw) as Day) : emptyDay();
}

export async function runScan(): Promise<Day> {
  const date = today();

  // 1. Gather fresh posts (last ~26h) from each subreddit, keyword-filtered, deduped.
  const candidates: Record<string, unknown>[] = [];
  let total = 0;
  for (const subName of SUBREDDITS) {
    const listing = await reddit.getNewPosts({ subredditName: subName, limit: 25 }).all();
    for (const post of listing) {
      total++;
      const ageHrs = (Date.now() - post.createdAt.getTime()) / 3.6e6;
      if (ageHrs > 26) continue;
      const body = (post.body ?? '').slice(0, 1500);
      if (!KEYWORDS.test(post.title + ' ' + body)) continue;

      const seen = await redis.get(`seen:${post.permalink}`);
      if (seen) continue;

      candidates.push({
        sub: `r/${subName}`,
        author: `u/${post.authorName}`,
        title: post.title,
        selftext: body,
        url: `https://old.reddit.com${post.permalink}`,
        permalink: post.permalink,
        ageHrs: Math.round(ageHrs),
        comments: post.numberOfComments,
      });
    }
  }

  const day: Day = {
    date,
    scanned: `${total} posts across ${SUBREDDITS.map((s) => 'r/' + s).join(', ')}`,
    found: 0,
    best: 'No qualifying signals today.',
    signals: [],
  };

  // 2. Haiku selects and drafts.
  if (candidates.length) {
    const apiKey = (await settings.get<string>('anthropic-api-key')) ?? '';
    if (!apiKey) {
      day.best = 'No ANTHROPIC_API_KEY app setting configured.';
    } else {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 4000,
          messages: [
            {
              role: 'user',
              content: `You are selecting sales signals for a TTRPG accessories company and drafting Reddit replies for HUMAN review (never auto-posted).\n\n${PRODUCT_CONTEXT}\n\n${STYLE_RULES}\n\nBelow are candidate Reddit posts (JSON). Select the 3-5 strongest buying/need signals: new DMs asking what to buy or how to start, digital-to-physical transitions, GM screen / initiative tracking / table setup / displaying art at the table / session prep organization questions. Skip pure rules questions, memes, art showcases.\n\nReturn ONLY valid JSON, no markdown fences: {"best":"one sentence naming today's single best opportunity and why","signals":[{"strength":"High|Medium|Low","sub":"r/...","author":"u/...","meta":"<ageHrs> hr old · <comments> comments","title":"...","url":"...","summary":"one line","whyfit":"one line","draft":"the full reply text"}]}\n\nCandidates:\n${JSON.stringify(
                candidates.map(({ permalink: _permalink, ...rest }) => rest)
              )}`,
            },
          ],
        }),
      });

      if (res.ok) {
        try {
          const body = (await res.json()) as { content: { text: string }[] };
          const text = (body.content[0]?.text ?? '').trim().replace(/^```json\s*|\s*```$/g, '');
          const out = JSON.parse(text) as { best?: string; signals?: Signal[] };
          day.signals = out.signals ?? [];
          day.best = out.best ?? day.best;
          day.found = day.signals.length;
        } catch {
          day.best = 'Failed to parse Haiku output.';
        }
      } else {
        day.best = `Haiku call failed (${res.status}). Check the API key in app settings.`;
      }
    }
  }

  // 3. Persist + mark selected threads as seen (90-day TTL keeps Redis tidy).
  for (const s of day.signals) {
    const perma = s.url.replace('https://old.reddit.com', '');
    await redis.set(`seen:${perma}`, date, { expiration: new Date(Date.now() + 90 * 864e5) });
  }
  await redis.set('latest', JSON.stringify(day));

  // 4. DM digest with full drafts.
  await sendDigest(day);

  return day;
}

async function sendDigest(day: Day): Promise<void> {
  const to = await settings.get<string>('digest-username');
  if (!to) return;

  const lines = day.signals
    .map(
      (s, i) =>
        `**${i + 1}. [${s.strength}] ${s.title}**\n${s.sub} · ${s.author} · ${s.meta}\n${s.url}\n_${s.whyfit}_\n\n> ${s.draft.split('\n').join('\n> ')}\n`
    )
    .join('\n---\n\n');

  await reddit.sendPrivateMessage({
    to,
    subject: `DM Signals ${day.date}: ${day.found} opportunities`,
    text: `Scanned ${day.scanned}.\n\n⭐ **Best:** ${day.best}\n\n${lines || 'None today.'}\n\n🎟 Reminder: FIRSTTIMEGM = free Session Zero Checklist for new GMs (only when it truly fits).\n\n_Drafts are never auto-posted. Copy, tweak, post manually._`,
  });
}
