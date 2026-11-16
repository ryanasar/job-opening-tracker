// Assembles the poll list. Nothing is hand-edited here.
//
//   companies.txt  -> the list you maintain (source of truth)
//   overrides.js   -> hand-tuned entries: Workday hosts, contacts, known-dead
//   registry.js    -> GENERATED from those two by scripts/sync.mjs
//   config.js      -> this file: the registry, and nothing else
//
// To add a company: add a line to companies.txt, then
//   node scripts/sync.mjs && node scripts/probe.mjs
//
// **ONLY companies on the list are polled.** There is no aggregator, no
// firehose, no coverage net -- the two SimplifyJobs feeds (new-grad and
// off-season internship) were removed on request. The consequence is explicit:
// a company sync can't resolve (docs/UNRESOLVED.md) is now genuinely NOT
// tracked, and a company you never added is invisible. Coverage is the
// watchlist's job alone -- crack the unresolved ones via docs/capture.md.

import { REGISTRY } from "./registry.js";

// (LOCATIONS regex removed. It used to pick loud vs silent by city, but all
//  alerts are silent now, and location filtering moved to inUS() in classify.js
//  -- a US-only gate rather than a per-city preference.)

export const COMPANIES = Object.entries(REGISTRY).map(([name, entry]) => ({
  name,
  ...entry,
}));
