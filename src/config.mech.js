// Assembles the MECHANICAL tracker's poll list. Mirrors config.js exactly: the
// watchlist and nothing else. This file never had an aggregator (the SimplifyJobs
// firehose is a CS/SWE feed, so it would only add software noise here), and as of
// the new-grad-only change config.js doesn't either. Coverage is the boards.
//
// To add a company: add a line to companies-mech.txt, then
//   node scripts/sync.mjs mech && PROFILE=mech node scripts/probe.mjs

import { REGISTRY } from "./registry.mech.js";

export const COMPANIES = Object.entries(REGISTRY).map(([name, entry]) => ({ name, ...entry }));
