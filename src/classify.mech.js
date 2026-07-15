// MECHANICAL-engineering new-grad classifier. Same role as classify.js, three
// deliberate differences:
//   1. the field is MECHANICAL, and SOFTWARE is an explicit exclude -- a SWE role
//      must never reach the mechanical tracker.
//   2. NEW GRAD ONLY. Internships are dropped (no seasons, no co-ops).
//   3. TIGHT + PURE REGEX. A title alerts only if it names both his field and an
//      entry level. There is no aggregator backstop for mechanical roles (the
//      SimplifyJobs feed is CS-only), and no ambiguous middle to escalate, so
//      there is no LLM call and no description read here at all -- the allowlist
//      IS the decision. That also means this Worker adds ~zero Anthropic cost.
//
// This file is intentionally self-contained (it shares the poll ENGINE with the
// software Worker, not the classifier) so the two allowlists are tuned
// independently. Widen coverage by adding a phrase to MECH_FIELD or ENTRY_SIGNAL.

// ---- exclusions: drop before anything else --------------------------------
// Seniority, management, and NON-target fields. The software/firmware/data
// exclusions are load-bearing: they catch hybrid titles like "Software Design
// Engineer" that would otherwise match the field allowlist on "design".
const CERTAIN_NO = [
  /\b(senior|staff|principal|lead|sr\.?|director|vp|head\s+of|architect|distinguished|fellow)\b/i,
  /\b(engineer|developer|scientist|analyst|designer|technician|specialist)\s*[-,]?\s*(ii|iii|iv|vi|v|[2-9])\b/i,
  /\bph\.?d\s+(required|only)\b/i,
  // manager roles are never a new-grad job (matched as the role noun)
  /\b(engineering|product|program|project|people|delivery|account|technical\s+program|operations)\s+manager\b/i,
  /\bmanager\s*(i{1,3}|iv|[1-9])?\s*,/i,
  /^\s*manager\b/i,
  // non-target FIELDS -- match the field WORD anywhere, so a hybrid like
  // "Software Design Engineer" is dropped even though it also says "design".
  /\b(software|firmware|full[\s-]?stack|front[\s-]?end|back[\s-]?end|devops|swe|sde)\b/i,
  /\b(data\s+scientist|machine\s+learning|deep\s+learning)\b/i,
  // never engineering
  /\b(account\s+executive|sales|recruiter|paralegal|accountant|nurse|attorney|marketing)\b/i,
];

// New grad only -- an internship of any kind is out.
const INTERN = /\b(intern|internship|co[\s-]?op)\b/i;

// ---- his field ------------------------------------------------------------
// Built from his buzzword list: the mechanical-family vocabulary that says a role
// is HIS field. Broad on purpose (there's no backstop), but narrow enough to drop
// a bare "Electrical Engineer" or "Financial Analyst". A qualifier here + an
// entry signal below = alert.
const MECH_FIELD = new RegExp(
  [
    "mechanical", "mechatronic", "electro[\\s-]?mechanical",
    "thermal", "heat\\s+transfer", "\\bhvac\\b", "cryogenic", "cooling",
    "combustion", "fire\\s+(protection|safety)", "\\benergy\\b",
    "manufacturing", "fabrication", "production", "\\bprocess\\b",
    "\\bdesign\\b", "product\\s+(design|development)", "\\bdevelopment\\s+engineer",
    "\\br\\s*&\\s*d\\b", "\\bresearch\\b", "experimental",
    "\\btest\\b", "validation", "verification",
    "reliability", "\\bquality\\b", "supplier\\s+quality", "continuous\\s+improvement",
    "controls?\\b", "automation", "robotic", "\\bmechanism",
    "hardware", "\\bequipment\\b", "facilit\\w+", "prototyp\\w*",
    "systems?\\s+(integration\\s+)?engineer", "\\bintegration\\b",
    "packaging", "\\byield\\b", "\\bmodule\\b", "field\\s+service",
    "propulsion", "powertrain", "drivetrain", "\\bfluid", "structural",
    "aerospace", "aeronautic\\w*", "astronautic\\w*", "\\bautomotive\\b",
    "\\bproduct\\s+engineer", "\\boperations\\s+engineer",
    "engineering\\s+(associate|specialist|analyst|technician)",
  ].join("|"),
  "i",
);

// ---- entry-level signal (TIGHT) -------------------------------------------
// The title must positively name an entry level -- same posture the user chose
// for the software tracker. A bare "Mechanical Engineer" (no level) is dropped.
const ENTRY_SIGNAL = [
  /\bnew\s*grad\w*/i,
  /\bgrad(uat\w+|s)?\b/i,
  /\b(junior|jr)\b/i,
  /\b(campus|early)[\s-]*(career|talent|hire)/i,
  /\bentry[\s-]?level\b/i,
  /\bassociate\b/i,                                  // Associate Mechanical Engineer
  /\b(2026|2027|class\s+of\s+(20)?2[67])\b/i,
  /\bengineer\s*(i|1)\b/i,                            // Mechanical Engineer I / 1
  /\b(design|test|controls?|product|process|systems?|development)\s+engineer\s*(i|1)\b/i,
  /\blevel\s*(1|i|one)\b/i,
  /\bl1\b/i,
  /\bapprentice(ship)?\b/i,
  /\brotational\b/i,
];

// Only the class years he can take. A 4-digit year that isn't 2026/2027 rules a
// posting out; no year is fine.
function yearsAreWrong(t) {
  const years = String(t).match(/\b20\d{2}\b/g);
  return years ? !years.some((y) => y === "2026" || y === "2027") : false;
}

// Returns "high" | "no". No "maybe": tight mode has no ambiguous middle.
export function screen(t) {
  const s = t || "";
  if (CERTAIN_NO.some((r) => r.test(s))) return "no";     // software / senior / manager / non-eng
  if (INTERN.test(s)) return "no";                        // new grad only
  if (!MECH_FIELD.test(s)) return "no";                   // not his field
  if (!ENTRY_SIGNAL.some((r) => r.test(s))) return "no";  // tight: an explicit entry level
  if (yearsAreWrong(s)) return "no";                      // "...Class of 2028"
  return "high";
}

// One track only. The engine still calls track() to tag the alert; there is no
// internship track for him, so everything is "new grad".
export function track() {
  return "new grad";
}

// No LLM, no description read -- the allowlist is the whole decision. `env` and
// `c` are unused but kept so the engine can call every profile's classify() the
// same way.
export async function classify(env, c, job) {
  return screen(job.title || "");
}
