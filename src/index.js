// The SOFTWARE Worker: the shared engine bound to the software profile. The
// poll loop, KV rules and tracker all live in engine.js; this file only supplies
// what's field-specific -- the watchlist and the classifier. The mechanical
// Worker (src/index.mech.js) is the same three lines with a different profile.
//
// checkCompany / runAll / digest are re-exported because test/cron.test.mjs
// drives them directly against the software classifier.

import { createEngine } from "./engine.js";
import { COMPANIES } from "./config.js";
import { classify, track } from "./classify.js";

const engine = createEngine({
  COMPANIES,
  classify,
  track,
  owner: "RYAN",
  testTitle: "Software Engineer I, New Grad 2027",
});

export const { checkCompany, runAll, digest } = engine;
export default engine.handler;
