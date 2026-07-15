# Capturing a company's portal endpoint

Every careers page you've ever used is a JavaScript app calling a JSON API. That
API is the company's portal — it's what their own page renders from. You want to
call it directly.

## The 90-second recipe

1. Open the company's careers page, search for "software engineer".
2. DevTools → **Network** → filter **Fetch/XHR**.
3. Hit search again. Watch what fires.
4. Find the request whose response contains the job titles. Usually one obvious
   fat JSON response.
5. Right-click → **Copy as cURL**. That's your adapter — headers, body, and all.
6. Paste it into a terminal and confirm it works standalone. Strip headers one at
   a time until it breaks; keep only what's load-bearing (usually just
   `Content-Type` and a plausible `User-Agent`).
7. Write an adapter in `src/adapters.js` that maps the response to
   `{ id, title, location, url }`.

## What you'll run into

**No XHR fires at all.** The page is server-rendered — jobs are already in the
HTML. Use the `html` adapter, or look for a `__NEXT_DATA__` / `window.__STATE__`
`<script>` blob in the source, which is often the same JSON.

**GraphQL with a `doc_id` or persisted-query hash** (Meta does this). Copy the
whole POST body verbatim. It's brittle — the hash rotates when they redeploy.
Set expectations accordingly, or fall back to `html`.

**Cloudflare/Akamai bot checks.** Some portals 403 a bare `fetch`. Send a real
browser `User-Agent` first; that clears most of them. If it still fails, that
company goes to `html` or gets dropped. Do not go down the headless-browser
path for this — it's not worth it, and it isn't free.

**Auth cookie required.** Rare for public listings. If you hit it, skip.

## Adapters break. Plan for it.

Undocumented endpoints change without notice. The worst outcome isn't an adapter
breaking — it's an adapter breaking *silently* and you assuming Amazon just
hasn't posted yet.

So `checkCompany()` treats an exception **or a suspicious zero-jobs response** as
a failure, counts consecutive failures in KV, and pings you after 6 in a row
(~30 min). Check `/health?key=...` any time for the current state.

When one breaks: re-run the recipe above, fix the adapter, redeploy. Budget
maybe 15 minutes every couple of months.

## Known tiers for your list

| Tier | Companies | Notes |
|---|---|---|
| ATS (stable) | Cloudflare, Datadog, CrowdStrike, Stripe, Wiz, Ramp, Vercel, Atlassian, Cockroach, SailPoint | Public JSON. Set and forget. |
| Workday | Capital One, Schwab, USAA, Salesforce | Undocumented but very stable. Same shape every tenant. |
| Custom portal | Amazon, Apple, Microsoft, Google, Meta, Uber | Capture per the recipe. Expect drift. |

The tier-1 companies are, conveniently, most of the ones you actually said you
want (the Atlassian/Cloudflare scale-up cluster). The fragile adapters are mostly
the FAANG names you ranked lowest.
