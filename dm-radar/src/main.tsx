import { Devvit, useState } from '@devvit/public-api';

/**
 * dm-radar — daily DM-equipment-signal scanner for The Ultimate Game Master, running natively on Reddit.
 *
 * What it does each morning (and on demand via the subreddit menu):
 *  1. Reads new posts from target subreddits via the native Reddit API (no scraping, no OAuth setup).
 *  2. Dedupes against Redis so a thread is never drafted twice.
 *  3. Sends candidates to Claude Haiku to select the top signals and write Reddit-plain drafts.
 *  4. Stores the day's results in Redis and DMs a digest (with full drafts) to you.
 *  5. Renders a dashboard as a custom post you can pin in your private subreddit.
 *
 * It NEVER posts or comments anywhere. Drafts arrive in the digest PM for manual copy-paste.
 * Limitation: the app runs as its own account, so it cannot read your personal inbox
 * (keep the Cloudflare Worker or manual checks for replies-to-you).
 */

const SUBREDDITS = ['DMAcademy', 'DungeonMasters', 'DnD', 'dndnext', 'rpg'];
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const JOB_NAME = 'daily-scan';

const PRODUCT_CONTEXT = `The Ultimate Game Master (theultimategamemaster.com) sells modular, magnetic leather GM screens for D&D, Pathfinder, and all TTRPGs. Core screen $139.99 (Portrait 36"Wx12"H or Landscape 48"Wx9"H, four 9"x12" panels). Snap-on magnetic accessories: Magnetic Map Pack $54.99, Large/Small Magnetic Pouches, Magnetic Bar Set, Initiative Trackers $17.99, Creature Trackers $17.99, Tablet Holder $16.99, Phone Holder $15.99, Quick-Load Panel $47.99, 5e Rules Pack $24.99. Ultimate Bundle $319.99. Free shipping over $99, 30-night returns. Differentiators: reconfigure layout mid-session, dry-erase surfaces, magnetic snap-on everything, tablet/phone holders for hybrid digital-physical play.
COUPON: "FIRSTTIMEGM" gives new GMs the Session Zero Checklist free. Include ONLY when a brand-new GM is preparing for their first session or asking about session zero. Frame as a freebie, keep disclosure.
ACCOUNT CAUTION: the human poster's account has prior mod-removals for promotion in r/DMAcademy, r/DnDHomebrew, r/DnDBehindTheScreen. In those subs prefer NO product mention.`;

const STYLE_RULES = `STYLE (strict): short and Reddit-like, a few brief paragraphs max. Plain words. Polite but not gushing. NO em dashes anywhere (use commas or periods). No marketing language. No bullet lists. Genuinely answer the question first, veteran-GM practical advice, cheap/DIY options included when honest. Mention The Ultimate Game Master ONLY when it directly solves their stated problem, as one option among others, always with "full disclosure, I work on The Ultimate Game Master". General new-DM advice threads get NO product mention (FIRSTTIMEGM freebie is the one exception per coupon rule).`;

const KEYWORDS =
  /\b(new dm|first (session|campaign|game)|becoming a dm|start(ing)? (dm|gm)|dm screen|gm screen|initiative|condition track|dice|miniature|minis|terrain|battle ?ma[pt]|table setup|session zero|session 0|what (do i|should i) (buy|need|get)|recommend|display|portrait|tablet|prep|organiz)/i;

Devvit.configure({ redditAPI: true, redis: true, http: true });

Devvit.addSettings([
  {
    name: 'anthropic-api-key',
    label: 'Anthropic API key (for Claude Haiku drafting)',
    type: 'string',
    isSecret: true,
    scope: 'app',
  },
  {
    name: 'digest-username',
    label: 'Reddit username to DM the daily digest to (no u/ prefix)',
    type: 'string',
    scope: 'installation',
  },
]);

// ---------- Scheduling ----------

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_event, context) => {
    // 11:00 UTC = 7am Toronto during EDT (6am during EST).
    await context.scheduler.runJob({ name: JOB_NAME, cron: '0 11 * * *' });
  },
});

Devvit.addSchedulerJob({
  name: JOB_NAME,
  onRun: async (_event, context) => {
    await runScan(context);
  },
});

// Manual trigger from the subreddit's mod menu.
Devvit.addMenuItem({
  label: 'DM Radar: scan now',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showToast('Scanning… digest PM arrives when done.');
    await runScan(context);
    context.ui.showToast('Scan complete.');
  },
});

// Create the dashboard post.
Devvit.addMenuItem({
  label: 'DM Radar: create dashboard post',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const sub = await context.reddit.getCurrentSubreddit();
    await context.reddit.submitPost({
      subredditName: sub.name,
      title: '🎲 DM Equipment Signals',
      preview: (
        <vstack alignment="center middle" height="100%">
          <text>Loading DM Radar…</text>
        </vstack>
      ),
    });
    context.ui.showToast('Dashboard post created. Pin it!');
  },
});

// ---------- Pipeline ----------

type Signal = {
  strength: 'High' | 'Medium' | 'Low';
  sub: string;
  author: string;
  meta: string;
  title: string;
  url: string;
  summary: string;
  whyfit: string;
  draft: string;
};

type Day = {
  date: string;
  scanned: string;
  found: number;
  best: string;
  signals: Signal[];
};

async function runScan(context: Devvit.Context): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);

  // 1. Gather fresh posts (last ~26h) from each subreddit.
  const candidates: any[] = [];
  let total = 0;
  for (const subName of SUBREDDITS) {
    const listing = await context.reddit
      .getNewPosts({ subredditName: subName, limit: 25 })
      .all();
    for (const post of listing) {
      total++;
      const ageHrs = (Date.now() - post.createdAt.getTime()) / 3.6e6;
      if (ageHrs > 26) continue;
      const body = (post.body ?? '').slice(0, 1500);
      if (!KEYWORDS.test(post.title + ' ' + body)) continue;
      // 2. Dedup: skip anything we've drafted before.
      const seen = await context.redis.get(`seen:${post.permalink}`);
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

  // 3. Haiku selects and drafts.
  const day: Day = {
    date,
    scanned: `${total} posts across ${SUBREDDITS.map((s) => 'r/' + s).join(', ')}`,
    found: 0,
    best: 'No qualifying signals today.',
    signals: [],
  };

  if (candidates.length) {
    const apiKey = (await context.settings.get('anthropic-api-key')) as string;
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
              candidates.map(({ permalink, ...rest }) => rest)
            )}`,
          },
        ],
      }),
    });

    if (res.ok) {
      try {
        const body = (await res.json()) as any;
        const text = body.content[0].text.trim().replace(/^```json\s*|\s*```$/g, '');
        const out = JSON.parse(text);
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

  // 4. Persist + mark selected threads as seen (90-day TTL keeps Redis tidy).
  for (const s of day.signals) {
    const perma = s.url.replace('https://old.reddit.com', '');
    await context.redis.set(`seen:${perma}`, date, { expiration: new Date(Date.now() + 90 * 864e5) });
  }
  await context.redis.set('latest', JSON.stringify(day));

  // 5. DM digest with full drafts.
  const to = (await context.settings.get('digest-username')) as string;
  if (to) {
    const lines = day.signals
      .map(
        (s, i) =>
          `**${i + 1}. [${s.strength}] ${s.title}**\n${s.sub} · ${s.author} · ${s.meta}\n${s.url}\n_${s.whyfit}_\n\n> ${s.draft.split('\n').join('\n> ')}\n`
      )
      .join('\n---\n\n');
    await context.reddit.sendPrivateMessage({
      to,
      subject: `DM Signals ${date}: ${day.found} opportunities`,
      text: `Scanned ${day.scanned}.\n\n⭐ **Best:** ${day.best}\n\n${lines || 'None today.'}\n\n🎟 Reminder: FIRSTTIMEGM = free Session Zero Checklist for new GMs (only when it truly fits).\n\n_Drafts are never auto-posted. Copy, tweak, post manually._`,
    });
  }
}

// ---------- Dashboard custom post ----------

Devvit.addCustomPostType({
  name: 'DM Radar',
  height: 'tall',
  render: (context) => {
    const [day] = useState<Day | null>(async () => {
      const raw = await context.redis.get('latest');
      return raw ? (JSON.parse(raw) as Day) : null;
    });
    const [selected, setSelected] = useState(-1);

    if (!day) {
      return (
        <vstack alignment="center middle" height="100%" gap="small">
          <text size="large" weight="bold">🎲 DM Radar</text>
          <text color="neutral-content-weak">No scan yet. Use the subreddit menu: "DM Radar: scan now".</text>
        </vstack>
      );
    }

    if (selected >= 0 && day.signals[selected]) {
      const s = day.signals[selected];
      return (
        <vstack padding="medium" gap="small" height="100%">
          <hstack gap="small" alignment="start middle">
            <button size="small" onPress={() => setSelected(-1)}>← Back</button>
            <text weight="bold" size="small">[{s.strength}] {s.sub}</text>
          </hstack>
          <text weight="bold" wrap>{s.title}</text>
          <text size="small" color="neutral-content-weak" wrap>{s.summary}</text>
          <vstack backgroundColor="neutral-background-weak" cornerRadius="small" padding="small" grow>
            <text size="small" wrap>{s.draft}</text>
          </vstack>
          <text size="xsmall" color="neutral-content-weak" wrap>
            Full copyable draft is in your digest PM. This panel is for review on the go.
          </text>
          <button onPress={() => context.ui.navigateTo(s.url)}>Open thread</button>
        </vstack>
      );
    }

    return (
      <vstack padding="medium" gap="small" height="100%">
        <text size="large" weight="bold">🎲 DM Equipment Signals · {day.date}</text>
        <text size="small" color="neutral-content-weak" wrap>{day.scanned} · {day.found} signals</text>
        <text size="small" wrap>⭐ {day.best}</text>
        <text size="xsmall" color="neutral-content-weak" wrap>🎟 FIRSTTIMEGM = free Session Zero Checklist for brand-new GMs. Use only when it truly fits.</text>
        <vstack gap="small" grow>
          {day.signals.map((s, i) => (
            <hstack
              backgroundColor="neutral-background-weak"
              cornerRadius="small"
              padding="small"
              gap="small"
              onPress={() => setSelected(i)}
            >
              <text size="small" weight="bold">[{s.strength[0]}]</text>
              <vstack grow>
                <text size="small" weight="bold" wrap>{s.title}</text>
                <text size="xsmall" color="neutral-content-weak">{s.sub} · {s.meta}</text>
              </vstack>
            </hstack>
          ))}
        </vstack>
      </vstack>
    );
  },
});

export default Devvit;
