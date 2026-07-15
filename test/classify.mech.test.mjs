// The mechanical-engineering classifier. Tight allowlist, new-grad only, no
// software. Titles below are drawn from his buzzword list and from what his
// companies (Tesla, Boeing, Apple, semiconductor fabs, consulting firms) actually
// post.

import { test } from "node:test";
import assert from "node:assert/strict";
import { screen, track, classify } from "../src/classify.mech.js";

const high = (t) => assert.equal(screen(t), "high", `expected HIGH: ${t}`);
const no = (t) => assert.equal(screen(t), "no", `expected NO: ${t}`);

test("his target new-grad titles, with an entry-level signal, are HIGH", () => {
  high("Mechanical Engineer I");
  high("Mechanical Design Engineer I");
  high("Junior Mechanical Engineer");
  high("Entry Level Mechanical Engineer");
  high("Associate Mechanical Engineer");
  high("New Grad Mechanical Engineer");
  high("Design Engineer I");
  high("Test Engineer I");
  high("Controls Engineer I");
  high("Thermal Engineer, Class of 2027");
  high("Manufacturing Engineer - New Grad");
  high("Product Development Engineer I");
  high("R&D Engineer I");
  high("Robotics Engineer I");
  high("Mechatronics Engineer I");
  high("Engineering Associate, Mechanical");
});

test("the field is required: non-mechanical fields are dropped even at entry level", () => {
  no("Software Engineer I");                 // his exclusion
  no("Software Design Engineer I");          // hybrid -- 'design' must not rescue it
  no("Firmware Engineer I");
  no("Data Scientist I");
  no("Electrical Engineer I");               // adjacent, but not his field
  no("Financial Analyst, New Grad");
  no("Junior Accountant");
});

test("TIGHT: a bare field title with no entry level is dropped", () => {
  // He chose the tight posture, matching the software tracker. Bare titles go.
  no("Mechanical Engineer");
  no("Design Engineer");
  no("Test Engineer");
  no("Manufacturing Engineer");
});

test("seniority, management and internships are dropped", () => {
  no("Senior Mechanical Engineer");
  no("Staff Design Engineer");
  no("Mechanical Engineer II");
  no("Principal Systems Engineer");
  no("Engineering Manager I");
  no("Mechanical Engineering Manager");
  no("Mechanical Engineering Intern");       // new grad only
  no("Mechanical Engineering Co-op - Fall 2026");
});

test("wrong class years are dropped, right ones kept", () => {
  no("Mechanical Engineer, Class of 2028");
  no("Mechanical Engineer I - 2025 Start");
  high("Mechanical Engineer I - 2027 Start");
});

test("track is always new grad, and classify() mirrors screen()", async () => {
  assert.equal(track("anything"), "new grad");
  assert.equal(await classify({}, {}, { title: "Mechanical Engineer I" }), "high");
  assert.equal(await classify({}, {}, { title: "Senior Mechanical Engineer" }), "no");
  assert.equal(await classify({}, {}, { title: "" }), "no");
});
