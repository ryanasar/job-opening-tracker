#!/usr/bin/env node
// Usage: node scripts/hunt.mjs
//
// For every company still in UNRESOLVED.md, fetch its careers page and work out
// which ATS FAMILY it's on. Most big companies are not bespoke -- they're
// Workday / Eightfold / iCIMS behind a vanity domain. Identify the family and
// one adapter unlocks a dozen companies at once.
//
// Prints a report. Wiring anything up is a separate, deliberate step.

const CAREERS = {
  "Meta": "https://www.metacareers.com/jobs",
  "Uber": "https://www.uber.com/us/en/careers/list/",
  "Netflix": "https://explore.jobs.netflix.net/careers",
  "Doordash": "https://careers.doordash.com/",
  "Google": "https://www.google.com/about/careers/applications/jobs/results/",
  "ByteDance": "https://jobs.bytedance.com/en/position",
  "Qualcomm": "https://careers.qualcomm.com/careers",
  "Oracle": "https://careers.oracle.com/jobs/",
  "Adobe": "https://careers.adobe.com/us/en/search-results",
  "Slack": "https://slack.com/careers",
  "Salesforce": "https://careers.salesforce.com/en/jobs/",
  "Tesla": "https://www.tesla.com/careers/search/",
  "Dell": "https://jobs.dell.com/en/search-jobs",
  "Intuit": "https://jobs.intuit.com/search-jobs",
  "Wells Fargo": "https://www.wellsfargojobs.com/en/jobs/",
  "JP Morgan": "https://careers.jpmorgan.com/us/en/students/programs",
  "Q2": "https://www.q2.com/careers",
  "Bloomberg": "https://careers.bloomberg.com/job/search",
  "Visa": "https://corporate.visa.com/en/jobs/",
  "IBM": "https://www.ibm.com/careers/search",
  "HashiCorp": "https://www.hashicorp.com/careers/open-positions",
  "DigitalOcean": "https://www.digitalocean.com/careers/current-openings",
  "Akamai": "https://akamaicareers.inflightcloud.com/search",
  "Zoom": "https://careers.zoom.us/jobs/search",
  "HubSpot": "https://www.hubspot.com/careers/jobs",
  "Shopify": "https://www.shopify.com/careers/search",
  "Zillow": "https://www.zillow.com/careers/",
  "Expedia": "https://careers.expediagroup.com/jobs/",
  "Retool": "https://retool.com/careers",
  "Hudson River Trading": "https://www.hudsonrivertrading.com/careers/",
  "Citadel": "https://www.citadel.com/careers/open-opportunities/",
  "Two Sigma": "https://careers.twosigma.com/careers/SearchJobs",
  "DRW": "https://drw.com/work-at-drw/listings",
  "Lockheed Martin": "https://www.lockheedmartinjobs.com/search-jobs",
  "Northrop Grumman": "https://www.northropgrumman.com/jobs/",
  "Raytheon": "https://careers.rtx.com/global/en/search-results",
  "DraftKings": "https://careers.draftkings.com/jobs/",
  "Chewy": "https://careers.chewy.com/us/en/search-results",
  "GrubHub": "https://careers.grubhub.com/",
  // known-dead, re-checked in case they moved
  "Atlassian": "https://www.atlassian.com/company/careers/all-jobs",
  "Microsoft": "https://jobs.careers.microsoft.com/global/en/search",
};

// Each family has a documented-enough JSON endpoint we could adapt.
const FAMILIES = [
  ["workday",        /([a-z0-9.-]+\.myworkdayjobs\.com)/i],
  ["eightfold",      /([a-z0-9-]+\.eightfold\.ai)|eightfold/i],
  ["greenhouse",     /boards(-api)?\.greenhouse\.io\/(v1\/boards\/)?([a-z0-9_-]+)/i],
  ["lever",          /jobs\.lever\.co\/([a-z0-9_-]+)/i],
  ["ashby",          /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i],
  ["smartrecruiters",/smartrecruiters\.com\/([A-Za-z0-9_-]+)/],
  ["icims",          /([a-z0-9-]+\.icims\.com)/i],
  ["phenom",         /phenompeople|phenom\.com|\.phenom\./i],
  ["jobvite",        /jobs\.jobvite\.com\/([a-z0-9_-]+)/i],
  ["taleo",          /taleo\.net/i],
  ["successfactors", /successfactors|sapsf\.com/i],
  ["avature",        /avature\.net/i],
  ["inflight",       /inflightcloud\.com/i],
];

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

async function sniff(name, url) {
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(25000) });
    const html = await r.text();
    const hits = [];
    for (const [fam, re] of FAMILIES) {
      const m = html.match(re);
      if (m) hits.push({ fam, detail: m[1] || m[0] });
    }
    // dedupe by family
    const seen = new Set();
    const uniq = hits.filter((h) => !seen.has(h.fam) && seen.add(h.fam));
    return { name, url, status: r.status, bytes: html.length, hits: uniq };
  } catch (e) {
    return { name, url, error: String(e.message || e).slice(0, 60) };
  }
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }),
  );
  return out;
}

const entries = Object.entries(CAREERS);
console.log(`sniffing ${entries.length} careers pages...\n`);
const results = await pool(entries, 6, ([n, u]) => sniff(n, u));

const byFam = new Map();
const none = [];
for (const r of results) {
  if (r.error) { none.push(`${r.name} (fetch failed: ${r.error})`); continue; }
  if (!r.hits.length) { none.push(`${r.name} (HTTP ${r.status}, no ATS signature — custom/SPA)`); continue; }
  for (const h of r.hits) {
    if (!byFam.has(h.fam)) byFam.set(h.fam, []);
    byFam.get(h.fam).push(`${r.name} → ${h.detail}`);
  }
}

for (const [fam, list] of [...byFam].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${fam.toUpperCase()}  (${list.length})`);
  for (const l of list) console.log(`   ${l}`);
}
console.log(`\nNO SIGNATURE  (${none.length})`);
for (const l of none) console.log(`   ${l}`);
