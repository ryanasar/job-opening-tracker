# jobwatch

A Cloudflare Worker that checks company careers pages every 5 minutes and sends me
a Telegram message when a new-grad or off-season internship role shows up. It hits
each company's real portal, diffs against what it saw last time, and pings me
within a few minutes of a req going live. Summer internships are skipped on purpose
— I graduate in 2027, so they don't do me any good.

I built it because I got tired of refreshing job boards and still finding out about
roles a day late, after they'd already gotten a few hundred applicants.

There are actually two copies running off the same code: one for my software search
and one a friend uses for mechanical/aerospace roles. They share all the engine code
and only differ in a small profile (`{ COMPANIES, classify, track }`) plus a
watchlist file. So most files have a plain version and a `.mech` version.

## Heads up if you're cloning this

The files that map each company to its specific job board endpoint aren't in the
repo — `src/registry.js`, `src/overrides.js`, and their `.mech` counterparts are
gitignored, along with the generated `docs/UNRESOLVED*.md`. I didn't want to publish
my exact target list. Everything else (the engine, the adapters, the classifier) is
here.

To get it running you regenerate the registry from your own `companies.txt`:

```bash
npm run sync         # auto-detects each company's ATS -> writes src/registry.js
npm run sync:mech    # same for the mechanical list
```

Anything sync can't figure out lands in `docs/UNRESOLVED.md`, and you wire it up by
hand in `src/overrides.js` (mostly Workday hosts and the custom portals).

## The two annoying problems

**Every portal is different.** So each company gets an adapter, and they fall into
three tiers:

- Public ATS JSON — Greenhouse, Lever, Ashby, SmartRecruiters, Workday. One thing
  worth saying out loud: `boards-api.greenhouse.io/v1/boards/stripe/jobs` isn't some
  scraper or aggregator. Greenhouse is the ATS. Stripe's own careers page renders
  from that exact endpoint, so hitting it is hitting Stripe's portal, just without
  the HTML around it. You're often slightly ahead of the public page, since a req is
  live in the ATS before it gets linked anywhere.
- Custom portals — Amazon, Apple, Microsoft, Google, Meta. No public API, but their
  frontends call JSON endpoints that you can call too. They're undocumented so they
  drift every few months; `docs/capture.md` has my process for re-capturing one when
  it breaks.
- `html` fallback — pull job links straight out of the raw HTML with a regex. Ugly,
  but it works on anything.

On top of the per-company adapters there's a SimplifyJobs aggregator running as a
catch-all, so a new-grad role at a company I never added still has a chance of
getting caught. (The mechanical copy deliberately runs without it — there's no good
aggregator for those roles, so its watchlist has to carry the whole load.)

**Every company names the same job differently.** "SDE I", "Technology Development
Program", "Engineer, University Grad", "Early Career SWE", or just "Software
Engineer" with the class year buried in the description. No regex covers all of that.

So the classifier does the cheap checks first — an obvious-no regex, then a new-grad
allowlist (the title has to actually say entry-level: new grad, junior, 2027, SWE I,
associate, and so on). The only titles that reach an LLM call are the genuinely
ambiguous ones, mostly internships with no season attached, where it reads the
posting to decide. Verdicts get cached in KV per title string and basically never
expire, because companies repost the same titles constantly. After the first week
it barely calls the API — a few hundred Claude Haiku 4.5 calls across a whole
recruiting season. There's also a US-only location filter that runs before the
classifier, so confidently-foreign roles get dropped before they cost anything, and
a daily digest that backstops the whole thing in case a verdict was wrong.

## Setup

```bash
npm i -g wrangler && wrangler login

# figure out which ATS each company uses, then add them to companies.txt
node scripts/discover.mjs cloudflare datadog stripe ramp atlassian wiz vercel
npm run sync

wrangler kv namespace create JOBS       # paste the id into wrangler.toml

wrangler secret put TG_TOKEN            # from @BotFather -> /newbot
wrangler secret put TG_CHAT_ID          # api.telegram.org/bot<TOKEN>/getUpdates
wrangler secret put ANTHROPIC_KEY       # for the title classifier
wrangler secret put ADMIN_KEY           # any random string, gates the admin routes

wrangler deploy
curl "https://jobwatch.<you>.workers.dev/test?key=$ADMIN_KEY"     # send a test alert
curl "https://jobwatch.<you>.workers.dev/health?key=$ADMIN_KEY"   # adapter status
```

The first time it polls a company it seeds quietly: it records what's already open
without alerting on any of it. Real alerts start on the second poll.

## Catching silent breakage

The thing I actually worry about isn't an endpoint changing — it's an endpoint
changing and me not noticing for three weeks while I assume that company just hasn't
posted anything.

So a thrown error or a zero-jobs response both count as failures. The Worker tracks
consecutive failures per adapter in KV and sends me a warning after six in a row
(about 30 minutes). `/health` shows the current state of every adapter. In practice
I spend maybe 15 minutes every couple of months re-capturing whichever custom portal
rotted.

## Why a Worker and not GitHub Actions

Scheduled GitHub Actions are best-effort — they get queued and routinely fire 10 to
40 minutes late, which defeats the whole point of catching a posting early. Workers
cron has a 1-minute minimum and actually runs on time.

I'm on the $5/month Workers Paid plan. The free tier caps you at 10ms of CPU per
invocation, which is only enough to parse a couple of boards per run, so on free
you'd have to shard the work across ticks. Paid raises the limit to 30 seconds, so
every company gets polled on every 5-minute tick with no sharding. The one cap I do
keep is polling six companies at a time, and that's just being polite to the ATS
endpoints, not a CPU thing.

## Cost

Runs about $5.40/month all in, and it's mostly just the $5 base plan. My software
list currently resolves to about 70 companies, all polled every 5 minutes:

| | usage | included on the $5 plan |
|---|---|---|
| Worker invocations | ~8,600/month (288/day, 5-min cron) | 10M/month |
| KV reads | ~1.5M/month | 10M/month |
| KV writes | a few thousand/month (only on real changes) | 1M/month |
| Cron triggers | 2 (the 5-min poll + a daily digest) | — |
| Anthropic | a few hundred Claude Haiku 4.5 calls total | cents |

There's 5–10x headroom on everything, so the same $5 would cover a few hundred
companies before anything gets tight. `npm run budget` re-checks this against the
live boards whenever the list grows.
