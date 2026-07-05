import { reddit, redis, settings } from '@devvit/web/server';
import type { Comment } from '@devvit/web/server';
import type { Day, Reply, Signal } from '../../shared/api';

/**
 * dm-radar pipeline: reads new posts from target subreddits via the native
 * Reddit API, dedupes against Redis so a thread is never drafted twice,
 * sends candidates to Claude Haiku to select the top signals and write
 * Reddit-plain drafts, checks previously drafted threads for replies to the
 * owner's posted comments, stores the day's results in Redis, DMs a digest
 * to the configured recipient, and optionally emails it via Resend.
 *
 * It NEVER posts or comments anywhere. Drafts arrive in the digest for
 * manual copy-paste. The app runs as its own account and cannot read the
 * owner's personal inbox; reply tracking works by re-visiting drafted
 * threads and looking for replies to comments by the configured username.
 */

const SUBREDDITS = ['DMAcademy', 'DungeonMasters', 'DnD', 'dndnext', 'rpg'];
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const TRACK_DAYS = 7; // how long a drafted thread is watched for replies
const MAX_TRACKED = 30;

const PRODUCT_CONTEXT = `The Ultimate Game Master (theultimategamemaster.com) sells modular, magnetic leather GM screens for D&D, Pathfinder, and all TTRPGs. Core screen $139.99 (Portrait 36"Wx12"H or Landscape 48"Wx9"H, four 9"x12" panels). Snap-on magnetic accessories: Magnetic Map Pack $54.99, Large/Small Magnetic Pouches, Magnetic Bar Set, Initiative Trackers $17.99, Creature Trackers $17.99, Tablet Holder $16.99, Phone Holder $15.99, Quick-Load Panel $47.99, 5e Rules Pack $24.99. Ultimate Bundle $319.99. Free shipping over $99, 30-night returns. Differentiators: reconfigure layout mid-session, dry-erase surfaces, magnetic snap-on everything, tablet/phone holders for hybrid digital-physical play.
COUPON: "FIRSTTIMEGM" gives new GMs the Session Zero Checklist free. Include ONLY when a brand-new GM is preparing for their first session or asking about session zero. Frame as a freebie, keep disclosure.
ACCOUNT CAUTION: the human poster's account has prior mod-removals for promotion in r/DMAcademy, r/DnDHomebrew, r/DnDBehindTheScreen. In those subs prefer NO product mention.`;

const STYLE_RULES = `STYLE (strict): short and Reddit-like, a few brief paragraphs max. Plain words. Polite but not gushing. NO em dashes anywhere (use commas or periods). No marketing language. No bullet lists. Genuinely answer the question first, veteran-GM practical advice, cheap/DIY options included when honest. Mention The Ultimate Game Master ONLY when it directly solves their stated problem, as one option among others, always with "full disclosure, I work on The Ultimate Game Master". General new-DM advice threads get NO product mention (FIRSTTIMEGM freebie is the one exception per coupon rule).`;

const KEYWORDS =
  /\b(new dm|first (session|campaign|game)|becoming a dm|start(ing)? (dm|gm)|dm screen|gm screen|initiative|condition track|dice|miniature|minis|terrain|battle ?ma[pt]|table setup|session zero|session 0|what (do i|should i) (buy|need|get)|recommend|display|portrait|tablet|prep|organiz)/i;

type TrackedThread = {
  permalink: string;
  title: string;
  firstSeen: string;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function emptyDay(): Day {
  return {
    date: today(),
    scanned: 'no run yet',
    found: 0,
    best: 'No scan yet.',
    signals: [],
    replies: [],
  };
}

export async function getLatest(): Promise<Day> {
  const raw = await redis.get('latest');
  if (!raw) return emptyDay();
  const day = JSON.parse(raw) as Day;
  day.replies ??= [];
  return day;
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
    replies: [],
  };

  // 2. Haiku selects and drafts.
  if (candidates.length) {
    const apiKey = (await settings.get<string>('anthropic-api-key')) ?? '';
    if (!apiKey) {
      day.best = 'No anthropic-api-key app setting configured.';
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

  // 3. Check threads drafted on previous days for replies to the owner's comments.
  const tracked = await loadTracked();
  day.replies = await checkReplies(tracked);

  // 4. Track today's selected threads and prune the watch list.
  const known = new Set(tracked.map((t) => t.permalink));
  for (const s of day.signals) {
    const perma = s.url.replace('https://old.reddit.com', '');
    if (!known.has(perma)) {
      tracked.push({ permalink: perma, title: s.title, firstSeen: date });
    }
    await redis.set(`seen:${perma}`, date, { expiration: new Date(Date.now() + 90 * 864e5) });
  }
  const cutoff = Date.now() - TRACK_DAYS * 864e5;
  const pruned = tracked
    .filter((t) => new Date(t.firstSeen).getTime() >= cutoff)
    .slice(-MAX_TRACKED);
  await redis.set('tracked', JSON.stringify(pruned));

  // 5. Persist + deliver.
  await redis.set('latest', JSON.stringify(day));
  await sendDigestPm(day);
  await sendDigestEmail(day);

  return day;
}

async function loadTracked(): Promise<TrackedThread[]> {
  const raw = await redis.get('tracked');
  return raw ? (JSON.parse(raw) as TrackedThread[]) : [];
}

// Re-visit each tracked thread and collect replies to comments written by the
// configured owner username. Each reply is reported once (Redis dedup).
async function checkReplies(tracked: TrackedThread[]): Promise<Reply[]> {
  const owner = ((await settings.get<string>('digest-username')) ?? '').toLowerCase();
  if (!owner || !tracked.length) return [];

  const replies: Reply[] = [];

  const walk = async (comments: Comment[], parent: Comment | undefined, depth: number, thread: TrackedThread) => {
    for (const c of comments) {
      const isOwner = c.authorName.toLowerCase() === owner;
      if (parent && parent.authorName.toLowerCase() === owner && !isOwner) {
        const seenKey = `seen-reply:${c.id}`;
        if (!(await redis.get(seenKey))) {
          await redis.set(seenKey, '1', { expiration: new Date(Date.now() + 30 * 864e5) });
          replies.push({
            from: `u/${c.authorName}`,
            thread: thread.title,
            url: `https://old.reddit.com${c.permalink}`,
            snippet: c.body.slice(0, 400),
            received: c.createdAt.toISOString().slice(0, 16).replace('T', ' '),
          });
        }
      }
      if (depth > 1) {
        const kids = await c.replies.all();
        await walk(kids, c, depth - 1, thread);
      }
    }
  };

  for (const thread of tracked) {
    // permalink: /r/<sub>/comments/<id36>/<slug>/
    const id36 = thread.permalink.split('/')[4];
    if (!id36) continue;
    try {
      const top = await reddit.getComments({ postId: `t3_${id36}`, limit: 50 }).all();
      await walk(top, undefined, 3, thread);
    } catch (error) {
      console.error(`reply check failed for ${thread.permalink}: ${error}`);
    }
    if (replies.length >= 20) break;
  }

  return replies;
}

async function sendDigestPm(day: Day): Promise<void> {
  const to = await settings.get<string>('digest-username');
  if (!to) return;

  const lines = day.signals
    .map(
      (s, i) =>
        `**${i + 1}. [${s.strength}] ${s.title}**\n${s.sub} · ${s.author} · ${s.meta}\n${s.url}\n_${s.whyfit}_\n\n> ${s.draft.split('\n').join('\n> ')}\n`
    )
    .join('\n---\n\n');

  const replyLines = day.replies
    .map((r) => `**${r.from}** on "${r.thread}" (${r.received})\n> ${r.snippet.split('\n').join('\n> ')}\n${r.url}\n`)
    .join('\n');

  await reddit.sendPrivateMessage({
    to,
    subject: `DM Signals ${day.date}: ${day.found} opportunities${day.replies.length ? `, ${day.replies.length} replies` : ''}`,
    text: `Scanned ${day.scanned}.\n\n⭐ **Best:** ${day.best}\n\n${day.replies.length ? `**Replies to you:**\n\n${replyLines}\n---\n\n` : ''}${lines || 'None today.'}\n\n🎟 Reminder: FIRSTTIMEGM = free Session Zero Checklist for new GMs (only when it truly fits).\n\n_Drafts are never auto-posted. Copy, tweak, post manually._`,
  });
}

async function sendDigestEmail(day: Day): Promise<void> {
  const apiKey = await settings.get<string>('resend-api-key');
  const to = await settings.get<string>('digest-email');
  if (!apiKey || !to) return;
  const from = (await settings.get<string>('digest-email-from')) ?? 'DM Signals <radar@theultimategamemaster.com>';

  const rows = day.signals
    .map(
      (s) => `
    <div style="border:1px solid #e5dfd4;border-radius:10px;padding:14px;margin:10px 0;">
      <div style="font-size:12px;color:#8a8072;">${s.strength.toUpperCase()} · ${s.sub} · ${s.author} · ${s.meta}</div>
      <div style="font-weight:600;margin:4px 0;"><a href="${s.url}">${escapeHtml(s.title)}</a></div>
      <div style="font-size:13px;color:#4a4238;">${escapeHtml(s.summary)}</div>
      <pre style="background:#faf8f4;border:1px solid #e0d9cc;border-radius:8px;padding:10px;font-size:12px;white-space:pre-wrap;">${escapeHtml(s.draft)}</pre>
    </div>`
    )
    .join('');

  const replyRows = day.replies.length
    ? day.replies
        .map(
          (r) => `<div style="border:1px solid #ecd9b4;border-radius:10px;padding:12px;margin:8px 0;background:#fdf3e0;">
        <b>${escapeHtml(r.from)}</b> on "${escapeHtml(r.thread)}" (${r.received})<br>
        <i>"${escapeHtml(r.snippet)}"</i><br>
        <a href="${r.url}">Open thread</a></div>`
        )
        .join('')
    : '<p>No new replies found in drafted threads.</p>';

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:auto;color:#1f1b16;">
    <h2>🎲 DM Signals · ${day.date}</h2>
    <p>${escapeHtml(day.scanned)} · <b>${day.found}</b> signals</p>
    <p style="background:#fdf3e0;padding:10px;border-radius:8px;">⭐ ${escapeHtml(day.best)}</p>
    <h3>Replies to you</h3>
    ${replyRows}
    <h3>Today's signals</h3>
    ${rows || '<p>None today.</p>'}
    <p style="font-size:12px;color:#8a8072;">🎟 Reminder: FIRSTTIMEGM = free Session Zero Checklist for new GMs. Drafts are never auto-posted.</p>
  </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `DM Signals ${day.date}: ${day.found} opportunities${day.replies.length ? `, ${day.replies.length} replies` : ''}`,
      html,
    }),
  });
  if (!res.ok) {
    console.error(`Resend failed: ${res.status} ${await res.text()}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
