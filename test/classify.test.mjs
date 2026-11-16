// Usage: node --test 'test/*.test.mjs'
//
// The classifier is now ONE tier: pure regex, "high" or "no". There is no LLM
// escalation and no description read, because there is no ambiguous bucket left
// -- new grad is a title allowlist, and every 2026/2027 internship term counts.
//
// TWO tracks: new grad (full-time, entry-level, class of May 2027) and software
// internships/co-ops (Summer 2027 included, at the user's request).

import { test } from "node:test";
import assert from "node:assert/strict";
import { screen, track, inUS } from "../src/classify.js";

const high = (t) => assert.equal(screen(t), "high", `expected HIGH: ${t}`);
const no = (t) => assert.equal(screen(t), "no", `expected NO: ${t}`);

// --- new grad -- an ALLOWLIST ---------------------------------------------
// A full-time title must positively say entry-level, or it is dropped. In
// practice a real new-grad role names itself in the title, so this costs almost
// no real jobs and kills the mid-level flood.

test("new-grad titles with an entry-level signal are HIGH", () => {
  high("Software Engineer I");
  high("New Grad Software Engineer");
  high("SDE I");
  high("Associate Software Engineer");
  high("Engineer, University Graduate");
  high("Technology Development Program");
  high("Software Engineer, Class of 2027");
  // the words the user asked for, and close variants
  high("Entry Level Software Engineer");
  high("Software Engineer, Level 1");
  high("Software Engineer L1");
  high("Engineer 1, Platform Infrastructure");
  high("Graduate Software Engineer");
  high("Software Engineer - 2027 Grad");
  high("Early Career Software Engineer");
  high("Software Engineering Apprentice");
  high("Junior Software Engineer");
  high("Jr. Backend Engineer");
});

test("seniority and non-engineering are NO", () => {
  no("Senior Software Engineer");
  no("Staff Engineer");
  no("Software Engineer II");
  no("Principal Architect");
  no("Account Executive");
  no("Recruiter");
});

test("a bare full-time engineering title has NO entry signal -- dropped", () => {
  // A new-grad role practically always names itself; a plain title is mid-level.
  // Note this is now FINAL: the aggregator that used to catch a plainly-titled
  // new-grad req on the quiet channel is gone, so these are simply not tracked.
  no("Software Engineer");
  no("Backend Engineer");
  no("Full Stack Engineer");
  no("Software Developer");
  no("Machine Learning Engineer");
  no("Software Engineer, Level III");
});

test("a class year the user cannot take is NO even with an entry signal", () => {
  no("New Grad Software Engineer, Class of 2028");
  no("2025 Graduate Software Engineer");
});

// --- internships: every 2026/2027 term, software only -----------------------
// Summer 2027 is IN (asked for explicitly), as are off-season terms and
// seasonless titles. The gate is about field and year, not level -- "intern"
// is itself the entry-level signal.

const yes = (t) => assert.equal(screen(t), "high", `expected HIGH: ${t}`);

test("software internships alert, any 2027 term", () => {
  yes("Software Engineer Intern - Summer 2027");
  yes("Software Engineering Intern - Summer '27");
  yes("Winter 2027 Software Engineer Co-op");
  yes("Spring 2027 Software Engineer Intern");
  yes("Software Engineer Intern - Fall 2026");
  yes("Software Engineer, Intern (Summer or Winter)");
  yes("2027 Intern - Software Engineer");
});

test("a seasonless software internship alerts -- nothing left to ask", () => {
  yes("Software Engineer Intern");
  yes("Software Engineer, Internship - Defense Tech");
  yes("Software Engineering Co-op");
  yes("Data Engineer Intern");
  yes("Privacy and Civil Liberties Software Engineer, Internship");
});

test("a dead or post-graduation term is NO", () => {
  no("Summer 2026 Software Engineering Intern");
  no("Software Engineer Intern - Summer '26");
  no("Software Engineer Intern, Summer 2028");
  no("2025 Software Engineering Intern");
});

test("a non-software engineering internship is NO", () => {
  // Anduril's board, live: "engineer" alone would let all of these through.
  no("2027 Mechanical Engineer Intern");
  no("Winter 2027 Electrical Engineer Co-op");
  no("Winter 2027 Warhead Engineer Co-op");
  no("Global Operations Supplier Process Engineer Co-Op");
  no("Winter 2027 Technical Program Management Co-op");
  no("Accelerations Programs Intern");
  no("Marketing Intern, Summer 2027");
});

test("high-school, PhD and senior internships are NO", () => {
  no("High School Internship, Software Engineering (Summer 2027)");
  no("PhD Machine Learning Software Engineer Intern (Summer 2027)");
  no("Senior Software Engineer Intern");
});

// --- the alert tag ---------------------------------------------------------

test("track() splits internships from new grad", () => {
  assert.equal(track("Software Engineer I"), "new grad");
  assert.equal(track("New Grad Software Engineer"), "new grad");
  assert.equal(track("Software Engineer Intern"), "internship");
  assert.equal(track("Software Engineering Co-op"), "internship");
  assert.equal(track(), "new grad");
});

// --- US-only location gate -------------------------------------------------

const us = (l) => assert.equal(inUS(l), true, `expected KEEP (US): ${l}`);
const foreign = (l) => assert.equal(inUS(l), false, `expected DROP (non-US): ${l}`);

test("US locations are kept", () => {
  us("Austin, TX");
  us("Seattle, WA");
  us("New York, NY");
  us("San Francisco, CA");
  us("Portland, OR");
  us("Bloomington, IN");           // Indiana, not India
  us("United States");             // Amazon/Uber return this literally
  us("Remote, USA");
  us("Washington, DC");
  us("Vancouver, WA");             // Washington state, NOT BC -- US_SIGNAL wins
  us("San Francisco, California"); // Greenhouse spells the state out
  us("Bellevue, Washington");
});

test("multi-location postings are kept if ANY location is US", () => {
  // Databricks SWE Intern (2027) -- was dropped because of the Canada entry
  us("Bellevue, Washington; Mountain View, California; San Francisco, California; Vancouver, Canada");
  us("London, United Kingdom; New York, NY");
  foreign("Amsterdam, Netherlands; Berlin, Germany");
  foreign("Toronto, Ontario | Vancouver, BC");
});

test("ambiguous locations fail OPEN -- never drop a possible US job", () => {
  us("");                          // no data
  us("Remote");                    // bare remote -> assume reachable
  us("Chicago");                   // bare US city, no state -> keep
  us("Cambridge");                 // could be Cambridge MA -> keep (why we never
                                   // add bare "cambridge" to the foreign list)
});

test("confidently non-US locations are dropped", () => {
  foreign("Warsaw, Poland");       // Netflix
  foreign("Bengaluru, Karnataka, India");   // Wells Fargo
  foreign("Metro Manila, National Capital Region, Philippines"); // JP Morgan CEBU
  foreign("London, United Kingdom");
  foreign("glenrothes, Fife");     // Raytheon UK
  foreign("Toronto, Ontario");
  foreign("Vancouver, BC");        // Canada -- no US state signal
  foreign("Singapore");
  foreign("Tokyo, Japan");
  foreign("Tel Aviv, Israel");
});

// The mechanical tracker (jobwatch-mech) shares this gate, and its watchlist is
// heavy on international employers -- so these have to drop too. Serbia was the
// concrete miss that prompted the expansion.
test("international mechanical-employer locations are dropped", () => {
  foreign("Belgrade, Serbia");     // the miss
  foreign("Novi Sad, Serbia");
  foreign("Monterrey, Mexico");    // auto / manufacturing plants
  foreign("Guadalajara");          // bare Mexican city, no country named
  foreign("Stuttgart, Germany");   // Bosch / ZF / Mercedes
  foreign("Wolfsburg");            // VW, bare city
  foreign("Eindhoven, Netherlands");   // ASML
  foreign("Veldhoven");            // ASML HQ, bare city
  foreign("Hsinchu, Taiwan");      // semiconductor belt
  foreign("Suwon, South Korea");   // Samsung
  foreign("Bristol, UK");          // Graphcore -- caught by the country, not the city
  foreign("Cambridge, UK");        // Arm -- caught by the country, not the city
  foreign("Toulouse, France");     // aerospace
  foreign("Bratislava, Slovakia");
});

// The flip side of the blocklist: US cities that share a name with a foreign one
// must still be kept. The state abbreviation makes US_SIGNAL win before the
// blocklist is even consulted -- proof the expansion added no false drops.
test("US cities that collide with foreign names are kept (state wins)", () => {
  us("Cambridge, MA");             // not Cambridge, UK
  us("Rome, GA");                  // not Rome, Italy
  us("Birmingham, AL");            // not Birmingham, UK
  us("Bristol, TN");               // not Bristol, UK
  us("Naples, FL");                // not Naples, Italy
  us("Waterloo, IA");              // not Waterloo, Ontario
});

test("manager roles are NO -- they are never a new-grad job", () => {
  // Found by dry-running the gate live: "Engineering Manager I" asks for only 1
  // year, so the years gate could never catch it. It has to die on the title --
  // and now the title is the only thing there is.
  no("Engineering Manager I, Innovative Ad Formats");
  no("Manager I, Engineering");
  no("Group Product Manager, Developer Infrastructure");
  no("Technical Program Manager");
  no("Distinguished Engineer");
});

test("but 'manager' as a TEAM or PRODUCT name is not a manager role", () => {
  // These carry a new-grad signal, so the only thing that could drop them is the
  // manager rule mis-firing on a product/team name. It must not.
  high("Software Engineer I, Package Manager");
  high("New Grad Software Engineer, Fleet Manager Team");
});
