// Keyword + rules scoring for "first-time DM" intent signals.
// Pure module (no CF dependencies) so it can be unit-tested locally.

const TIER_A = [ // self-declared life-event language: highest intent
  /first[\s-]*time\s+dm/i,
  /first[\s-]*time\s+dming/i,
  /my\s+first\s+campaign/i,
  /first\s+campaign\s+as\s+(a\s+)?dm/i,
  /new\s+dm\s+here/i,
  /just\s+(agreed|volunteered|decided)\s+to\s+dm/i,
  /never\s+dm['’]?e?d\s+before/i,
  /dm(ing)?\s+for\s+the\s+first\s+time/i,
  /running\s+my\s+first\s+(campaign|session|game|one[\s-]*shot)/i,
  /about\s+to\s+run\s+my\s+first/i,
];

const TIER_B = [ // strong adjacent signals
  /\bnew\s+dm\b/i,
  /\bnew\s+gm\b/i,
  /session\s+zero/i,
  /starting\s+(my\s+)?first\s+campaign/i,
  /first\s+session\s+(as|is|tomorrow|tonight|this)/i,
  /becoming\s+a\s+dm/i,
  /how\s+do\s+i\s+start\s+dming/i,
];

const TIER_C = [ // research-phase signals
  /tips\s+for\s+(a\s+)?(new|first[\s-]*time)\s+dm/i,
  /what\s+do\s+i\s+need\s+to\s+(start\s+)?dm/i,
  /advice\s+for\s+(a\s+)?new\s+dm/i,
  /never\s+played\s+.{0,30}\bdm\b/i,
  /beginner\s+dm/i,
];

const NEGATIVE = [ // likely not a lead
  /\blfg\b/i,
  /\blfp\b/i,
  /looking\s+for\s+(players|group)/i,
  /\bpaid\s+dm\b/i,
  /hiring/i,
  /\bAL\s+legal\b/i,
];

const SUB_WEIGHT = {
  dmacademy: 10,
  dungeonmasters: 10,
  dnd: 0,
  dndnext: 0,
};

export function scorePost(post) {
  const text = `${post.title || ""} ${post.selftext || ""}`;
  const reasons = [];
  let score = 0;

  if (NEGATIVE.some((re) => re.test(text))) {
    return { score: 0, reasons: ["negative-filter"] };
  }

  if (TIER_A.some((re) => re.test(text))) { score += 50; reasons.push("tier-A: self-declared first-time DM"); }
  if (TIER_B.some((re) => re.test(text))) { score += 30; reasons.push("tier-B: strong adjacent signal"); }
  if (TIER_C.some((re) => re.test(text))) { score += 15; reasons.push("tier-C: research-phase signal"); }

  const subW = SUB_WEIGHT[(post.subreddit || "").toLowerCase()] ?? 0;
  if (subW) { score += subW; reasons.push(`subreddit +${subW}`); }

  if (/\?/.test(post.title || "")) { score += 5; reasons.push("asks a question"); }

  // Recency: posts under 6h old get a small boost (time-boxed intent)
  const ageHours = (Date.now() / 1000 - (post.created_utc || 0)) / 3600;
  if (ageHours >= 0 && ageHours <= 6) { score += 5; reasons.push("fresh (<6h)"); }

  return { score, reasons };
}

export const THRESHOLD = 30;
