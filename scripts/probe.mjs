#!/usr/bin/env node
// Usage: node scripts/probe.mjs [name-substring ...]
//        PROFILE=mech node scripts/probe.mjs   (probe the mechanical list)
// Runs every adapter in COMPANIES against its live endpoint and reports what
// came back. This is the only way to know a tier-2 adapter hasn't drifted --
// the worker itself can't tell "no new jobs" from "endpoint is 404ing".

const PROFILE = process.env.PROFILE || "";
const { COMPANIES } = await import(`../src/config${PROFILE ? `.${PROFILE}` : ""}.js`);
import { fetchCompany } from "../src/adapters.js";

const CONCURRENCY = 5;

// A job is only usable if index.js can diff it and Telegram can link it.
function shapeErrors(jobs) {
  const bad = [];
  for (const [i, x] of jobs.entries()) {
    const p = [];
    if (!x.id || typeof x.id !== "string" || x.id === "undefined") p.push("id");
    if (!x.title || typeof x.title !== "string") p.push("title");
    if (typeof x.location !== "string") p.push("location");
    if (!x.url || !/^https?:\/\//.test(x.url)) p.push("url");
    if (p.length) bad.push({ i, fields: p, sample: x });
  }
  return bad;
}

async function probe(c) {
  const t0 = Date.now();
  try {
    const jobs = await fetchCompany(c);
    const ms = Date.now() - t0;
    if (!Array.isArray(jobs)) return { c, ms, status: "BAD_SHAPE", err: "adapter did not return an array" };
    if (!jobs.length) return { c, ms, status: "ZERO", err: "returned 0 jobs (index.js counts this as a FAILURE)" };

    const bad = shapeErrors(jobs);
    const ids = new Set(jobs.map((x) => x.id));
    return {
      c, ms, jobs, bad,
      dupeIds: jobs.length - ids.size,
      status: bad.length ? "BAD_SHAPE" : "OK",
    };
  } catch (e) {
    return { c, ms: Date.now() - t0, status: "ERROR", err: String(e.message || e) };
  }
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) out[i] = await fn(items[i++]);
    }),
  );
  return out;
}

const filters = process.argv.slice(2).map((s) => s.toLowerCase());
const targets = filters.length
  ? COMPANIES.filter((c) => filters.some((f) => c.name.toLowerCase().includes(f)))
  : COMPANIES;

const results = await pool(targets, CONCURRENCY, probe);

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`${pad("company", 20)}${pad("adapter", 17)}${pad("jobs", 6)}${pad("ms", 7)}first title`);
console.log("-".repeat(100));
for (const r of results) {
  const n = r.jobs ? r.jobs.length : 0;
  const first = r.status === "ERROR" || r.status === "ZERO" ? `❌ ${r.err}` : r.jobs[0].title;
  const mark = r.status === "OK" ? "" : r.status === "BAD_SHAPE" ? "⚠️  " : "";
  console.log(`${pad(r.c.name, 20)}${pad(r.c.adapter, 17)}${pad(n, 6)}${pad(r.ms, 7)}${mark}${first}`);
}

for (const r of results.filter((r) => r.bad?.length)) {
  console.log(`\n⚠️  ${r.c.name}: ${r.bad.length}/${r.jobs.length} jobs have a malformed field`);
  for (const b of r.bad.slice(0, 2)) {
    console.log(`   missing/invalid: ${b.fields.join(", ")}`);
    console.log(`   ${JSON.stringify(b.sample).slice(0, 200)}`);
  }
}
for (const r of results.filter((r) => r.dupeIds > 0)) {
  console.log(`\n⚠️  ${r.c.name}: ${r.dupeIds} duplicate IDs — will churn the KV write budget`);
}

const by = (s) => results.filter((r) => r.status === s).map((r) => r.c.name);
console.log(
  `\nok ${by("OK").length}/${results.length}` +
    (by("BAD_SHAPE").length ? `  |  bad shape: ${by("BAD_SHAPE").join(", ")}` : "") +
    (by("ZERO").length ? `  |  zero jobs: ${by("ZERO").join(", ")}` : "") +
    (by("ERROR").length ? `  |  errored: ${by("ERROR").join(", ")}` : ""),
);
process.exit(by("OK").length === results.length ? 0 : 1);
