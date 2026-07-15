#!/usr/bin/env node
// Usage: node discover.mjs stripe cloudflare datadog ramp
// Brute-forces the common ATS endpoints for a slug and tells you which one works.

const probes = [
  ["greenhouse", (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, (d) => d.jobs?.length],
  ["lever", (s) => `https://api.lever.co/v0/postings/${s}?mode=json`, (d) => Array.isArray(d) && d.length],
  ["ashby", (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`, (d) => d.jobs?.length],
  ["smartrecruiters", (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`, (d) => d.totalFound],
];

for (const slug of process.argv.slice(2)) {
  let found = false;
  for (const [name, url, count] of probes) {
    try {
      const r = await fetch(url(slug));
      if (!r.ok) continue;
      const d = await r.json();
      const n = count(d);
      if (n) {
        console.log(`${slug.padEnd(18)} -> ${name.padEnd(16)} (${n} jobs)`);
        found = true;
        break;
      }
    } catch {}
  }
  if (!found) {
    console.log(`${slug.padEnd(18)} -> not found (likely Workday/iCIMS/custom — open the careers page, F12 > Network, filter XHR, and look at the JSON call the page makes)`);
  }
}
