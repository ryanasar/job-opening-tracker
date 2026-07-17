// Usage: node --test 'test/*.test.mjs'
//
// The regex tier of the classifier. `screen()` returns a verdict, or null
// meaning "too ambiguous, ask the LLM" -- which fails open to the quiet channel.
//
// The user graduates May 2027. Summer terms are useless to them (Summer 2026 is
// happening now; Summer 2027 is after graduation), so the whole point of this
// tier is telling Fall/Winter/Spring apart from Summer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { screen, track, inUS, minYearsRequired, tooMuchExperience } from "../src/classify.js";

const high = (t) => assert.equal(screen(t), "high", `expected HIGH: ${t}`);
const no = (t) => assert.equal(screen(t), "no", `expected NO: ${t}`);
const ask = (t) => assert.equal(screen(t), null, `expected ASK-THE-LLM: ${t}`);

// --- track A: new grad -- an ALLOWLIST ------------------------------------
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

test("a bare full-time engineering title has NO entry signal -- dropped, not asked", () => {
  // This is the change: these used to escalate to the LLM and flood the channel.
  // A new-grad role practically always names itself; a plain title is mid-level.
  no("Software Engineer");
  no("Backend Engineer");
  no("Full Stack Engineer");
  no("Software Developer");
  no("Machine Learning Engineer");
  no("Software Engineer, Level III");
});

test("the aggregator feed is TRUSTED: a bare title there is kept, senior still dropped", () => {
  // The SimplifyJobs new-grad feed is curated -- a bare title is a real new-grad
  // role it just didn't restate. A direct company board gets no such trust.
  assert.equal(screen("Acme — Software Engineer"), "no", "direct board: bare title dropped");
  assert.equal(screen("Acme — Software Engineer", { trusted: true }), "maybe", "aggregator: kept, quiet");
  assert.equal(screen("Acme — Senior Software Engineer", { trusted: true }), "no", "but senior still dies");
  assert.equal(screen("Acme — Software Engineer I", { trusted: true }), "high", "a real signal is loud");
});

// --- track B: off-season internships (the new feature) ---------------------

test("off-season internships the user can actually take are HIGH", () => {
  high("Software Engineer Intern - Fall 2026");
  high("Fall 2026 Software Engineering Internship");
  high("Winter 2027 Engineering Intern");
  high("Spring 2027 Software Engineer Intern");
  high("Software Engineering Co-op - Spring 2027");
  high("Off-Cycle Software Engineering Intern");
  high("Engineering Intern, Off-Season");
});

test("a season with no year still counts -- it is almost always the next term", () => {
  high("Software Engineer Intern, Fall");
  high("Spring Software Engineering Co-op");
});

test("SUMMER internships are NO -- the user graduates May 2027", () => {
  no("Software Engineer Intern - Summer 2027");   // after graduation
  no("Summer 2026 Software Engineering Intern");  // happening right now
  no("Summer Internship, Backend Engineering");
});

test("a Summer/Fall posting survives -- it is partly an off-season term", () => {
  high("Software Engineering Intern (Summer/Fall 2026)");
});

test("internships for someone else's class year are NO", () => {
  no("Software Engineer Intern - Fall 2025");
  no("2028 Software Engineering Internship");
});

test("seniority still wins over the internship rules", () => {
  no("Senior Software Engineer Intern");
});

test("a non-engineering internship is NO", () => {
  no("Marketing Intern, Fall 2026");
});

test("an internship with NO term named is ambiguous -- ask, never drop", () => {
  ask("Software Engineer Intern");
  ask("Software Engineering Co-op");
  ask("Engineering Intern");
});

// The off-season internship firehose folds the kept term into the title
// ("Company — Title (Fall 2026)") precisely so these resolve on a regex here --
// no LLM call. This is the exact shape the `internships` adapter emits, and the
// Tesla Energy role the bot missed is the first case.
test("off-season internship firehose: the folded term drives the verdict", () => {
  high("Tesla — Software Engineer Intern - Opticaster - Energy Engineering (Fall 2026)");
  high("Tesla — Mobile App Software Engineer Intern - Energy Engineering (Fall 2026)");
  no("Tesla — Data Analyst Intern - Energy (Fall 2026)");   // off-season but not engineering
});

// --- the alert tag ---------------------------------------------------------

test("track() labels the alert so the two are never confused", () => {
  assert.equal(track("Software Engineer Intern - Fall 2026"), "internship");
  assert.equal(track("Software Engineering Co-op"), "internship");
  assert.equal(track("Software Engineer I"), "new grad");
  assert.equal(track("New Grad Software Engineer"), "new grad");
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
  // year, so the years gate could never catch it. It has to die on the title.
  assert.equal(screen("Engineering Manager I, Innovative Ad Formats"), "no");
  assert.equal(screen("Manager I, Engineering"), "no");
  assert.equal(screen("Group Product Manager, Developer Infrastructure"), "no");
  assert.equal(screen("Technical Program Manager"), "no");
  assert.equal(screen("Distinguished Engineer"), "no");
});

test("but 'manager' as a TEAM or PRODUCT name is not a manager role", () => {
  // These carry a new-grad signal, so the only thing that could drop them is the
  // manager rule mis-firing on a product/team name. It must not.
  high("Software Engineer I, Package Manager");
  high("New Grad Software Engineer, Fleet Manager Team");
});

// --- the experience gate ----------------------------------------------------
// Now that the new-grad track is a title allowlist, the only titles that still
// reach a description read are seasonless internships. The gate's job there is
// the same: catch a "5+ years of non-internship experience" line that would make
// an "intern" posting a mislabeled senior req.

test("minYearsRequired reads the years out of real posting phrasings", () => {
  assert.equal(minYearsRequired("5+ years of professional experience"), 5);
  assert.equal(minYearsRequired("8+ years of hands-on experience"), 8);
  assert.equal(minYearsRequired("3 years of software engineering experience"), 3);
  assert.equal(minYearsRequired("3-5 years of experience"), 3, "a range asks for its LOWER bound");
  assert.equal(minYearsRequired("Minimum of 4 years of relevant experience"), 4);
  assert.equal(minYearsRequired("At least 2 years of industry experience"), 2);
  assert.equal(minYearsRequired("Experience: 6+ years"), 6, "the reversed phrasing");
  assert.equal(
    minYearsRequired("2 years of experience with software development, not including internships"), 2);
});

test("minYearsRequired takes the LOWEST requirement, not the highest", () => {
  // A false negative costs a job. "1 year required, 5 preferred" is a 1-year role.
  assert.equal(
    minYearsRequired("1 year of experience required. 5+ years of experience preferred."), 1);
});

test("minYearsRequired is not fooled by years that are not a requirement", () => {
  assert.equal(minYearsRequired("Founded 3 years ago, we now serve millions."), null,
    "no experience word nearby -- a bare number of years means nothing");
  assert.equal(minYearsRequired("A 4 year degree in Computer Science"), null);
  assert.equal(minYearsRequired(""), null);
  assert.equal(minYearsRequired(undefined), null);
});

test("tooMuchExperience drops the roles that were flooding the channel", () => {
  assert.equal(tooMuchExperience("5+ years of non-internship experience required"), true);
  assert.equal(tooMuchExperience("Requires 3 years of experience building backend systems"), true);
});

test("tooMuchExperience keeps entry-level, and FAILS OPEN on anything it cannot read", () => {
  assert.equal(tooMuchExperience("1+ years of experience"), false, "a new grad can clear 1 year");
  assert.equal(tooMuchExperience("0-2 years of experience"), false);
  assert.equal(tooMuchExperience("BS in CS. Internship experience a plus."), false);
  assert.equal(tooMuchExperience(""), false, "no description -> abstain, never drop");
  assert.equal(tooMuchExperience(null), false);
});

test("an explicit new-grad description OVERRIDES its own years line", () => {
  // Real new-grad reqs do list years under "preferred". Dropping one costs a job.
  assert.equal(
    tooMuchExperience("New Grad Software Engineer. Preferred: 3+ years of experience with Go."), false);
  assert.equal(
    tooMuchExperience("For recent graduates. 2+ years of experience with distributed systems preferred."), false);
  assert.equal(
    tooMuchExperience("Entry-level role. 4 years of experience preferred but not required."), false);
});
