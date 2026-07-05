// DM Radar — Cloudflare Worker
// Polls Reddit for DM/GM equipment-need signals, scores + dedupes them,
// has Claude Haiku pick the best few and draft ready-to-post replies,
// checks the Reddit inbox for replies to past comments, emails a daily
// digest via Resend, and serves GET /data for the GitHub Pages dashboard.
//
// Crons (wrangler.toml):
//   every 2h  -> "0 */2 * * *"  poll subreddits, score, dedupe, queue leads
//   daily     -> "0 13 * * *"   Haiku draft + inbox check + email digest (13:00 UTC = 9am ET)

import { scorePost, THRESHOLD } from "./scoring.js";

const SUBREDDITS = ["DMAcademy", "DungeonMasters", "DnD", "dndnext", "rpg"];
const USER_AGENT = "web:dmsignals:v2.0 (by /u/REPLACE_WITH_YOUR_USERNAME)";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SEEN_TTL = 60 * 60 * 24 * 14; // remember posts 14 days
const PENDING_KEY = "pending_digest";

const PRODUCT_CONTEXT = `The Ultimate Game Master (theultimategamemaster.com) sells modular, magnetic leather GM screens for D&D, Pathfinder, and all TTRPGs. Core screen $139.99 (Portrait 36"Wx12"H or Landscape 48"Wx9"H, four 9"x12" panels). Snap-on magnetic accessories: Magnetic Map Pack $54.99, Large/Small Magnetic Pouches, Magnetic Bar Set, Initiative Trackers $17.99, Creature Trackers $17.99, Tablet Holder $16.99, Phone Holder $15.99, Quick-Load Panel $47.99, 5e Rules Pack $24.99. Ultimate Bundle $319.99. Free shipping over $99, 30-night returns. Differentiators: reconfigure layout mid-session, dry-erase surfaces, magnetic snap-on everything, tablet/phone holders for hybrid digital-physical play.
COUPON: "FIRSTTIMEGM" gives new GMs the Session Zero Checklist free. Include ONLY when a brand-new GM is preparing for their first session or asking about session zero. Frame as a freebie, keep disclosure.
ACCOUNT CAUTION: this account has prior mod-removals for promotion in r/DMAcademy, r/DnDHomebrew, r/DnDBehindTheScreen. In those subs prefer NO product mention.`;

const STYLE_RULES = `STYLE (strict): short and Reddit-like, a few brief paragraphs max. Plain words. Polite but not gushing. NO em dashes anywhere (use commas or periods). No marketing language. No bullet lists. Genuinely answer the question first, veteran-GM practical advice, cheap/DIY options included when honest. Mention The Ultimate Game Master ONLY when it directly solves their stated problem, as one option among others, always with "full disclosure, I work on The Ultimate Game Master". General new-DM advice threads get NO product mention (FIRSTTIMEGM freebie is the one exception per coupon rule).`;

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "0 13 * * *") {
      ctx.waitUntil(sendDigest(env));
    } else {
      ctx.waitUntil(poll(env));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/data") {
      const data = await env.LEADS.get("latest");
      return new Response(data || JSON.stringify(emptyDay()), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Manual triggers for testing: /run and /digest, guarded by ADMIN_KEY secret
    if (url.searchParams.get("key") !== env.ADMIN_KEY) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/run") {
      const found = await poll(env);
      return Response.json({ newLeads: found });
    }
    if (url.pathname === "/digest") {
      const day = await sendDigest(env);
      return Response.json({ signals: day.signals.length, replies: day.replies.length });
    }
    return new Response("ok. paths: /data /run /digest");
  },
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function emptyDay() {
  return { date: today(), scanned: "no run yet", found: 0, best: "", replies: [], signals: [] };
}

// ---------- Reddit auth ----------
// Two token types: an app-only token (client credentials) for browsing
// subreddits, and a user token (password grant) needed to read the
// account's inbox for reply tracking.

async function redditAppToken(env) {
  const cached = await env.LEADS.get("reddit_token_app");
  if (cached) return cached;

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Reddit app token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  await env.LEADS.put("reddit_token_app", data.access_token, { expirationTtl: 3000 });
  return data.access_token;
}

async function redditUserToken(env) {
  const cached = await env.LEADS.get("reddit_token_user");
  if (cached) return cached;

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: env.REDDIT_USERNAME,
      password: env.REDDIT_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`Reddit user token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  await env.LEADS.put("reddit_token_user", data.access_token, { expirationTtl: 3000 });
  return data.access_token;
}

async function redditGet(path, token) {
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    console.log(`GET ${path} failed: ${res.status}`);
    return null;
  }
  return res.json();
}

// ---------- Poll: fetch, score, dedupe, queue ----------

async function poll(env) {
  const token = await redditAppToken(env);
  const leads = [];

  for (const sub of SUBREDDITS) {
    const listing = await redditGet(`/r/${sub}/new?limit=50&raw_json=1`, token);
    const posts = listing?.data?.children?.map((c) => c.data) || [];

    for (const p of posts) {
      const seenKey = `seen:${p.id}`;
      if (await env.LEADS.get(seenKey)) continue;
      await env.LEADS.put(seenKey, "1", { expirationTtl: SEEN_TTL });

      const { score, reasons } = scorePost(p);
      if (score < THRESHOLD) continue;

      leads.push({
        id: p.id,
        score,
        reasons,
        subreddit: p.subreddit,
        author: p.author,
        title: p.title,
        url: `https://www.reddit.com${p.permalink}`,
        created_utc: p.created_utc,
        comments: p.num_comments,
        ups: p.ups,
        selftext: (p.selftext || "").slice(0, 1500),
      });
    }
  }

  if (leads.length) {
    const pending = JSON.parse((await env.LEADS.get(PENDING_KEY)) || "[]");
    pending.push(...leads);
    await env.LEADS.put(PENDING_KEY, JSON.stringify(pending));

    // Optional: instant email for very hot leads (score >= 60), raw (no draft yet)
    if (env.INSTANT_HOT === "true") {
      const hot = leads.filter((l) => l.score >= 60);
      if (hot.length) await sendEmail(env, `🔥 ${hot.length} hot lead(s)`, renderRawLeads(hot));
    }
  }

  console.log(`poll complete: ${leads.length} new lead(s)`);
  return leads.length;
}

// ---------- Digest: Haiku draft + inbox check + email ----------

async function sendDigest(env) {
  const pending = JSON.parse((await env.LEADS.get(PENDING_KEY)) || "[]");
  pending.sort((a, b) => b.score - a.score);

  const day = await haikuSelectAndDraft(env, pending);
  day.replies = await checkInbox(env);

  await env.LEADS.put("latest", JSON.stringify(day));
  await env.LEADS.put(`day:${day.date}`, JSON.stringify(day));
  await env.LEADS.put(PENDING_KEY, "[]");

  await sendEmail(
    env,
    `🎲 DM Signals ${day.date}: ${day.found} opportunities${day.replies.length ? `, ${day.replies.length} replies` : ""}`,
    renderDigestHtml(day)
  );

  return day;
}

async function haikuSelectAndDraft(env, leads) {
  const day = {
    date: today(),
    scanned: `${leads.length} queued lead(s) across ${SUBREDDITS.map((s) => "r/" + s).join(", ")}`,
    found: 0,
    best: "No qualifying signals today.",
    replies: [],
    signals: [],
  };
  if (!leads.length) return day;

  const candidates = leads.slice(0, 30).map((l) => ({
    sub: `r/${l.subreddit}`,
    author: `u/${l.author}`,
    title: l.title,
    selftext: l.selftext,
    url: l.url,
    ageHrs: Math.round((Date.now() / 1000 - l.created_utc) / 3600),
    comments: l.comments,
    ups: l.ups,
  }));

  const prompt = `You are selecting sales signals for a TTRPG accessories company and drafting Reddit replies for HUMAN review (never auto-posted).

${PRODUCT_CONTEXT}

${STYLE_RULES}

Below are candidate Reddit posts (JSON), already keyword/score-filtered. Select the 3-5 strongest buying/need signals: new DMs asking what to buy or how to start, digital-to-physical transitions, GM screen / initiative tracking / table setup / displaying art at the table / session prep organization questions. Skip pure rules questions, memes, art showcases.

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
    body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) {
    day.best = `Haiku call failed (${res.status}); raw leads kept in KV.`;
    return day;
  }
  try {
    const body = await res.json();
    const text = body.content[0].text.trim().replace(/^```json\s*|\s*```$/g, "");
    const out = JSON.parse(text);
    day.signals = out.signals || [];
    day.best = out.best || day.best;
    day.found = day.signals.length;
  } catch (e) {
    day.best = "Failed to parse Haiku output; check worker logs.";
  }
  return day;
}

async function checkInbox(env) {
  const token = await redditUserToken(env);
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
      actions: [],
    });
  }
  if (!replies.length) return replies;

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

// ---------- Rendering ----------

function renderRawLeads(leads) {
  const rows = leads
    .map(
      (l) => `
    <div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:12px">
      <div style="font-size:13px;color:#666">r/${l.subreddit} · u/${l.author} · score <b>${l.score}</b> · ${l.reasons.join(", ")}</div>
      <div style="font-size:16px;margin:6px 0"><a href="${l.url}">${escapeHtml(l.title)}</a></div>
      <div style="font-size:13px;color:#444">${escapeHtml(l.selftext.slice(0, 280))}</div>
    </div>`
    )
    .join("");
  return `<div style="font-family:sans-serif;max-width:640px"><p>Sorted by score.</p>${rows}</div>`;
}

function renderDigestHtml(day) {
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

  return `
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
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Email (Resend) ----------

async function sendEmail(env, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [env.EMAIL_TO],
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
}
