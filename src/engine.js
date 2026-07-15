// The field-agnostic poll engine. It knows how to hit boards, diff against KV,
// route alerts, count failures, and serve the tracker -- but nothing about what
// counts as a matching job. That lives in a PROFILE:
//
//   createEngine({ COMPANIES, classify, track, testTitle })
//
// so the same engine drives both the software Worker (src/index.js) and the
// mechanical one (src/index.mech.js). The two never share KV or Telegram; each
// Worker binds its own profile and its own bindings. Nothing here is
// SWE-specific -- if you find yourself special-casing a field, it belongs in the
// classifier, not here.
//
// All the load-bearing invariants (KV write budget, seed-silently, failure
// counter, one-digest-write-per-tick, everything-silent) live in this file and
// are covered by test/cron.test.mjs through the SWE binding.

import { fetchCompany } from "./adapters.js";
import { inUS } from "./classify.js";                 // field-agnostic US gate
import { renderDashboard, logApplied, handleApi } from "./dashboard.js";

// No sharding. Sharding existed because the free tier gave us 10ms of CPU per
// invocation, so we could only parse ~3 boards per tick. On the Workers Paid
// plan that ceiling is 30s, so we poll EVERY company on EVERY tick. Sharding
// would now just add latency for nothing -- and latency is the entire product.
// The bound is politeness to the ATS endpoints, not CPU.
const POLL_CONCURRENCY = 6;

const BREAK_ALERT_AFTER = 6;   // ~30 min of consecutive failures at a 5-min cadence
const DIGEST_CRON = "0 13 * * *";  // 8am Central

// Telegram has exactly two tiers: sound, or silent-with-notification (still shows
// a notification, just no sound). Which one a Worker uses is a PER-PROFILE choice
// (profile.silent) -- Ryan's software Worker is silent by preference; Josh's is
// loud. The daily digest is always silent regardless (it's a backstop, not news).
const QUIET = { silent: true };

export function createEngine(profile) {
  const { COMPANIES, classify, track } = profile;
  const testTitle = profile.testTitle || "Software Engineer I, New Grad 2027";
  // Real-time alerts (job matches + the broken-adapter warning) follow the
  // profile; default to silent so an unset profile stays quiet.
  const ALERT = { silent: profile.silent !== false };

  async function tg(env, text, { silent = false } = {}) {
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID, text, parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: silent,   // <- the whole triage mechanism
      }),
    });
  }

  // One-tap "I applied" link back into the tracker. Carries the job inline (no KV
  // write at alert time) so tapping it files this exact role. Needs BASE_URL; if
  // unset (e.g. in tests) we just omit the link rather than emit a broken one.
  // Note: this URL contains ADMIN_KEY. Fine in a private Telegram chat -- just
  // don't forward an alert to anyone.
  function logLink(env, co, j) {
    if (!env.BASE_URL) return "";
    const p = encodeURIComponent(JSON.stringify({ c: co, t: j.title, u: j.url, k: track(j.title), l: j.location || "" }));
    return `\n<a href="${env.BASE_URL}/applied?key=${env.ADMIN_KEY}&j=${p}">✅ Log as applied</a>`;
  }

  // High confidence: a real match for the profile's track(s).
  const alertHigh = (env, co, j) =>
    tg(env, `🔴 <b>${co}</b> · ${track(j.title)}\n${j.title}\n${j.location || "location unknown"}` +
            `\n\n<a href="${j.url}">Apply</a>${logLink(env, co, j)}`, ALERT);

  // Uncertain. Still delivered -- nothing is ever silently dropped.
  const alertMaybe = (env, co, j) =>
    tg(env, `🟡 <b>${co}</b> · ${track(j.title)} (unsure)\n${j.title}\n${j.location || "?"}` +
            `\n<a href="${j.url}">Link</a>${logLink(env, co, j)}`, ALERT);

  async function checkCompany(env, c) {
    const seenKey = `seen:${c.name}`;
    const failKey = `fail:${c.name}`;

    // KV writes/deletes are the scarce resource (1M/mo on paid, and they were
    // 1k/DAY on free). Reads are effectively free. So: always read, and only ever
    // write when something actually changed.
    const failCount = Number((await env.JOBS.get(failKey)) || 0);

    let jobs;
    try {
      jobs = await fetchCompany(c);
      // A zero-jobs response is a FAILURE, not an empty result. Silent adapter
      // breakage is the worst outcome: you'd assume nobody has posted while the
      // endpoint has been 404ing for three weeks.
      if (!jobs.length) throw new Error("adapter returned 0 jobs");
      if (failCount) await env.JOBS.delete(failKey);   // only if one exists
    } catch (e) {
      const n = failCount + 1;
      // Stop writing once we've alerted. A broken adapter otherwise burns one
      // write per poll, forever -- 288/day each. We only need the counter to
      // reach the threshold; past that the key just has to still exist.
      if (n <= BREAK_ALERT_AFTER) await env.JOBS.put(failKey, String(n));
      if (n === BREAK_ALERT_AFTER) {
        await tg(env, `⚠️ <b>${c.name}</b> adapter broken (${n}x)\n<code>${String(e).slice(0, 180)}</code>\nRe-capture: see capture.md`, ALERT);
      }
      return { company: c.name, error: String(e) };
    }

    const prev = await env.JOBS.get(seenKey, "json");
    const isSeed = prev === null;
    const seen = new Set(prev || []);
    const unseen = jobs.filter((x) => !seen.has(x.id));

    const log = [];
    for (const x of unseen) {
      // On the first poll we're recording what already exists, not discovering it.
      // Skip the classifier entirely -- seeding every board would otherwise mean
      // thousands of pointless LLM calls (and KV writes) on the very first tick.
      if (isSeed) continue;

      // US-only GATE. Drop confidently-non-US roles (Warsaw, Bengaluru, London...)
      // before classifying, so we don't even spend an LLM call on them. Fails open:
      // unknown / remote / bare US city all pass. Checked FIRST because it's free.
      if (!inUS(x.location)) continue;

      // Pass the company CONFIG, not just the name: the classifier may read the
      // posting's description for a title it can't judge on its own.
      const v = await classify(env, c, x);
      if (v === "no") continue;

      if (v === "high") await alertHigh(env, c.name, x);
      else await alertMaybe(env, c.name, x);

      log.push({ co: c.name, title: x.title, url: x.url, v });
    }

    // Cumulative, NOT overwrite. Adapters with a sliding window (Amazon's
    // sort=recent&limit=100, Workday's hard limit of 20) drop old IDs off the
    // bottom; if we stored only the current page, a job resurfacing would
    // re-alert AND burn a write. Union and cap instead. Only write when the set
    // actually grew.
    if (isSeed || unseen.length) {
      const merged = [...seen, ...jobs.map((x) => x.id)];
      const capped = [...new Set(merged)].slice(-3000);
      await env.JOBS.put(seenKey, JSON.stringify(capped));
    }

    return { company: c.name, total: jobs.length, unseen: unseen.length, seeded: isSeed, log };
  }

  // Bounded concurrency. Sequential would take ~30s of wall clock across the
  // boards; unbounded would open every socket at once and invite a rate-limit.
  async function pool(items, n, fn) {
    const out = [];
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) {
          const idx = i++;
          out[idx] = await fn(items[idx]);
        }
      }),
    );
    return out;
  }

  async function runAll(env, companies = COMPANIES) {
    const results = await pool(companies, POLL_CONCURRENCY, (c) => checkCompany(env, c));

    // Feed the daily digest: every non-"no" title seen this tick, so a bad
    // classifier verdict surfaces within a day instead of never. ONE write per
    // tick, not one per company -- separate puts would be pure write budget.
    const fresh = results.flatMap((r) => r.log || []);
    if (fresh.length) {
      const d = (await env.JOBS.get("digest", "json")) || [];
      await env.JOBS.put("digest", JSON.stringify([...d, ...fresh].slice(-200)));
    }

    return results;
  }

  // Backstop: everything the fast path saw in 24h, in one message. If the
  // classifier wrongly downgraded something, you catch it here within a day.
  async function digest(env, companies = COMPANIES) {
    const d = (await env.JOBS.get("digest", "json")) || [];
    const broken = [];
    for (const c of companies) {
      if (await env.JOBS.get(`fail:${c.name}`)) broken.push(c.name);
    }
    if (!d.length && !broken.length) return;

    const lines = d.map((x) => `${x.v === "high" ? "🔴" : "🟡"} <a href="${x.url}">${x.co} — ${x.title}</a>`);
    await tg(env,
      `📋 <b>Last 24h</b> (${d.length})\n\n${lines.join("\n") || "nothing new"}` +
      (broken.length ? `\n\n⚠️ broken adapters: ${broken.join(", ")}` : ""),
      QUIET);   // the digest is a daily backstop -- always silent, even for Josh
    await env.JOBS.put("digest", "[]");
  }

  const handler = {
    async scheduled(event, env, ctx) {
      if (event.cron === DIGEST_CRON) return ctx.waitUntil(digest(env));
      ctx.waitUntil(runAll(env));
    },

    async fetch(req, env) {
      const u = new URL(req.url);
      if (u.searchParams.get("key") !== env.ADMIN_KEY) return new Response("nope", { status: 401 });

      // --- application tracker (see dashboard.js) ---
      if (u.pathname === "/dashboard") return renderDashboard(env, env.ADMIN_KEY, profile.owner);
      if (u.pathname === "/applied") return logApplied(env, u);
      if (u.pathname.startsWith("/api/")) return handleApi(env, req, u);

      if (u.pathname === "/health") {
        const rows = [];
        for (const c of COMPANIES) {
          const f = await env.JOBS.get(`fail:${c.name}`);
          const seen = await env.JOBS.get(`seen:${c.name}`, "json");
          rows.push({ company: c.name, adapter: c.adapter, failing: Number(f || 0), tracking: seen?.length ?? null });
        }
        return Response.json(rows);
      }
      if (u.pathname === "/digest") { await digest(env); return new Response("sent"); }
      if (u.pathname === "/test") {
        await alertHigh(env, "Test Co", { title: testTitle, location: "Austin, TX", url: "https://example.com" });
        return new Response("sent");
      }
      return Response.json(await runAll(env));
    },
  };

  return { checkCompany, runAll, digest, handler };
}
