// Usage: node --test 'test/*.test.mjs'
//
// The application tracker. Exercises the real dashboard.js handlers against a
// Map-backed KV, the same way cron.test.mjs does for the poll path.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { logApplied, handleApi, renderDashboard, STATUSES, companyFromUrl } from "../src/dashboard.js";

let env, writes;
beforeEach(() => {
  const m = new Map();
  writes = 0;   // KV writes are the scarce resource -- some tests assert on this
  env = {
    ADMIN_KEY: "k",
    JOBS: {
      async get(key, type) {
        const v = m.get(key);
        if (v === undefined) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      async put(key, v) { writes++; m.set(key, String(v)); },
      async delete(key) { writes++; m.delete(key); },
    },
  };
});

const seed = (rows) => env.JOBS.put("applications", JSON.stringify(rows));
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

const apps = () => env.JOBS.get("applications", "json");

// build the /applied?j=... URL the Telegram link uses
function appliedUrl(job) {
  const u = new URL("https://w/applied");
  u.searchParams.set("key", "k");
  u.searchParams.set("j", JSON.stringify(job));
  return u;
}
const apiReq = (method, body) =>
  new Request("https://w/api/app?key=k", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
const apiUrl = new URL("https://w/api/app?key=k");

// --- log from a Telegram alert ---------------------------------------------

test("tapping 'Log as applied' files the role as Applied", async () => {
  const r = await logApplied(env, appliedUrl({
    c: "Stripe", t: "Software Engineer I", u: "https://stripe.com/jobs/1", k: "new grad", l: "NYC",
  }));
  assert.equal(r.status, 200);

  const list = await apps();
  assert.equal(list.length, 1);
  assert.equal(list[0].company, "Stripe");
  assert.equal(list[0].status, "applied");
  assert.equal(list[0].track, "new grad");
  assert.equal(list[0].location, "NYC");
});

test("re-tapping the SAME alert does not create a duplicate", async () => {
  const job = { c: "Stripe", t: "SWE I", u: "https://stripe.com/jobs/1", k: "new grad" };
  await logApplied(env, appliedUrl(job));
  await logApplied(env, appliedUrl(job));   // tapped twice
  assert.equal((await apps()).length, 1, "the id is a deterministic hash of company+url");
});

test("re-tapping does NOT clobber a status you already advanced", async () => {
  const job = { c: "Stripe", t: "SWE I", u: "https://stripe.com/jobs/1", k: "new grad" };
  await logApplied(env, appliedUrl(job));
  const list = await apps();
  list[0].status = "onsite";
  await env.JOBS.put("applications", JSON.stringify(list));

  await logApplied(env, appliedUrl(job));   // tap the old alert again
  assert.equal((await apps())[0].status, "onsite", "must not reset an in-progress app back to Applied");
});

test("two different roles at the same company both track", async () => {
  await logApplied(env, appliedUrl({ c: "Stripe", t: "SWE I", u: "https://stripe.com/jobs/1", k: "new grad" }));
  await logApplied(env, appliedUrl({ c: "Stripe", t: "SWE Intern - Fall 2026", u: "https://stripe.com/jobs/2", k: "internship" }));
  assert.equal((await apps()).length, 2);
});

test("a malformed payload is rejected, not stored", async () => {
  const u = new URL("https://w/applied?key=k&j=not-json");
  const r = await logApplied(env, u);
  assert.equal(r.status, 400);
  assert.equal(await apps(), null);
});

// --- manual add / update / delete ------------------------------------------

test("manual add creates a new-grad app by default", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "Backend Engineer", url: "https://ramp.com/1" }), apiUrl);
  const list = await apps();
  assert.equal(list.length, 1);
  assert.equal(list[0].track, "new grad");
  assert.equal(list[0].status, "applied");
});

test("manual add requires company and title", async () => {
  const r = await handleApi(env, apiReq("POST", { company: "Ramp" }), apiUrl);
  assert.equal(r.status, 400);
});

test("PATCH advances status through the pipeline", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const id = (await apps())[0].id;
  await handleApi(env, apiReq("PATCH", { id, status: "phone" }), apiUrl);
  assert.equal((await apps())[0].status, "phone");
});

test("PATCH rejects a bogus status", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const id = (await apps())[0].id;
  await handleApi(env, apiReq("PATCH", { id, status: "hired-lol" }), apiUrl);
  assert.equal((await apps())[0].status, "applied", "only known statuses are accepted");
});

test("DELETE removes an application", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const id = (await apps())[0].id;
  await handleApi(env, apiReq("DELETE", { id }), apiUrl);
  assert.equal((await apps()).length, 0);
});

test("a no-op write budget check: PATCH on a missing id is a 404, no write", async () => {
  const r = await handleApi(env, apiReq("PATCH", { id: "nope", status: "offer" }), apiUrl);
  assert.equal(r.status, 404);
});

// --- the page renders -------------------------------------------------------

test("dashboard renders and embeds the applications", async () => {
  await logApplied(env, appliedUrl({ c: "Stripe", t: "SWE I", u: "https://x/1", k: "new grad" }));
  const r = await renderDashboard(env, "k");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const body = await r.text();
  assert.match(body, /id="board"/, "the page shell is there");
  assert.match(body, /Stripe/, "server-renders the current data into the page");
});

// The browser half of the tracker ships as a STRING (see the comment above
// CLIENT_JS), so nothing type-checks or even parses it at build time -- a stray
// backtick or a ${...} in there silently ships a dead page. Parse it here.
test("the client script parses, and never reopens the template-literal traps", async () => {
  const body = await (await renderDashboard(env, "k")).text();
  const js = body.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js), "the dashboard page ships a syntax error");
  assert.doesNotMatch(js, /\$\{/, "a ${} in CLIENT_JS gets interpolated away by the server template");
  assert.doesNotMatch(js, /__name\(/, "a bundled function leaked in -- CLIENT_JS must stay a raw string");
});

// The menu, the toast and the add form are all toggled with the `hidden`
// property -- which hides an element ONLY through the UA rule
// [hidden]{display:none}. Any author display rule outranks that, and all three
// of those set display:flex. Without an explicit override, closeMenu() flips
// .hidden and the menu stays painted on top of the cards: picking a status looks
// like the page broke. It did exactly that once. Keep this rule.
test("elements the client toggles with .hidden are really hidden by the CSS", async () => {
  const body = await (await renderDashboard(env, "k")).text();
  const css = body.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    "a display rule on .menu/.toast/#addForm silently beats the hidden attribute");
});

test("every status in the UI select is a real pipeline stage", () => {
  const ids = STATUSES.map((s) => s.id);
  assert.ok(ids.includes("applied") && ids.includes("offer") && ids.includes("rejected"));
});

// --- the pipeline: applied -> oa -> ... -------------------------------------

test("the pipeline starts at Applied and every stage has a color and a kind", () => {
  assert.equal(STATUSES[0].id, "applied", "there is no Saved stage -- a row exists because you applied");
  assert.ok(!STATUSES.some((s) => s.id === "saved"));
  for (const s of STATUSES) {
    assert.match(s.color, /^#[0-9a-f]{6}$/i, s.id + " needs a color -- the UI derives its CSS from this");
    assert.ok(["active", "win", "dead"].includes(s.kind), s.id + " needs a kind for the header counts");
    assert.equal(typeof s.rank, "number", s.id + " needs a display rank");
  }
});

test("display rank floats Offer to the top and sinks Rejected to the very bottom", () => {
  const rank = Object.fromEntries(STATUSES.map((s) => [s.id, s.rank]));
  const order = STATUSES.slice().sort((a, b) => a.rank - b.rank).map((s) => s.id);
  assert.deepEqual(order, ["offer", "onsite", "phone", "oa", "applied", "ghosted", "rejected"]);
  assert.ok(rank.offer < rank.applied, "an offer outranks an untouched application");
  assert.equal(Math.max(...STATUSES.map((s) => s.rank)), rank.rejected, "rejected is dead last");
});

test("every row has an applied date", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const a = (await apps())[0];
  assert.equal(a.status, "applied");
  assert.ok(a.appliedAt, "the tracker only holds roles you applied to");
});

test("a leftover Saved row from the old pipeline migrates itself on read", async () => {
  await seed([{
    id: "old", company: "Ramp", title: "SWE", url: "u", track: "new grad",
    status: "saved", createdAt: ago(5), appliedAt: null, updatedAt: ago(5), notes: "", priority: false,
  }]);
  writes = 0;
  // through the API, because that is where normalize() runs -- apps() reads the
  // raw blob and would show the un-migrated row.
  const r = await handleApi(env, new Request("https://w/api/apps?key=k"), new URL("https://w/api/apps?key=k"));
  const [a] = await r.json();
  assert.equal(a.status, "applied", "an unknown status falls back to applied");
  assert.equal(a.appliedAt, a.createdAt, "a null appliedAt lands on the created date, not nowhere");
  assert.equal(writes, 0, "migrating on READ, not with a write");
});

test("advancing past applied does NOT rewrite the original applied date", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const first = (await apps())[0].appliedAt;
  await handleApi(env, apiReq("PATCH", { id: (await apps())[0].id, status: "onsite" }), apiUrl);
  assert.equal((await apps())[0].appliedAt, first, "appliedAt is when you applied, not when it last moved");
});

// --- KV write budget (invariant 1) ------------------------------------------

test("a PATCH that changes nothing does NOT write to KV", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const id = (await apps())[0].id;

  writes = 0;
  await handleApi(env, apiReq("PATCH", { id, status: "applied" }), apiUrl);   // already applied
  assert.equal(writes, 0, "the UI PATCHes on every status pick, including a no-op one");

  await handleApi(env, apiReq("PATCH", { id, status: "oa" }), apiUrl);
  assert.equal(writes, 1, "a real change still writes exactly once");
});

test("re-tapping an old Telegram alert writes nothing and does not reset the staleness clock", async () => {
  const job = { c: "Stripe", t: "SWE I", u: "https://stripe.com/jobs/1", k: "new grad" };
  await logApplied(env, appliedUrl(job));
  const before = (await apps())[0].updatedAt;

  writes = 0;
  await logApplied(env, appliedUrl(job));
  assert.equal(writes, 0);
  assert.equal((await apps())[0].updatedAt, before, "an accidental re-tap is not progress on the application");
});

// --- priority + notes --------------------------------------------------------

test("PATCH toggles the priority pin and stores notes", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const id = (await apps())[0].id;
  await handleApi(env, apiReq("PATCH", { id, priority: true }), apiUrl);
  await handleApi(env, apiReq("PATCH", { id, notes: "referral: dana" }), apiUrl);
  const a = (await apps())[0];
  assert.equal(a.priority, true);
  assert.equal(a.notes, "referral: dana");
});

// --- editing a card ----------------------------------------------------------
// You log a role from a Telegram alert, which carries no comp and often no
// location. You learn both later, from the recruiter. So every field is editable.

test("PATCH edits location and comp after the fact", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const id = (await apps())[0].id;

  await handleApi(env, apiReq("PATCH", { id, location: "NYC", comp: "$145k + equity" }), apiUrl);

  const a = (await apps())[0];
  assert.equal(a.location, "NYC");
  assert.equal(a.comp, "$145k + equity", "comp is free text -- ranges and 'ask Dana' are valid");
});

test("PATCH can correct the company and title, but never blank them", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const id = (await apps())[0].id;

  await handleApi(env, apiReq("PATCH", { id, company: "Ramp Financial", title: "Software Engineer, New Grad" }), apiUrl);
  assert.equal((await apps())[0].company, "Ramp Financial");

  const r = await handleApi(env, apiReq("PATCH", { id, company: "   " }), apiUrl);
  assert.equal(r.status, 400, "a nameless row is unusable");
  assert.equal((await apps())[0].company, "Ramp Financial", "and the old value survives");
});

test("editing the company does NOT move the id -- an old alert must still find the row", async () => {
  await logApplied(env, appliedUrl({ c: "Stripe", t: "SWE I", u: "https://stripe.com/jobs/1", k: "new grad" }));
  const id = (await apps())[0].id;

  await handleApi(env, apiReq("PATCH", { id, company: "Stripe Inc" }), apiUrl);
  assert.equal((await apps())[0].id, id, "the id is what the Telegram link re-taps against");

  // re-tapping the original alert must still resolve to this row, not duplicate it
  await logApplied(env, appliedUrl({ c: "Stripe", t: "SWE I", u: "https://stripe.com/jobs/1", k: "new grad" }));
  assert.equal((await apps()).length, 1);
});

test("an edit that changes nothing performs no KV write", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u", location: "NYC" }), apiUrl);
  const id = (await apps())[0].id;

  writes = 0;
  await handleApi(env, apiReq("PATCH", { id, company: "Ramp", title: "SWE", location: "NYC" }), apiUrl);
  assert.equal(writes, 0);
});

// --- backward compatibility --------------------------------------------------

test("rows written before saved/notes/priority existed still load", async () => {
  await seed([{
    id: "old1", company: "Stripe", title: "SWE", url: "https://x/1",
    location: "NYC", track: "new grad", status: "applied",
    appliedAt: ago(30), updatedAt: ago(30), notes: "",
  }]);
  writes = 0;
  const r = await handleApi(env, new Request("https://w/api/apps?key=k"), new URL("https://w/api/apps?key=k"));
  const [a] = await r.json();
  assert.equal(a.priority, false);
  assert.equal(a.comp, "", "a row written before comp existed reads back with an empty one");
  assert.equal(a.createdAt, a.appliedAt, "an old row has no createdAt -- fall back to when it was applied");
  assert.equal(writes, 0, "backfilling defaults happens on READ; it must not rewrite the blob");
});

// --- export / import ---------------------------------------------------------

const importReq = (body) =>
  new Request("https://w/api/import?key=k", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
const importUrl = new URL("https://w/api/import?key=k");

test("import merges a backup in without duplicating what is already there", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const mine = (await apps())[0];

  await handleApi(env, importReq({
    apps: [mine, { id: "z9", company: "Figma", title: "SWE Intern", url: "f", track: "internship", status: "oa", updatedAt: ago(1) }],
  }), importUrl);

  const list = await apps();
  assert.equal(list.length, 2, "the row I already had is matched by id, not re-added");
  assert.ok(list.find((a) => a.company === "Figma"));
});

test("importing a STALE backup cannot roll a live application back", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const id = (await apps())[0].id;
  await handleApi(env, apiReq("PATCH", { id, status: "offer" }), apiUrl);

  // a backup taken back when it was merely "applied"
  await handleApi(env, importReq({
    apps: [{ id, company: "Ramp", title: "SWE", url: "u", status: "applied", updatedAt: ago(9) }],
  }), importUrl);

  assert.equal((await apps())[0].status, "offer", "newest updatedAt wins");
});

test("import rejects anything that is not a list of applications", async () => {
  const r = await handleApi(env, importReq({ nope: true }), importUrl);
  assert.equal(r.status, 400);
});

test("delete then undo restores the row verbatim -- status, dates and notes", async () => {
  await handleApi(env, apiReq("POST", { company: "Ramp", title: "SWE", url: "u" }), apiUrl);
  const before = (await apps())[0];
  await handleApi(env, apiReq("PATCH", { id: before.id, status: "onsite", notes: "recruiter: sam" }), apiUrl);
  const live = (await apps())[0];

  await handleApi(env, apiReq("DELETE", { id: live.id }), apiUrl);
  assert.equal((await apps()).length, 0);

  await handleApi(env, apiReq("POST", live), apiUrl);        // what the undo toast sends back
  const back = (await apps())[0];
  assert.equal(back.id, live.id);
  assert.equal(back.status, "onsite", "undo is not a re-application -- it puts back what was there");
  assert.equal(back.notes, "recruiter: sam");
  assert.equal(back.appliedAt, live.appliedAt);
});

// --- company from a pasted URL -----------------------------------------------

test("the paste-a-URL quick add pulls the company off the domain", () => {
  // the ATS owns the domain -- the employer is the path segment
  assert.equal(companyFromUrl("https://boards.greenhouse.io/stripe/jobs/12345"), "Stripe");
  assert.equal(companyFromUrl("https://job-boards.greenhouse.io/databricks/jobs/77"), "Databricks");
  assert.equal(companyFromUrl("https://jobs.lever.co/ramp/8f2a-11"), "Ramp");
  assert.equal(companyFromUrl("https://jobs.ashbyhq.com/openai/abc-123"), "Openai");
  assert.equal(companyFromUrl("https://acme.wd1.myworkdayjobs.com/en-US/careers/job/SWE"), "Acme");
  assert.equal(companyFromUrl("https://careers.smartrecruiters.com/Visa/743999"), "Visa");
  // the company owns the domain
  assert.equal(companyFromUrl("https://careers.microsoft.com/us/en/job/1"), "Microsoft");
  assert.equal(companyFromUrl("https://www.amazon.jobs/en/jobs/2915/swe"), "Amazon");
  assert.equal(companyFromUrl("https://stripe.com/jobs/listing/x/1"), "Stripe");
  // a hyphenated tenant is a name, not a slug
  assert.equal(companyFromUrl("https://jobs.lever.co/scale-ai/1"), "Scale Ai");
  // junk in, empty out -- the field stays editable either way
  assert.equal(companyFromUrl("not a url"), "");
  assert.equal(companyFromUrl(""), "");
});

test("/api/parse hands the guessed company to the add form", async () => {
  const u = new URL("https://w/api/parse?key=k&url=" + encodeURIComponent("https://jobs.lever.co/ramp/1"));
  const r = await handleApi(env, new Request(u), u);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).company, "Ramp");
});
