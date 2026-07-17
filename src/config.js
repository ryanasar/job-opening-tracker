// Assembles the poll list. Nothing is hand-edited here.
//
//   companies.txt  -> the list you maintain (source of truth)
//   overrides.js   -> hand-tuned entries: Workday hosts, contacts, known-dead
//   registry.js    -> GENERATED from those two by scripts/sync.mjs
//   config.js      -> this file: registry + the aggregator net
//
// To add a company: add a line to companies.txt, then
//   node scripts/sync.mjs && node scripts/probe.mjs
// Anything sync can't resolve lands in UNRESOLVED.md and is still caught by the
// aggregator below -- roughly 30 min behind, but never silently dropped.

import { REGISTRY } from "./registry.js";

// (LOCATIONS regex removed. It used to pick loud vs silent by city, but all
//  alerts are silent now, and location filtering moved to inUS() in classify.js
//  -- a US-only gate rather than a per-city preference.)

export const COMPANIES = [
  ...Object.entries(REGISTRY).map(([name, entry]) => ({ name, ...entry })),

  // Coverage nets. Not companies -- firehoses. The new-grad one catches
  // everything in UNRESOLVED.md plus companies you never added; the internship
  // one is the ONLY backstop for the off-season internship track (direct polling
  // is the only other source, so browser-walled shops like Tesla depend on this).
  { name: "New-grad firehose", adapter: "aggregator" },
  { name: "Off-season internship firehose", adapter: "internships" },
];
