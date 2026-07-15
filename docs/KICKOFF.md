# Kickoff — paste this into Claude Code

Work through these in order. Stop and show me the result after each numbered
step; don't chain them all together. Read CLAUDE.md first.

---

## 1. Verify the adapters actually work

None of the adapter code has been run against a live endpoint. This is the
highest-risk unknown in the repo — assume some of it is wrong.

- Run `node discover.mjs` against every tier-1 slug in `src/config.js`.
  Fix any slug that doesn't resolve. Some are guesses.
- Write `scripts/probe.mjs` that imports each adapter from `src/adapters.js`,
  runs it against the live endpoint, and prints
  `company | adapter | #jobs | first title`.
- Run it. Report which adapters return jobs, which 403, which 404, and which
  return a shape that doesn't match `{id, title, location, url}`.
- Fix the broken ones. For tier-2 (Amazon/Apple/Microsoft) the endpoints are
  undocumented and may have drifted — if one is dead, say so rather than
  guessing at a fix.

Do not proceed until every adapter in the config either works or is removed.

## 2. Add the companies I actually care about

Current config is a starter set. Add, in priority order, and figure out the
right adapter for each:

Capital One, Atlassian, Amazon, Charles Schwab, Apple, Cloudflare, Salesforce,
Uber, Microsoft, Google, Stripe, Datadog, CrowdStrike, SailPoint, Wiz, Ramp,
Cockroach Labs, Spotify, Akamai, HubSpot, Garmin, Texas Instruments, USAA.

For anything that fails `discover.mjs`, follow `capture.md`. If a portal turns
out to be a real pain (Meta's GraphQL persisted queries, say), flag it and skip
it rather than sinking an hour — most of these are low priority anyway.

## 3. Test the cron path locally

`npx wrangler dev --test-scheduled`, hit `/__scheduled`, confirm:
- The right shard fires for the right minute.
- First run per company seeds silently (no Telegram messages).
- Second run alerts only on genuinely new IDs.
- Simulate an adapter throwing → confirm the failure counter increments and the
  warning fires on the 6th consecutive failure, not before.

Write these as actual tests if it's quick. Mock KV with a Map.

## 4. Verify the free-tier budget with real numbers

Instrument a counted wrapper around every `env.JOBS` call. Run a simulated day
(288 polls × N companies) against mocked KV and print total reads / writes /
deletes. Confirm writes and deletes stay under 1,000/day with the real company
count from step 2.

If writes creep up, find out which adapter is churning IDs. A board whose IDs are
non-deterministic between calls will silently burn the write budget — that's the
failure I most want caught before deploy.

## 5. Deploy

KV namespace, four secrets, `wrangler deploy`. Then:
- `curl /test` → confirm a 🔴 alert lands on my phone with sound.
- Manually send a 🟡 → confirm it lands silently.
- `curl /health` → all adapters green.
- `curl /digest` → digest renders.

## 6. Then leave it alone

Don't add features. Specifically: no dashboard, no auto-apply, no scraping
Greenhouse HTML. See "Things NOT to build" in CLAUDE.md.

---

Constraints worth repeating: KV writes/deletes are 1,000/day and are the binding
constraint. Classifier fails open. Zero-jobs is a failure, not an empty result.
