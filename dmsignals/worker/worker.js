/**
 * dmsignals — daily Reddit DM-equipment-signal scanner for The Ultimate Game Master.
 * Cron: fetches new posts from target subreddits via the official Reddit API,
 * dedupes against KV, has Claude Haiku select & draft replies, checks the
 * account inbox for replies to past comments, stores the day's JSON in KV,
 * and emails a digest via Resend.
 *
 * Secrets (wrangler secret put ...):
 *   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
 *   ANTHROPIC_API_KEY, RESEND_API_KEY, DIGEST_TO (your email), DIGEST_FROM (verified Resend sender)
 * Bindings: KV namespace "SIGNALS"
 */

const SUBREDDITS = ["DMAcademy", "DungeonMasters", "DnD", "dndnext", "rpg"];
const UA = "dmsignals/1.0 (signal monitor by u/REPLACE_WITH_YOUR_USERNAME)";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const PRODUCT_CONTEXT = `The Ultimate Game Master (theultimategamemaster.com) sells modular, magnetic leather GM screens for D&D, Pathfinder, and all TTRPGs. Core screen $139.99 (Portrait 36"Wx12"H or Landscape 48"Wx9"H, four 9"x12" panels). Snap-on magnetic accessories: Magnetic Map Pack $54.99, Large/Small Magnetic Pouches, Magnetic Bar Set, Initiative Trackers $17.99, Creature Trackers $17.99, Tablet Holder $16.99, Phone Holder $15.99, Quick-Load Panel $47.99, 5e Rules Pack $24.99. Ultimate Bundle $319.99. Free shipping over $99, 30-night returns. Differentiators: reconfigure layout mid-session, dry-erase surfaces, magnetic snap-on everything, tablet/phone holders for hybrid digital-physical play.
COUPON: "FIRSTTIMEGM" gives new GMs the Session Zero Checklist free. Include ONLY when a brand-new GM is preparing for their first session or asking about session zero. Frame as a freebie, keep disclosure.
ACCOUNT CAUTION: this account has prior mod-removals for promotion in r/DMAcademy, r/DnDHomebrew, r/DnDBehindTheScreen. In those subs prefer NO product mention.`;

const STYLE_RULES = `STYLE (strict): short and Reddit-like, a few brief paragraphs max. Plain words. Polite but not gushing. NO em dashes anywhere (use commas or periods). No marketing language. No bullet lists. Genuinely answer the question first, veteran-GM practical advice, cheap/DIY options included when honest. Mention The Ultimate Game Master ONLY when it directly solves their stated problem, as one option among others, always with "full disclosure, I work on The Ultimate Game Master". General new-DM advice threads get NO product mention (FIRSTTIMEGM freebie is the one exception per coupon rule).`;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPipeline(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };
    if (url.pathname === "/data") {
      const data = await env.SIGNALS.get("latest");
      return new Response(data || JSON.stringify(emptyDay()), { headers: cors });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      // Manual trigger, protected by secret header.
      if (request.headers.get("x-run-key") !== (await env.SIGNALS.get("run-key"))) {
        return new Response("forbidden", { status: 403 });
      }
      const result = await runPipeline(env);
      return new Response(JSON.stringify(result), { headers: cors });
    }
    return new Response("dmsignals worker. GET /data for latest signals.", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};

function emptyDay() {
  return { date: today(), scanned: "no run yet", found: 0, best: "", replies: [], signals: [] };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function runPipeline(env) {
  const token = await redditToken(env);

  // 1. Fetch new posts from each subreddit.
  const posts = [];
  for (const sub of SUBREDDITS) {
    const listing = await redditGet(`/r/${sub}/new?limit=25`, token);
    for (const child of listing?.data?.children || []) {
      const p = child.data;
      const ageHrs = (Date.now() / 1000 - p.created_utc) / 3600;
      if (ageHrs > 26 || p.stickied) continue;
      posts.push({
        sub: `r/${sub}`,
        author: `u/${p.author}`,
        title: p.title,
        selftext: (p.selftext || "").slice(0, 1500),
        url: `https://old.reddit.com${p.permalink}`,
        ageHrs: Math.round(ageHrs),
        comments: p.num_comments,
        ups: p.ups,
      });
    }
  }

  // 2. Dedup against previously covered URLs.
  const seenRaw = (await env.SIGNALS.get("seen-urls")) || "[]";
  const seen = new Set(JSON.parse(seenRaw));
  const fresh = posts.filter((p) => !seen.has(p.url));

  // 3. Cheap keyword pre-filter to keep the Haiku prompt small.
  const KEYWORDS = /\b(new dm|first (session|campaign|game)|becoming a dm|start(ing)? (dm|gm)|dm screen|gm screen|initiative|condition track|dice|miniature|minis|terrain|battle ?ma[pt]|table setup|session zero|session 0|what (do i|should i) (buy|need|get)|recommend|display|portrait|tablet|prep|organiz)/i;
  const candidates = fresh.filter((p) => KEYWORDS.test(p.title + " " + p.selftext)).slice(0, 30);

  // 4. Haiku selects the top signals and writes drafts.
  const day = await haikuSelectAndDraft(env, candidates, posts.length);

  // 5. Inbox: replies to our comments (read-only).
  day.replies = await checkInbox(env, token);

  // 6. Persist: latest data + grow the seen set.
  for (const s of day.signals) seen.add(s.url);
  await env.SIGNALS.put("seen-urls", JSON.stringify([...seen].slice(-2000)));
  await env.SIGNALS.put("latest", JSON.stringify(day));
  await env.SIGNALS.put(`day:${day.date}`, JSON.stringify(day)); // per-day archive

  // 7. Email digest.
  await sendDigest(env, day);

  return { ok: true, signals: day.signals.length, replies: day.replies.length };
}

async function redditToken(env) {
  const basic = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: env.REDDIT_USERNAME,
      password: env.REDDIT_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`reddit token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function redditGet(path, token) {
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
  if (!res.ok) return null;
  return res.json();
}

async function haikuSelectAndDraft(env, candidates, scannedCount) {
  const base = {
    date: today(),
    scanned: `${scannedCount} posts across ${SUBREDDITS.map((s) => "r/" + s).join(", ")}`,
    found: 0,
    best: "No qualifying signals today.",
    replies: [],
    signals: [],
  };
  if (!candidates.length) return base;

  const prompt = `You are selecting sales signals for a TTRPG accessories company and drafting Reddit replies for HUMAN review (never auto-posted).

${PRODUCT_CONTEXT}

${STYLE_RULES}

Below are candidate Reddit posts (JSON). Select the 3-5 strongest buying/need signals: new DMs asking what to buy or how to start, digital-to-physical transitions, GM screen / initiative tracking / table setup / displaying art at the table / session prep organization questions. Skip pure rules questions, memes, art showcases.

Return ONLY valid JSON, no markdown fences, in this exact schema:
{"best":"one sentence naming today's single best opportunity and why","signals":[{"strength":"High|Medium|Low","sub":"r/...","author":"u/...","meta":"<ageHrs> hr old · <comments> comments","title":"...","url":"...","summary":"one line","whyfit":"one line","draft":"the full reply text"}]}

Candidates:
${JSON.stringify(candidates)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    base.best = `Haiku call failed (${res.status}); raw candidates kept.`;
    return base;
  }
  const body = await res.json();
  try {
    const text = body.content[0].text.trim().replace(/^```json\s*|\s*```$/g, "");
    const out = JSON.parse(text);
    base.signals = out.signals || [];
    base.best = out.best || base.best;
    base.found = base.signals.length;
  } catch (e) {
    base.best = "Failed to parse Haiku output; check worker logs.";
  }
  return base;
}

async function checkInbox(env, token) {
  const inbox = await redditGet("/message/inbox?limit=25", token);
  if (!inbox) return [];
  const cutoff = Date.now() / 1000 - 26 * 3600;
  const replies = [];
  for (const child of inbox.data?.children || []) {
    const m = child.data;
    if (m.was_comment !== true || m.created_utc < cutoff) continue;
    replies.push({
      from: `u/${m.author}`,
      thread: m.link_title || m.subject,
      url: `https://old.reddit.com${m.context || ""}`,
      snippet: (m.body || "").slice(0, 400),
      received: new Date(m.created_utc * 1000).toISOString().slice(0, 16).replace("T", " "),
      actions: [], // filled by Haiku below
    });
  }
  if (!replies.length) return replies;

  // Haiku drafts suggested actions for each reply.
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `${STYLE_RULES}\n\nThese are replies to our Reddit comments. For each, suggest 1-3 actions with a ready-to-copy draft each: brief thanks, answer a follow-up (product context only if directly relevant, with disclosure), or "Let it ride" with empty draft if no response is best. Hostile replies get a calm non-defensive draft or a do-not-engage recommendation.\n\nReturn ONLY valid JSON: an array matching the input order, each item {"actions":[{"label":"...","draft":"..."}]}.\n\nReplies:\n${JSON.stringify(replies.map((r) => ({ from: r.from, thread: r.thread, snippet: r.snippet })))}`,
        },
      ],
    }),
  });
  if (res.ok) {
    try {
      const body = await res.json();
      const text = body.content[0].text.trim().replace(/^```json\s*|\s*```$/g, "");
      const acts = JSON.parse(text);
      replies.forEach((r, i) => (r.actions = acts[i]?.actions || []));
    } catch (e) {
      /* leave actions empty */
    }
  }
  return replies;
}

async function sendDigest(env, day) {
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
    .join("");

  const replyRows = day.replies.length
    ? day.replies
        .map(
          (r) => `<div style="border:1px solid #ecd9b4;border-radius:10px;padding:12px;margin:8px 0;background:#fdf3e0;">
        <b>${r.from}</b> on "${escapeHtml(r.thread)}" (${r.received})<br>
        <i>"${escapeHtml(r.snippet)}"</i><br>
        <a href="${r.url}">Open thread</a> · suggested actions on the dashboard</div>`
        )
        .join("")
    : "<p>No new replies to your comments.</p>";

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:auto;color:#1f1b16;">
    <h2>🎲 DM Signals · ${day.date}</h2>
    <p>${escapeHtml(day.scanned)} · <b>${day.found}</b> signals</p>
    <p style="background:#fdf3e0;padding:10px;border-radius:8px;">⭐ ${escapeHtml(day.best)}</p>
    <h3>Replies to you</h3>
    ${replyRows}
    <h3>Today's signals</h3>
    ${rows || "<p>None today.</p>"}
    <p style="font-size:12px;color:#8a8072;">🎟 Reminder: FIRSTTIMEGM = free Session Zero Checklist for new GMs. Drafts are never auto-posted.</p>
  </div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.DIGEST_FROM,
      to: [env.DIGEST_TO],
      subject: `DM Signals ${day.date}: ${day.found} opportunities${day.replies.length ? `, ${day.replies.length} replies` : ""}`,
      html,
    }),
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
