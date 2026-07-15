#!/usr/bin/env node
// Usage: node scripts/budget.mjs [newJobsPerDay]
//
// Simulates a full day of polling against a counted KV wrapper and prints the
// real read/write/delete totals, then checks them against the Workers Paid
// allowances. Two things this is actually looking for:
//
//   1. ID CHURN. An adapter whose job IDs are non-deterministic between two
//      identical calls burns a KV write on EVERY poll while looking perfectly
//      healthy. It is the most expensive thing that can go wrong and the least
//      visible. We catch it by fetching every board twice, live, and diffing.
//
//   2. Whether a steady-state (nothing-changed) poll really costs ZERO writes.
//
// The boards are fetched live once, then replayed for all 288 ticks -- so the
// real adapters.js parsing runs, not a stub of it.

import { COMPANIES } from "../src/config.js";
import { fetchCompany } from "../src/adapters.js";
import { runAll } from "../src/index.js";
import { screen } from "../src/classify.js";

const NEW_JOBS_PER_DAY = Number(process.argv[2] || 150);

const POLL_EVERY_MIN = 5;
const TICKS_PER_DAY = (24 * 60) / POLL_EVERY_MIN;   // 288

// developers.cloudflare.com/workers/platform/pricing (Workers Paid, $5/mo)
const PAID = {
  reads: 10_000_000, writes: 1_000_000, deletes: 1_000_000, cpuMs: 30_000_000, requests: 10_000_000,
};
// Haiku 4.5: $1 / M input, $5 / M output.
const HAIKU = { in: 1 / 1e6, out: 5 / 1e6 };
const TOK = { in: 320, out: 5 };   // prompt is ~300 tok + the title; reply is one word

const fmt = (n) => n.toLocaleString("en-US");
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;

// --- counted KV ------------------------------------------------------------
function makeKV() {
  const m = new Map();
  const ops = { get: 0, put: 0, delete: 0 };
  return {
    ops,
    async get(k, type) {
      ops.get++;
      const v = m.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { ops.put++; m.set(k, String(v)); },
    async delete(k) { ops.delete++; m.delete(k); },
  };
}

// ---------------------------------------------------------------------------
// 1. Fetch every board TWICE, live. Diff the IDs.
// ---------------------------------------------------------------------------
console.log(`\nfetching ${COMPANIES.length} boards twice to check ID stability...`);

const raw = new Map();   // url -> recorded response body, for replay
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const r = await realFetch(url, init);
  const body = await r.clone().text();
  if (r.ok) raw.set(String(url), body);
  return r;
};

async function snapshot(c) {
  try { return (await fetchCompany(c)).map((x) => x.id); } catch { return null; }
}

const churn = [];
const jobCounts = new Map();
for (const c of COMPANIES) {
  const a = await snapshot(c);
  const b = await snapshot(c);
  if (!a || !b) { console.log(`  ${c.name}: FAILED to fetch -- skipping`); continue; }
  jobCounts.set(c.name, a.length);

  const setA = new Set(a), setB = new Set(b);
  const gone = a.filter((id) => !setB.has(id));
  const added = b.filter((id) => !setA.has(id));
  // A genuinely-new posting between the two calls is possible but vanishingly
  // rare. Anything more than a couple of IDs moving is churn, not real change.
  if (gone.length || added.length) {
    churn.push({ name: c.name, gone: gone.length, added: added.length, total: a.length });
  }
}

globalThis.fetch = realFetch;

if (churn.length) {
  console.log(`\n  ⚠️  ID CHURN DETECTED -- these burn a write on every poll:`);
  for (const c of churn) {
    console.log(`     ${c.name}: ${c.gone} IDs vanished / ${c.added} appeared between two identical calls (of ${c.total})`);
  }
  console.log(`     Cost if unfixed: ${fmt(churn.length * TICKS_PER_DAY)} wasted writes/day.`);
} else {
  console.log(`  ✅ all ${jobCounts.size} adapters return stable IDs across two identical calls`);
}

// ---------------------------------------------------------------------------
// 2. Classifier load: how many live titles actually reach the LLM?
// ---------------------------------------------------------------------------
let titles = 0, toLLM = 0;
for (const c of COMPANIES) {
  try {
    for (const j of await fetchCompany(c)) {
      titles++;
      if (screen(j.title) === null) toLLM++;   // null == "ask the LLM"
    }
  } catch { /* already reported */ }
}
const llmRate = toLLM / titles;

// ---------------------------------------------------------------------------
// 3. Replay a full day against the counted KV.
// ---------------------------------------------------------------------------
const env = { JOBS: makeKV(), TG_TOKEN: "x", TG_CHAT_ID: "x", ANTHROPIC_KEY: "x" };
let llmCalls = 0;

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) return new Response("{}", { status: 200 });
  if (u.includes("api.anthropic.com")) { llmCalls++; return Response.json({ content: [{ text: "UNSURE" }] }); }
  const body = raw.get(u);
  if (body === undefined) return new Response("gone", { status: 503 });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
};

const live = COMPANIES.filter((c) => jobCounts.has(c.name));

await runAll(env, live);                              // tick 1: seed
const afterSeed = { ...env.JOBS.ops };

env.JOBS.ops.get = 0; env.JOBS.ops.put = 0; env.JOBS.ops.delete = 0;
await runAll(env, live);                              // tick 2: nothing changed
const steady = { ...env.JOBS.ops };

// Marginal cost of ONE tick that contains new jobs. Inject into a Greenhouse
// board (simple shape) and re-run, so we price a real "something appeared" tick.
const gh = live.find((c) => c.adapter === "greenhouse");
const ghUrl = `https://boards-api.greenhouse.io/v1/boards/${gh.slug}/jobs`;
const parsed = JSON.parse(raw.get(ghUrl));
parsed.jobs.push({
  id: 999999001, title: "Software Engineer Intern - Fall 2026",
  location: { name: "Austin, TX" }, absolute_url: "https://x.test/new",
});
raw.set(ghUrl, JSON.stringify(parsed));

env.JOBS.ops.get = 0; env.JOBS.ops.put = 0; env.JOBS.ops.delete = 0;
await runAll(env, live);
const withNew = { ...env.JOBS.ops };

// ---------------------------------------------------------------------------
// 4. Extrapolate to a day / month.
// ---------------------------------------------------------------------------
// Writes per tick that has a new job: 1 seen: + 1 shared digest (+ maybe a
// verdict cache entry). Ticks with new jobs are rare -- most are steady-state.
const writesPerNewJobTick = withNew.put - steady.put;
const ticksWithNewJobs = Math.min(NEW_JOBS_PER_DAY, TICKS_PER_DAY);

const day = {
  reads: steady.get * TICKS_PER_DAY,
  writes: steady.put * TICKS_PER_DAY + ticksWithNewJobs * writesPerNewJobTick + afterSeed.put,
  deletes: steady.delete * TICKS_PER_DAY,
  requests: TICKS_PER_DAY,
};
const month = Object.fromEntries(Object.entries(day).map(([k, v]) => [k, Math.round(v * 30)]));

const llmPerDay = Math.round(NEW_JOBS_PER_DAY * llmRate);
const llmCost = llmPerDay * 30 * (TOK.in * HAIKU.in + TOK.out * HAIKU.out);

// ---------------------------------------------------------------------------
console.log(`\n─── simulated day: ${live.length} companies, every ${POLL_EVERY_MIN} min (${TICKS_PER_DAY} ticks), ${NEW_JOBS_PER_DAY} new jobs/day\n`);
console.log(`  seed tick (first poll ever): ${afterSeed.put} writes, ${afterSeed.get} reads`);
console.log(`  steady tick (nothing new):   ${steady.put} writes, ${steady.get} reads   ${steady.put === 0 ? "✅ zero writes" : "❌ SHOULD BE ZERO"}`);
console.log(`  tick with a new job:         ${withNew.put} writes\n`);

const row = (label, used, cap) =>
  console.log(`  ${label.padEnd(12)} ${fmt(used).padStart(11)} / ${fmt(cap).padStart(11)}  ${pct(used, cap).padStart(6)}  ${used < cap ? "✅" : "❌ OVER"}`);

console.log(`  KV, per MONTH (against Workers Paid, $5/mo):`);
row("reads", month.reads, PAID.reads);
row("writes", month.writes, PAID.writes);
row("deletes", month.deletes, PAID.deletes);
row("requests", month.requests, PAID.requests);

console.log(`\n  classifier: ${toLLM}/${titles} live titles (${(llmRate * 100).toFixed(1)}%) are ambiguous enough to reach the LLM`);
console.log(`  ~${llmPerDay} LLM calls/day  ->  $${llmCost.toFixed(2)}/mo on Haiku 4.5 (and title verdicts cache forever, so this is an overestimate)`);
console.log(`\n  TOTAL: $5.00 Cloudflare + $${llmCost.toFixed(2)} Anthropic = $${(5 + llmCost).toFixed(2)}/mo\n`);

const over = Object.entries(month).filter(([k, v]) => PAID[k] && v > PAID[k]);
if (over.length || churn.length || steady.put !== 0) {
  if (steady.put !== 0) console.log(`  ❌ a steady-state poll is writing to KV. That is the invariant that keeps this cheap.`);
  for (const [k, v] of over) console.log(`  ❌ ${k}: ${fmt(v)}/mo exceeds the ${fmt(PAID[k])} included`);
  process.exit(1);
}
console.log(`  ✅ everything inside the included allowances, with room to grow.\n`);
