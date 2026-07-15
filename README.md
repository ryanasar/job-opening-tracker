# jobwatch

Polls each company's own careers portal directly, diffs against KV, pushes a
Telegram alert within ~5 minutes of a new-grad role going live.
Cloudflare Workers free tier. Cost: ~$0.

## The two hard parts

**1. Every portal is different.** So every company gets an *adapter*, in three tiers:

- **Tier 1 — public ATS JSON** (Greenhouse, Lever, Ashby, SmartRecruiters, Workday).
  Worth being clear: `boards-api.greenhouse.io/v1/boards/stripe/jobs` is not an
  aggregator. Greenhouse is an ATS, not a job board. Stripe's careers page renders
  from that exact endpoint. Hitting it *is* hitting Stripe's portal — minus the
  HTML. If anything you're slightly ahead of the public page, since a req is live
  in the ATS before anyone links it.
- **Tier 2 — custom portals** (Amazon, Apple, Microsoft, Google, Meta). No public
  API, but their own frontends call JSON endpoints you can call too. Undocumented,
  so they drift. See `docs/capture.md`.
- **Tier 3 — `html`** — diff job links out of raw HTML. Crude, always works.

**2. Every company names the job differently.** "SDE I" / "Technology Development
Program" / "Engineer, University Grad" / "Early Career SWE" / plain "Software
Engineer" with the class year buried in the body. Regex will never cover this.

So `classify.js` does: obvious-NO regex → obvious-YES regex → **LLM call for
anything ambiguous**, with the verdict cached in KV **per unique title string,
forever**. Companies repost the same titles endlessly, so after week one this
barely fires. A few hundred Haiku calls across the whole season. Pennies.

## Setup

```bash
npm i -g wrangler && wrangler login

node scripts/discover.mjs cloudflare datadog stripe ramp atlassian wiz vercel
# -> tells you which ATS each uses; add the company to companies.txt, then npm run sync
# -> for Amazon/Apple/Microsoft/etc, follow docs/capture.md

wrangler kv namespace create JOBS       # paste id into wrangler.toml

wrangler secret put TG_TOKEN            # @BotFather -> /newbot
wrangler secret put TG_CHAT_ID          # api.telegram.org/bot<TOKEN>/getUpdates
wrangler secret put ANTHROPIC_KEY       # for the title classifier
wrangler secret put ADMIN_KEY           # any random string

wrangler deploy
curl "https://jobwatch.<you>.workers.dev/test?key=$ADMIN_KEY"     # verify push
curl "https://jobwatch.<you>.workers.dev/health?key=$ADMIN_KEY"   # adapter status
```

First poll per company **seeds silently** — records what's already open without
alerting. Alerts start on poll two.

## Silent breakage is the real enemy

An undocumented endpoint changing is fine. An undocumented endpoint changing and
you not noticing for three weeks while you assume Amazon hasn't posted yet is
not fine.

So: an exception *or* a zero-jobs response counts as a failure, consecutive
failures are tracked in KV, and you get a Telegram warning after 6 in a row
(~30 min). `/health` shows current state. Budget ~15 min every couple months to
re-capture whichever adapter rotted.

## Why Workers and not GitHub Actions

GH Actions scheduled workflows are best-effort queued and routinely fire 10-40
minutes late. Workers cron has a 1-minute minimum and actually fires on time.

The constraint is 10ms CPU per invocation on the free plan. Hence sharding:
cron runs every minute, each tick handles `i % 5 === shard`, so every company is
polled every 5 minutes while each tick only parses 2-3 boards. Network waiting
(fetch, KV, LLM) does not count against CPU time, so the classifier is free here.

If the 10ms budget gets tight, $5/mo Workers Paid raises it to 30s and you can
drop the sharding.

## Budget

| | | |
|---|---|---|
| Worker invocations | 1,440/day | limit 100,000 |
| KV reads | ~5,000/day | limit 100,000 |
| KV writes | only on change | limit 1,000 |
| Cron triggers | 1 | limit 5 |
| Anthropic | a few hundred Haiku calls, total | ~$0 |
