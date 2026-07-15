// Assembles the MECHANICAL tracker's poll list. Mirrors config.js, with one
// deliberate difference: NO aggregator. The SimplifyJobs firehose is a CS/SWE
// new-grad feed, so it would only add software noise here (which his classifier
// drops anyway) and give nothing back. His coverage is his own boards.
//
// To add a company: add a line to companies-mech.txt, then
//   node scripts/sync.mjs mech && PROFILE=mech node scripts/probe.mjs

import { REGISTRY } from "./registry.mech.js";

export const COMPANIES = Object.entries(REGISTRY).map(([name, entry]) => ({ name, ...entry }));
