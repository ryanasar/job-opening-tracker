// The MECHANICAL Worker: the same shared engine (engine.js) bound to the
// mechanical profile. Separate Worker, separate KV, separate Telegram chat,
// separate dashboard key -- nothing is shared with the software Worker except the
// code. New-grad only, no aggregator.

import { createEngine } from "./engine.js";
import { COMPANIES } from "./config.mech.js";
import { classify, track } from "./classify.mech.js";

export default createEngine({
  COMPANIES,
  classify,
  track,
  owner: "JOSH",
  silent: false,   // Josh wants loud alerts (sound), unlike Ryan's silent tracker
  testTitle: "Mechanical Engineer I, New Grad 2027",
}).handler;
