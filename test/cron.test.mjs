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
let verdict;    // what the fake Anthropic API replies
let llmFail;    // set true to make the classifier API 500
let sent;       // Telegram messages we captured
let env;
let descs;      // jobId -> description HTML, served by the fake detail endpoint
let descFail;   // set true to make the description fetch 500
let descFetches; // how many times we went and read a description

const job = (id, title, location = "Austin, TX") => ({
  id, title, location: { name: location }, absolute_url: `https://x.test/${id}`,
});

beforeEach(() => {
  board = [];
  boardFail = 0;
  verdict = "YES";
  llmFail = false;
  sent = [];
  descs = {};
  descFail = false;
  descFetches = 0;
  env = { JOBS: makeKV(), TG_TOKEN: "t", TG_CHAT_ID: "c", ANTHROPIC_KEY: "k" };

  globalThis.fetch = async (url, init) => {
    const u = String(url);

    if (u.includes("api.telegram.org")) {
      sent.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    if (u.includes("api.anthropic.com")) {
      if (llmFail) return new Response("boom", { status: 500 });
      return Response.json({ content: [{ text: verdict }] });
    }
    if (u.includes("boards-api.greenhouse.io")) {
      if (boardFail) return new Response("nope", { status: boardFail });
      // The real Greenhouse DETAIL endpoint: /boards/{slug}/jobs/{id}. This is
      // where the description lives, and it is a separate request from the list.
      const m = u.match(/\/jobs\/(\w+)$/);
      if (m) {
        descFetches++;
        if (descFail) return new Response("nope", { status: 500 });
        return Response.json({ content: descs[m[1]] || "" });
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

test("seeding does not call the classifier", async () => {
  let llmCalls = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    if (String(u).includes("anthropic")) llmCalls++;
    return inner(u, i);
  };
  // A seasonless "Software Engineer Intern" is ambiguous, so it WOULD hit the LLM
  // if we classified during seeding. (A bare full-time title no longer would --
  // it is dropped on the title.)
  board = [job(1, "Software Engineer Intern"), job(2, "Software Engineer Intern")];

  await runAll(env, COMPANIES);

  assert.equal(llmCalls, 0, "seeding 43 boards would otherwise be thousands of pointless LLM calls");
});

// --- the title allowlist + the experience gate ------------------------------
// A full-time title with no entry-level signal is dropped on the TITLE -- no
// description, no LLM. The only titles that still reach a description read are
// seasonless internships, where the gate catches an "intern" posting that is
// really a senior req.

const seedThen = async (next) => {
  board = [job(1, "Placeholder")];
  await runAll(env, COMPANIES);
  sent = [];
  board = [job(1, "Placeholder"), ...next];
  await runAll(env, COMPANIES);
};

test("a bare full-time title is dropped on the title alone -- no description, no LLM", async () => {
  let llmCalls = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (String(u).includes("anthropic")) llmCalls++; return inner(u, i); };
  descs["2"] = "5+ years of professional experience";   // never even read

  await seedThen([job(2, "Software Engineer")]);

  assert.equal(sent.length, 0, "this is the mid-level flood the user was drowning in");
  assert.equal(descFetches, 0, "no entry-level signal in the title -> nothing to look up");
  assert.equal(llmCalls, 0, "and no LLM call either");
});

test("a seasonless internship wanting 5+ years is DROPPED after reading the description", async () => {
  verdict = "UNSURE";
  descs["2"] = "<p>Requirements</p><ul><li>5+ years of professional software engineering experience, not including internships</li></ul>";

  await seedThen([job(2, "Software Engineer Intern")]);

  assert.equal(sent.length, 0, "an 'intern' title asking for 5 years is a mislabeled senior req");
  assert.equal(descFetches, 1, "and it cost exactly one extra request");
});

test("a seasonless internship with an entry-level description still alerts", async () => {
  verdict = "UNSURE";
  descs["2"] = "<p>Requirements</p><ul><li>1+ year of experience</li><li>BS in Computer Science</li></ul>";

  await seedThen([job(2, "Software Engineer Intern")]);

  assert.equal(quiet().length, 1, "1 year is not a barrier -- keep escalating the uncertain ones");
});

test("an EXPLICIT new-grad title never reads a description at all", async () => {
  descs["2"] = "5+ years of experience required";   // boilerplate that would fail the gate

  await seedThen([job(2, "Software Engineer I")]);

  assert.equal(loud().length, 1, "the title already settled it -- a stray years line must not kill it");
  assert.equal(descFetches, 0, "and we must not pay for a request we don't need");
});

test("a senior title is dropped on the title alone -- no description fetched", async () => {
  await seedThen([job(2, "Senior Staff Engineer")]);

  assert.equal(sent.length, 0);
  assert.equal(descFetches, 0, "screen() said no; there is nothing a description could add");
});

test("a new-grad phrase in the description OVERRIDES a years requirement", async () => {
  verdict = "UNSURE";
  // A seasonless internship whose description reads as new-grad but still lists
  // years under "preferred". Dropping it would cost a real role.
  descs["2"] = "New Grad friendly. Preferred: 3+ years of experience with distributed systems.";

  await seedThen([job(2, "Software Engineer Intern")]);

  assert.equal(quiet().length, 1, "a false negative costs a job -- recall wins ties (invariant 3)");
});

test("the gate FAILS OPEN: if the description can't be fetched, the job still alerts", async () => {
  verdict = "UNSURE";
  descFail = true;

  await seedThen([job(2, "Software Engineer Intern")]);

  assert.equal(quiet().length, 1, "a 500 on the description must never silently eat a posting");
});

test("the years gate beats a cached verdict", async () => {
  verdict = "UNSURE";
  await env.JOBS.put("verdict:testco|software engineer intern", "maybe");   // cached from before
  descs["2"] = "We need 7+ years of industry experience.";

  await seedThen([job(2, "Software Engineer Intern")]);

  assert.equal(sent.length, 0, "the cache must not be able to resurrect a 7-years role");
});

test("a bare title from the AGGREGATOR is kept -- the feed is new-grad-curated", async () => {
  // Same title, two sources. On the company's own board it is mid-level noise; on
  // the SimplifyJobs new-grad feed it is a real role the feed didn't restate.
  const AGG = [{ name: "New-grad firehose", adapter: "aggregator" }];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    if (u.includes("githubusercontent.com")) return Response.json(board);
    throw new Error("unexpected fetch: " + u);
  };
  // the aggregator adapter builds the title from company_name + title, and the
  // location from a `locations` array -- match that shape, not the normalized one.
  const aggJob = (id, company) => ({
    id, company_name: company, title: "Software Engineer",
    locations: ["Austin, TX"], url: "https://x/" + id, active: true,
  });

  board = [aggJob("a1", "Acme")];
  await runAll(env, AGG);            // seed
  sent = [];
  board = [aggJob("a1", "Acme"), aggJob("a2", "Beta")];
  await runAll(env, AGG);

  assert.equal(sent.length, 1, "the aggregator's bare title is trusted and alerts");
  assert.equal(quiet().length, 1, "on the quiet channel -- the title itself never confirmed it");
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
  assert.match(t, /new grad/, "the track tag: an internship and a full-time role read very differently");
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
    job(3, "Software Engineer Intern - Fall 2026"),     // 🔴 internship track
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

test("an uncertain match still arrives, never dropped", async () => {
  board = [job(1, "Placeholder")];
  await runAll(env, COMPANIES);

  verdict = "UNSURE";
  // A seasonless internship is the ambiguous case that still asks the LLM.
  board = [job(1, "Placeholder"), job(2, "Software Engineer Intern")];
  await runAll(env, COMPANIES);

  assert.equal(loud().length, 0);
  assert.equal(quiet().length, 1, "alert fatigue is a miss: uncertain goes to the quiet channel");
});

test("the classifier FAILS OPEN -- an API error becomes 'maybe', never a silent drop", async () => {
  board = [job(1, "Placeholder")];
  await runAll(env, COMPANIES);

  llmFail = true;
  board = [job(1, "Placeholder"), job(2, "Software Engineer Intern")];
  await runAll(env, COMPANIES);

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
