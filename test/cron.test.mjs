// Usage: node --test test/
//
// Exercises the real poll path -- real adapters.js, real classify.js. Only the
// network and KV are faked, by stubbing globalThis.fetch and backing KV with a
// Map. That means a bug in the Greenhouse response mapping fails these tests,
// which a stubbed fetchCompany() would happily hide.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkCompany, runAll } from "../src/index.js";
import { createEngine } from "../src/engine.js";
import { classify as sweClassify, track as sweTrack } from "../src/classify.js";
import { RETRY } from "../src/adapters.js";

RETRY.delays = [0, 0];   // keep the retry path, drop the real-time waits

const COMPANIES = [{ name: "TestCo", adapter: "greenhouse", slug: "testco" }];

// --- fakes -----------------------------------------------------------------

// Counts ops, because the write budget IS the constraint -- a test that only
// checks behaviour would miss us burning a write on every no-op poll.
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

let board;      // what the fake Greenhouse board currently returns
let boardFail;  // set to an HTTP status to make the board break
let failTimes;  // with boardFail: fail only this many requests, then recover
let boardHits;  // list requests made against the board
let sent;       // Telegram messages we captured
let env;
let llmCalls;   // must stay 0: the classifier is pure regex now
let descFetches; // must stay 0: descriptions are never read

const job = (id, title, location = "Austin, TX") => ({
  id, title, location: { name: location }, absolute_url: `https://x.test/${id}`,
});

beforeEach(() => {
  board = [];
  boardFail = 0;
  failTimes = Infinity;
  boardHits = 0;
  sent = [];
  llmCalls = 0;
  descFetches = 0;
  env = { JOBS: makeKV(), TG_TOKEN: "t", TG_CHAT_ID: "c" };

  globalThis.fetch = async (url, init) => {
    const u = String(url);

    if (u.includes("api.telegram.org")) {
      sent.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    // Both of these are dead paths now -- the classifier decides on the title
    // alone. They stay wired up, and COUNTED, so a regression that reintroduces
    // a per-job request or an LLM call is visible instead of silent.
    if (u.includes("api.anthropic.com")) {
      llmCalls++;
      return Response.json({ content: [{ text: "YES" }] });
    }
    if (u.includes("boards-api.greenhouse.io")) {
      if (!/\/jobs\/\w+$/.test(u)) boardHits++;
      if (boardFail && boardHits <= failTimes) return new Response("nope", { status: boardFail });
      // The real Greenhouse DETAIL endpoint: /boards/{slug}/jobs/{id} -- where a
      // description would live, and a separate request from the list.
      if (/\/jobs\/\w+$/.test(u)) {
        descFetches++;
        return Response.json({ content: "" });
      }
      return Response.json({ jobs: board });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
});

// Every message is sent silently now -- a notification, but no sound. So "loud"
// and "quiet" no longer describe delivery; they describe the classifier verdict.
// Telegram has no third tier, so 🔴 and 🟡 differ only by emoji + track tag.
const loud = () => sent.filter((m) => m.text.startsWith("🔴"));
const quiet = () => sent.filter((m) => m.text.startsWith("🟡"));
const withSound = () => sent.filter((m) => !m.disable_notification);

// --- seeding ---------------------------------------------------------------

test("first poll seeds silently -- records existing jobs, sends nothing", async () => {
  board = [job(1, "Software Engineer I"), job(2, "Senior Staff Engineer")];

  const [r] = await runAll(env, COMPANIES);

  assert.equal(r.seeded, true);
  assert.equal(sent.length, 0, "seeding must not alert -- day one would be a flood of 400 old jobs");
  assert.deepEqual(await env.JOBS.get("seen:TestCo", "json"), ["1", "2"]);
});

// --- the title allowlist is the WHOLE decision -------------------------------
// Every verdict comes from the title. Nothing fetches a description, nothing
// calls an LLM. Internships of any 2027 term alert, tagged as such.

const seedThen = async (next) => {
  board = [job(1, "Placeholder")];
  await runAll(env, COMPANIES);
  sent = [];
  board = [job(1, "Placeholder"), ...next];
  await runAll(env, COMPANIES);
};

test("the poll NEVER reads a description and NEVER calls an LLM", async () => {
  // One of each interesting shape: a match, a bare title, an internship, a
  // senior req. Under the old classifier the internship alone would have cost a
  // detail fetch plus a Haiku call.
  await seedThen([
    job(2, "Software Engineer I"),
    job(3, "Software Engineer"),
    job(4, "Software Engineer Intern"),
    job(5, "Senior Staff Engineer"),
  ]);

  assert.equal(descFetches, 0, "the title decides -- there is nothing to look up");
  assert.equal(llmCalls, 0, "and nothing to ask: ANTHROPIC_KEY is no longer used at all");
  assert.equal(loud().length, 2, "the Engineer I match and the internship alert");
});

test("a bare full-time title is dropped on the title alone", async () => {
  await seedThen([job(2, "Software Engineer")]);

  assert.equal(sent.length, 0, "this is the mid-level flood the user was drowning in");
  assert.equal(descFetches, 0, "no entry-level signal in the title -> nothing to look up");
});

test("an internship alerts whatever its 2027 term, tagged as an internship", async () => {
  await seedThen([
    job(2, "Software Engineer Intern - Fall 2026"),
    job(3, "Software Engineering Co-op - Spring 2027"),
    job(4, "Software Engineer Intern"),               // seasonless: no LLM, no description
    job(5, "Summer 2027 Software Engineer Intern"),
    job(6, "Summer 2026 Software Engineer Intern"),   // over -- dropped
    job(7, "2027 Mechanical Engineer Intern"),        // not software -- dropped
  ]);

  assert.equal(loud().length, 4);
  assert.ok(loud().every((m) => m.text.includes("internship")), "the alert names the track");
  assert.equal(descFetches, 0);
  assert.equal(llmCalls, 0);
});

test("an EXPLICIT new-grad title alerts without any extra request", async () => {
  await seedThen([job(2, "Software Engineer I")]);

  assert.equal(loud().length, 1, "the title settled it");
  assert.equal(descFetches, 0, "and we must not pay for a request we don't need");
});

test("a senior title is dropped on the title alone", async () => {
  await seedThen([job(2, "Senior Staff Engineer")]);

  assert.equal(sent.length, 0);
  assert.equal(descFetches, 0, "screen() said no; there is nothing a description could add");
});

test("the poll list contains ONLY listed companies -- no firehose, no aggregator", async () => {
  // The two SimplifyJobs coverage nets were removed on request. This asserts the
  // shipped config can't quietly grow one back: every entry must be a real
  // company from the registry, with a real adapter.
  const { COMPANIES: SHIPPED } = await import("../src/config.js");
  const { ADAPTERS } = await import("../src/adapters.js");

  assert.ok(SHIPPED.length > 0, "the registry should not be empty");
  for (const c of SHIPPED) {
    assert.ok(ADAPTERS[c.adapter], `${c.name}: unknown adapter ${c.adapter}`);
    assert.ok(!/firehose/i.test(c.name), `${c.name} is a firehose, not a company`);
    assert.ok(c.adapter !== "aggregator" && c.adapter !== "internships",
      `${c.name}: coverage nets were removed -- only companies.txt is polled`);
  }
});

// --- alerting on genuinely new IDs -----------------------------------------

test("second poll alerts only on genuinely new IDs", async () => {
  board = [job(1, "Software Engineer I")];
  await runAll(env, COMPANIES);          // seed
  assert.equal(sent.length, 0);

  board = [job(1, "Software Engineer I"), job(2, "Software Engineer I")];
  await runAll(env, COMPANIES);          // job 2 is new

  assert.equal(sent.length, 1, "only the new ID alerts; the already-seen one must not re-fire");
  assert.match(loud()[0].text, /Software Engineer I/);
});

test("a high-confidence in-region match is LOUD and carries title, location and link", async () => {
  board = [job(1, "Placeholder")];
  await runAll(env, COMPANIES);
  board = [job(1, "Placeholder"), job(2, "Software Engineer I", "Austin, TX")];

  await runAll(env, COMPANIES);

  assert.equal(loud().length, 1);
  assert.equal(quiet().length, 0);

  const t = loud()[0].text;
  assert.match(t, /TestCo/);
  assert.match(t, /new grad/, "the track tag");
  assert.match(t, /Software Engineer I/);
  assert.match(t, /Austin, TX/);
  assert.match(t, /href="https:\/\/x\.test\/2"/, "the apply link is the whole point");
  assert.doesNotMatch(t, /you know/, "contacts were removed from alerts on request");
});

test("the SOFTWARE Worker makes no sound -- every message is disable_notification", async () => {
  // runAll/checkCompany here are the software binding (silent by preference). The
  // mechanical Worker is loud -- see the next test. Silence is now per-profile.
  board = [job(1, "Placeholder")];
  await runAll(env, COMPANIES);

  board = [
    job(1, "Placeholder"),
    job(2, "Software Engineer I", "Austin, TX"),        // 🔴 high confidence
    job(3, "New Grad Software Engineer", "Seattle, WA"),
  ];
  await runAll(env, COMPANIES);

  boardFail = 404;                                       // ⚠️ broken-adapter warning
  for (let i = 0; i < 6; i++) await checkCompany(env, COMPANIES[0]);

  assert.ok(sent.length >= 3, "should have sent alerts and the breakage warning");
  assert.equal(withSound().length, 0, "Ryan asked for notifications with no sound -- every path, warnings included");
});

test("a Worker with silent:false sends LOUD alerts (Josh's mechanical tracker)", async () => {
  const loud = createEngine({ COMPANIES, classify: sweClassify, track: sweTrack, silent: false });
  board = [job(1, "Placeholder")];
  await loud.runAll(env, COMPANIES);                     // seed
  board = [job(1, "Placeholder"), job(2, "Software Engineer I", "Austin, TX")];
  await loud.runAll(env, COMPANIES);

  assert.equal(sent.length, 1, "the one new match alerts");
  assert.equal(sent[0].disable_notification, false, "Josh's alerts must make a sound");
});

test("a job with NO title fails OPEN to the quiet channel", async () => {
  // The last thing 🟡 means. An empty title is a broken adapter mapping, not a
  // boring role -- dropping it silently is exactly the failure mode invariant 3
  // exists to prevent.
  await seedThen([job(2, "")]);

  assert.equal(loud().length, 0);
  assert.equal(quiet().length, 1, "a false positive costs 2s of scrolling; a false negative costs a job");
});

test("a confidently non-US role is dropped before it alerts", async () => {
  board = [job(1, "Placeholder")];
  await runAll(env, COMPANIES);

  board = [
    job(1, "Placeholder"),
    job(2, "Software Engineer I", "Warsaw, Poland"),   // real match, wrong country
    job(3, "Software Engineer I", "Bengaluru, India"),
  ];
  await runAll(env, COMPANIES);

  assert.equal(sent.length, 0, "US-only: a Warsaw or Bengaluru SWE role must not alert");
});

test("a US role still alerts with the gate on", async () => {
  board = [job(1, "Placeholder")];
  await runAll(env, COMPANIES);
  board = [job(1, "Placeholder"), job(2, "Software Engineer I", "Austin, TX")];
  await runAll(env, COMPANIES);
  assert.equal(sent.length, 1);
});

test("obvious non-matches are dropped without alerting", async () => {
  board = [job(1, "Placeholder")];
  await runAll(env, COMPANIES);

  board = [job(1, "Placeholder"), job(2, "Senior Staff Engineer"), job(3, "Account Executive")];
  await runAll(env, COMPANIES);

  assert.equal(sent.length, 0);
});

// --- the KV write budget ---------------------------------------------------

test("a no-op poll performs ZERO writes", async () => {
  board = [job(1, "Software Engineer I")];
  await runAll(env, COMPANIES);       // seed (this one does write)

  env.JOBS.ops.put = 0;
  env.JOBS.ops.delete = 0;
  await runAll(env, COMPANIES);       // nothing changed

  assert.equal(env.JOBS.ops.put, 0, "writes are the scarce resource -- an idle poll must not spend one");
  assert.equal(env.JOBS.ops.delete, 0);
});

test("seen: is a cumulative union -- a job falling off a sliding window does not re-alert", async () => {
  board = [job(1, "Software Engineer I"), job(2, "Software Engineer I")];
  await runAll(env, COMPANIES);

  // Amazon (sort=recent) and Workday (hard limit 20) both drop old jobs off the
  // bottom. Job 1 vanishes from the page, then comes back.
  board = [job(2, "Software Engineer I")];
  await runAll(env, COMPANIES);
  board = [job(1, "Software Engineer I"), job(2, "Software Engineer I")];
  await runAll(env, COMPANIES);

  assert.equal(sent.length, 0, "a resurfacing job must not re-alert -- that would also burn a write");
  assert.deepEqual(await env.JOBS.get("seen:TestCo", "json"), ["1", "2"]);
});

// --- adapter breakage ------------------------------------------------------

test("the broken-adapter warning fires on the 6th consecutive failure, not before", async () => {
  boardFail = 404;

  for (let i = 1; i <= 5; i++) {
    await checkCompany(env, COMPANIES[0]);
    assert.equal(sent.length, 0, `must stay quiet at failure ${i} -- endpoints blip`);
    assert.equal(await env.JOBS.get("fail:TestCo"), String(i));
  }

  await checkCompany(env, COMPANIES[0]);   // 6th
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /adapter broken \(6x\)/);
});

test("a transient 429/5xx is retried within the poll and never counts as a failure", async () => {
  board = [{ id: 1, title: "Software Engineer I", location: { name: "Austin, TX" }, absolute_url: "https://x.test/1" }];
  boardFail = 503;
  failTimes = 2;                       // Snap's 504s, Salesforce's 429s: they clear

  const r = await checkCompany(env, COMPANIES[0]);
  assert.equal(r.error, undefined);
  assert.equal(boardHits, 3);
  assert.equal(await env.JOBS.get("fail:TestCo"), null);
});

test("a 404 is drift, not a blip -- no retry", async () => {
  boardFail = 404;
  await checkCompany(env, COMPANIES[0]);
  assert.equal(boardHits, 1);
  assert.equal(await env.JOBS.get("fail:TestCo"), "1");
});

test("a broken adapter stops burning writes once it has alerted", async () => {
  boardFail = 404;
  for (let i = 0; i < 6; i++) await checkCompany(env, COMPANIES[0]);

  env.JOBS.ops.put = 0;
  for (let i = 0; i < 10; i++) await checkCompany(env, COMPANIES[0]);

  assert.equal(sent.length, 1, "it must not re-alert -- that is how you get muted");
  assert.equal(env.JOBS.ops.put, 0, "otherwise one dead adapter costs 288 writes/day, forever");
});

test("a ZERO-jobs response counts as a failure, not an empty result", async () => {
  board = [];   // HTTP 200, empty list -- the silent-breakage case

  await checkCompany(env, COMPANIES[0]);

  assert.equal(await env.JOBS.get("fail:TestCo"), "1",
    "otherwise you assume nobody has posted while the endpoint 404s for three weeks");
});

test("recovery clears the failure counter", async () => {
  boardFail = 404;
  await checkCompany(env, COMPANIES[0]);
  assert.equal(await env.JOBS.get("fail:TestCo"), "1");

  boardFail = 0;
  board = [job(1, "Software Engineer I")];
  await checkCompany(env, COMPANIES[0]);

  assert.equal(await env.JOBS.get("fail:TestCo"), null);
});

test("one company breaking does not stop the others being polled", async () => {
  const two = [
    { name: "TestCo", adapter: "greenhouse", slug: "testco" },
    { name: "Other", adapter: "greenhouse", slug: "other" },
  ];
  boardFail = 500;

  const results = await runAll(env, two);

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.error), "both should report an error, neither should throw");
});

test("an everyMin:15 board is polled only on every third 5-min tick; others every tick", async () => {
  const two = [
    { name: "TestCo", adapter: "greenhouse", slug: "testco" },
    { name: "Slow", adapter: "greenhouse", slug: "slow", everyMin: 15 },
  ];
  board = [job(1, "Software Engineer, New Grad 2027")];
  const tick = (min) => Date.UTC(2026, 10, 18, 12, min);
  const polled = async (min) => (await runAll(env, two, tick(min))).map((r) => r.company);

  assert.deepEqual(await polled(0), ["TestCo", "Slow"]);
  assert.deepEqual(await polled(5), ["TestCo"]);
  assert.deepEqual(await polled(10), ["TestCo"]);
  assert.deepEqual(await polled(15), ["TestCo", "Slow"]);
  // No tick time (manual /run) polls everything.
  assert.deepEqual((await runAll(env, two)).map((r) => r.company), ["TestCo", "Slow"]);
});

test("LinkedIn: a 429 on a later page keeps page-1 results instead of failing the poll", async () => {
  const realFetch = globalThis.fetch;
  const card = (id, t) =>
    `<li><div data-entity-urn="urn:li:jobPosting:${id}"><h3 class="base-search-card__title">${t}</h3>` +
    `<span class="job-search-card__location">Sunnyvale, CA</span></div></li>`;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes("linkedin.com")) return realFetch(url, init);
    if (new URL(u).searchParams.get("start") !== "0") return new Response("slow down", { status: 429 });
    return new Response(Array.from({ length: 10 }, (_, i) => card(100 + i, "Software Engineer")).join(""));
  };
  const li = [{ name: "LinkedIn", adapter: "linkedin", companyIds: "1337", pages: 3 }];
  const [r] = await runAll(env, li);
  assert.equal(r.error, undefined);
  assert.equal(r.total, 10);
  globalThis.fetch = realFetch;
});
