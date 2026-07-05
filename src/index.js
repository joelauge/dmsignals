// New DM Radar — Cloudflare Worker
// Polls Reddit for first-time-DM signals, scores them, dedupes in KV,
// and emails a digest via Resend.
//
// Crons (wrangler.toml):
//   */120 poll  -> "0 */2 * * *"   scan subreddits, store scored leads
//   daily digest -> "0 13 * * *"   email everything collected (13:00 UTC = 9am ET)

import { scorePost, THRESHOLD } from "./scoring.js";

const SUBREDDITS = ["DMAcademy", "DnD", "DungeonMasters", "dndnext"];
const USER_AGENT = "web:new-dm-radar:v1.0 (by /u/YOUR_REDDIT_USERNAME)";
const SEEN_TTL = 60 * 60 * 24 * 14; // remember posts 14 days
const PENDING_KEY = "pending_digest";

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "0 13 * * *") {
      ctx.waitUntil(sendDigest(env));
    } else {
      ctx.waitUntil(poll(env));
    }
  },

  // Manual triggers for testing: /run and /digest, guarded by ADMIN_KEY secret
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("key") !== env.ADMIN_KEY) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/run") {
      const found = await poll(env);
      return Response.json({ newLeads: found });
    }
    if (url.pathname === "/digest") {
      const sent = await sendDigest(env);
      return Response.json({ emailed: sent });
    }
    return new Response("ok. paths: /run /digest");
  },
};

// ---------- Reddit ----------

async function redditToken(env) {
  const cached = await env.LEADS.get("reddit_token");
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
  if (!res.ok) throw new Error(`Reddit token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  // Cache slightly under the 1h expiry
  await env.LEADS.put("reddit_token", data.access_token, { expirationTtl: 3000 });
  return data.access_token;
}

async function fetchNewPosts(env, subreddit, token) {
  const res = await fetch(
    `https://oauth.reddit.com/r/${subreddit}/new?limit=50&raw_json=1`,
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT } }
  );
  if (!res.ok) {
    console.log(`fetch r/${subreddit} failed: ${res.status}`);
    return [];
  }
  const json = await res.json();
  return (json?.data?.children || []).map((c) => c.data);
}

// ---------- Poll ----------

async function poll(env) {
  const token = await redditToken(env);
  const leads = [];

  for (const sub of SUBREDDITS) {
    const posts = await fetchNewPosts(env, sub, token);
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
        title: p.title,
        author: p.author,
        url: `https://www.reddit.com${p.permalink}`,
        created_utc: p.created_utc,
        excerpt: (p.selftext || "").slice(0, 280),
      });
    }
  }

  if (leads.length) {
    const pending = JSON.parse((await env.LEADS.get(PENDING_KEY)) || "[]");
    pending.push(...leads);
    await env.LEADS.put(PENDING_KEY, JSON.stringify(pending));

    // Optional: instant email for very hot leads (score >= 60)
    if (env.INSTANT_HOT === "true") {
      const hot = leads.filter((l) => l.score >= 60);
      if (hot.length) await sendEmail(env, `🔥 ${hot.length} hot new-DM lead(s)`, renderLeads(hot));
    }
  }

  console.log(`poll complete: ${leads.length} new lead(s)`);
  return leads.length;
}

// ---------- Digest ----------

async function sendDigest(env) {
  const pending = JSON.parse((await env.LEADS.get(PENDING_KEY)) || "[]");
  if (!pending.length) {
    console.log("digest: nothing pending");
    return 0;
  }
  pending.sort((a, b) => b.score - a.score);
  await sendEmail(env, `🎲 New DM Radar: ${pending.length} lead(s) today`, renderLeads(pending));
  await env.LEADS.put(PENDING_KEY, "[]");
  return pending.length;
}

function renderLeads(leads) {
  const rows = leads
    .map(
      (l) => `
    <div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:12px">
      <div style="font-size:13px;color:#666">r/${l.subreddit} · u/${l.author} · score <b>${l.score}</b> · ${l.reasons.join(", ")}</div>
      <div style="font-size:16px;margin:6px 0"><a href="${l.url}">${escapeHtml(l.title)}</a></div>
      <div style="font-size:13px;color:#444">${escapeHtml(l.excerpt)}</div>
    </div>`
    )
    .join("");
  return `<div style="font-family:sans-serif;max-width:640px">
    <p>Sorted by score. Reply helpfully — answer their question first.</p>
    ${rows}
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
      from: env.EMAIL_FROM, // e.g. "New DM Radar <radar@theultimategamemaster.com>"
      to: [env.EMAIL_TO],   // e.g. "joelauge@gmail.com"
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
}
