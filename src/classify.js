// Returns "high" | "maybe" | "no".
//
// TWO tracks, because a May 2027 grad wants two different things:
//   new grad   -- full-time entry-level SWE, class of May 2027
//   off-season -- Fall 2026 / Winter / Spring 2027 internships and co-ops
//
// SUMMER internships are deliberately NOT a match. Summer 2026 is happening
// right now, and Summer 2027 lands after graduation. Neither is useful. That is
// why "intern" on its own can be neither a yes nor a no -- it depends entirely
// on the season, and when no season is named we ask, then fall open to "maybe".
//
// Posture, by track:
//   NEW GRAD  -- an ALLOWLIST. A full-time title alerts only if it positively
//     says entry-level (new grad, grad, 2027, entry level, level 1, Engineer I/1,
//     associate, apprentice, ...). A bare "Software Engineer" is dropped: in
//     practice a genuine new-grad role names itself in the title, so this costs
//     almost no real jobs and kills the mid-level flood.
//   INTERNSHIP -- still recall-first: the term is what matters, and a seasonless
//     "Software Engineer Intern" is escalated (via the description + the LLM), not
//     dropped.
//   ERRORS -- always fail open (invariant 3): an API hiccup returns "maybe".
//
// The one carve-out: the SimplifyJobs aggregator feed is new-grad-CURATED, so a
// bare title from it is a real new-grad role the feed just didn't restate --
// `trusted` keeps those. Direct company boards get no such benefit of the doubt.

import { describe } from "./adapters.js";

// Seniority / non-engineering. Applies to BOTH tracks -- kills "Senior Engineer"
// and "Account Executive" whether or not the word "intern" is present.
const CERTAIN_NO = [
  /\b(senior|staff|principal|lead|sr\.?|director|vp|head\s+of|architect|distinguished|fellow)\b/i,
  // MANAGER roles. Never a new-grad job, and the years gate can't catch them --
  // a live dry-run turned up "Engineering Manager I" whose description asks for
  // only 1 year, so it sailed through everything else.
  //
  // Matched as the ROLE NOUN, not as the bare word: "manager" also shows up as a
  // team or product ("Engineer, Package Manager"), and dropping one of those
  // would cost a real job.
  /\b(engineering|product|program|project|people|delivery|account|technical\s+program)\s+manager\b/i,
  /\bmanager\s*(i{1,3}|iv|[1-9])?\s*,/i,     // "Manager I, Engineering" / "Manager, Data"
  /^\s*manager\b/i,
  // Levelled roles: "Software Engineer II", "SDE 2", "Developer III".
  // Anchored to a role word on purpose -- a bare /\b(ii|iii|iv|v)\b/ is both too
  // greedy (matches a stray "v") and, without /i, silently misses "II" entirely.
  /\b(engineer|developer|swe|sde|scientist|analyst)\s*[-,]?\s*(ii|iii|iv|vi|v|[2-9])\b/i,
  /\bph\.?d\s+(required|only)\b/i,
  /\b(account executive|sales|recruiter|paralegal|accountant|nurse)\b/i,
];

const INTERNISH = /\b(intern|internship|co[\s-]?op)\b/i;

// The only terms a May 2027 grad can actually take. "Off-cycle" and "off-season"
// are what most companies call these when they don't name the term outright.
const USEFUL_TERM =
  /\b(fall|autumn)\s*(of\s*)?(20)?26\b|\bwinter\s*(of\s*)?(20)?2[67]\b|\bspring\s*(of\s*)?(20)?27\b|\boff[\s-]?(cycle|season)\b/i;

// A season with no year ("Fall Internship") is still worth surfacing -- the term
// is almost always the upcoming one.
const ANY_OFF_SEASON = /\b(fall|autumn|winter|spring)\b/i;

const SUMMER = /\bsummer\b/i;

// Years that rule a posting out. 2026 and 2027 are the live ones; anything else
// named explicitly is someone else's cycle.
const YEAR = /\b20\d{2}\b/g;

// The NEW-GRAD allowlist. A full-time engineering title must match one of these
// to alert -- the words the user asked for, plus close variants. Adding a phrase
// here is how you widen it; a title with none of these is treated as mid-level.
const NEWGRAD_SIGNAL = [
  /\bnew\s*grad\w*/i,                              // new grad, new graduate
  /\bgrad(uat\w+|s)?\b/i,                          // grad, grads, graduate, graduating
  /\b(junior|jr)\b/i,                              // junior / jr software engineer
  /\b(campus|early)[\s-]*(career|talent|hire)/i,   // campus hire, early career
  /\bentry[\s-]?level\b/i,
  /\bassociate\s+(software\s+)?engineer\b/i,
  /\b(2026|2027|class\s+of\s+(20)?2[67])\b/i,      // class years the user can take
  // leveled entry: Software Engineer I / Engineer 1 / SWE I / SDE 1
  /\b(software|backend|front[\s-]?end|full[\s-]?stack|systems|platform)?\s*engineer\s*(i|1)\b/i,
  /\b(swe|sde)\s*(i|1)\b/i,
  /\blevel\s*(1|i|one)\b/i,
  /\bl1\b/i,
  /\btechnology\s+(development|associate|analyst)\s+program\b/i,
  /\bapprentice(ship)?\b/i,
  /\brotational\b/i,
];

const HAS_ENG_SIGNAL = /engineer|developer|swe|sde|software|technolog|program/i;

// Only years the user can actually use.
function yearsAreWrong(t) {
  const years = t.match(YEAR);
  if (!years) return false;
  return !years.some((y) => y === "2026" || y === "2027");
}

// Which track a title belongs to. Display only -- so the alert can say whether
// it's a full-time role or a term internship. Never gates anything.
export function track(title) {
  return INTERNISH.test(title || "") ? "internship" : "new grad";
}

// A positive US signal: "United States"/"USA", or a ", XX" state abbreviation.
// The comma prefix matters -- bare two-letter matching would fire on "IN" inside
// unrelated words. Adapters that return "United States" literally (Amazon, Uber)
// match the first branch.
const US_SIGNAL =
  /\bunited states\b|\bUSA\b|\bU\.S\.A?\.?\b|,\s*(A[LKZR]|C[AOT]|DE|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|TN|TX|UT|V[AT]|W[AIVY]|DC)\b/i;

// Confident non-US: a foreign country or a major foreign city these boards
// actually return. A BLOCKLIST -- only ever used to drop, never to keep, and
// checked AFTER US_SIGNAL so a "City, XX" role with a US state always wins.
//
// RULE for adding a name: it must be UNAMBIGUOUSLY foreign. Do NOT add a city
// that is also a US city when it appears without its state -- Cambridge (MA),
// Rome (GA), Birmingham (AL), Bristol (TN), Naples (FL), Waterloo (IA). Dropping
// a real US role is the one thing this gate must never do. When in doubt add the
// COUNTRY and leave the city out: "Stuttgart, Germany" is already caught by
// "germany", and "Cambridge, UK" by "u.k." -- the city name is only needed for a
// bare "City" with no country, which is exactly the ambiguous case to avoid.
const NON_US = new RegExp(
  "\\b(" +
    [
      // North America (non-US)
      "canada", "toronto", "vancouver", "montreal", "ottawa", "ontario",
      "quebec", "calgary", "edmonton", "winnipeg", "kitchener", "mississauga",
      "mexico", "monterrey", "guadalajara", "tijuana", "juarez", "queretaro",
      "chihuahua", "saltillo", "hermosillo",
      // UK & Ireland
      "united kingdom", "england", "scotland", "wales", "u\\.?k\\.?", "london",
      "manchester", "edinburgh", "glenrothes", "fife", "glasgow", "sheffield",
      "coventry", "derby", "ireland", "dublin", "cork", "limerick", "galway",
      // Germany
      "germany", "berlin", "munich", "stuttgart", "frankfurt", "cologne",
      "hamburg", "dresden", "leipzig", "regensburg", "nuremberg", "n[uü]rnberg",
      "d[uü]sseldorf", "wolfsburg", "ingolstadt", "hannover", "dortmund",
      // France, Benelux
      "france", "paris", "toulouse", "grenoble", "lyon", "bordeaux", "nantes",
      "netherlands", "amsterdam", "eindhoven", "veldhoven", "rotterdam",
      "belgium", "brussels", "luxembourg",
      // Iberia, Italy
      "spain", "madrid", "barcelona", "bilbao", "portugal", "lisbon", "porto",
      "italy", "milan", "turin", "torino", "bologna",
      // Nordics
      "sweden", "stockholm", "gothenburg", "denmark", "copenhagen", "finland",
      "helsinki", "espoo", "norway", "oslo", "trondheim", "iceland",
      "reykjav[ií]k",
      // Central & Eastern Europe (Serbia was the mechanical tracker's miss)
      "poland", "warsaw", "krakow", "wroclaw", "gdansk", "czechia",
      "czech republic", "prague", "brno", "slovakia", "bratislava", "hungary",
      "budapest", "romania", "bucharest", "cluj", "bulgaria", "sofia", "serbia",
      "belgrade", "novi sad", "croatia", "zagreb", "slovenia", "ljubljana",
      "bosnia", "sarajevo", "north macedonia", "skopje", "ukraine", "kyiv",
      "kiev", "lviv", "belarus", "minsk", "moldova", "lithuania", "vilnius",
      "latvia", "riga", "estonia", "tallinn", "greece", "athens", "russia",
      "moscow",
      // Switzerland & Austria
      "switzerland", "zurich", "geneva", "basel", "lausanne", "austria",
      "vienna", "graz",
      // India
      "india", "bengaluru", "bangalore", "hyderabad", "pune", "mumbai",
      "gurugram", "gurgaon", "noida", "chennai", "delhi", "kolkata",
      "ahmedabad", "coimbatore", "kochi",
      // East Asia
      "china", "beijing", "shanghai", "shenzhen", "guangzhou", "suzhou", "wuxi",
      "chengdu", "xi'?an", "wuhan", "tianjin", "nanjing", "chongqing", "dalian",
      "hangzhou", "hong kong", "japan", "tokyo", "osaka", "yokohama", "nagoya",
      "kyoto", "kobe", "korea", "seoul", "suwon", "icheon", "incheon", "busan",
      "ulsan", "taiwan", "taipei", "hsinchu", "taichung", "kaohsiung", "tainan",
      // Southeast Asia & Oceania
      "singapore", "philippines", "manila", "cebu", "vietnam", "hanoi",
      "ho chi minh", "indonesia", "jakarta", "thailand", "bangkok", "malaysia",
      "kuala lumpur", "australia", "sydney", "melbourne", "brisbane", "perth",
      "new zealand", "auckland",
      // Latin America
      "brazil", "sao paulo", "argentina", "buenos aires", "colombia", "bogota",
      "chile", "peru", "costa rica", "uruguay",
      // Middle East & Africa
      "israel", "tel aviv", "haifa", "turkey", "istanbul", "ankara", "egypt",
      "cairo", "uae", "dubai", "abu dhabi", "saudi arabia", "riyadh", "jeddah",
      "qatar", "doha", "morocco", "casablanca", "tunisia", "south africa",
      "nigeria", "lagos", "kenya", "nairobi",
      // South Asia
      "pakistan", "karachi", "lahore", "bangladesh", "dhaka", "sri lanka",
      "colombo",
    ].join("|") +
    ")\\b",
  "i",
);

// The location GATE. Returns true = alert, false = drop. Fails OPEN: unknown,
// remote, or a bare US-looking city all pass. Only a confidently non-US string
// is dropped. (This makes location a gate -- see CLAUDE.md invariant #4, which
// was amended when US-only filtering was requested.)
export function inUS(location) {
  const loc = (location || "").trim();
  if (!loc) return true;              // no data -> don't miss it
  if (US_SIGNAL.test(loc)) return true;
  if (NON_US.test(loc)) return false; // Warsaw, Bengaluru, London...
  return true;                        // ambiguous ("Remote", bare city) -> keep
}

// The regex tier. Returns a verdict, or null meaning "ask the LLM".
// `trusted` (the aggregator) relaxes the new-grad allowlist -- see the posture
// note at the top of the file.
export function screen(t, { trusted = false } = {}) {
  if (CERTAIN_NO.some((r) => r.test(t))) return "no";

  if (INTERNISH.test(t)) {
    // Engineering signal FIRST. Otherwise "Marketing Intern, Fall 2026" sails
    // through on the season match alone.
    if (!HAS_ENG_SIGNAL.test(t)) return "no";
    if (yearsAreWrong(t)) return "no";                 // "Summer 2025 Intern"
    if (USEFUL_TERM.test(t)) return "high";            // "Fall 2026 SWE Intern"
    // Summer, and NOT also an off-season term. A "Summer/Fall" posting survives.
    if (SUMMER.test(t) && !ANY_OFF_SEASON.test(t)) return "no";
    if (ANY_OFF_SEASON.test(t)) return "high";         // "Spring Software Intern"
    return null;   // "Software Engineer Intern" -- no season named. Ask.
  }

  // NEW-GRAD track: an allowlist now. Engineering signal AND an entry-level word.
  if (!HAS_ENG_SIGNAL.test(t)) return "no";            // no engineering signal at all
  if (NEWGRAD_SIGNAL.some((r) => r.test(t))) {
    return yearsAreWrong(t) ? "no" : "high";           // "...Class of 2028" still dies
  }
  // No entry-level signal. A bare "Software Engineer" on a direct board is a
  // mid-level req -> drop. From the new-grad-curated aggregator it's a real role
  // the feed didn't restate -> keep, but on the quiet channel since the title
  // itself never confirmed it.
  return trusted ? (yearsAreWrong(t) ? "no" : "maybe") : "no";
}

// ---- the experience gate ---------------------------------------------------
// The #1 source of junk alerts: a posting titled plainly "Software Engineer"
// whose description asks for "5+ years of non-internship experience". The TITLE
// cannot rule that out -- so screen() returns null, the LLM sees a bare title,
// says UNSURE, and it fails open into the quiet channel. Forever.
//
// The fix is to read the description, but ONLY for that ambiguous bucket (see
// classify() below). An explicit "New Grad" title never gets here, so a stray
// "5+ years" in some boilerplate can never kill a role that says new grad.

// A new grad has zero. "1+ year" postings are still worth a look, so the gate
// only fires above this.
const MAX_YEARS = 1;

// "5+ years of experience", "3-5 years ... experience", "minimum of 4 years",
// "at least 2 years of professional experience", and the reversed "experience:
// 5+ years". The word experience must be NEARBY on purpose -- a bare "3 years"
// is just as likely to be "founded 3 years ago" or "a 3 year program".
//
// The gap may cross a colon (postings write "Experience: 6+ years") but never a
// sentence end, which would let it pair a number with an unrelated sentence.
const YEARS_RE =
  /(\d{1,2})\s*(?:\+|plus)?\s*(?:[-–]|to)?\s*\d{0,2}\s*\+?\s*years?[^.;!?]{0,50}?experien\w+|experien\w+[^.;!?]{0,40}?(\d{1,2})\s*(?:\+|plus)?\s*years?/gi;

// If the description says any of this, it is talking TO a new grad -- whatever
// else it happens to ask for. This overrides the years gate, because plenty of
// real new-grad reqs still list "2+ years" in a *preferred* section, and
// dropping one of those costs the user a job. Recall wins ties. (Invariant 3.)
//
// Note the \w* on the graduate forms: postings say "recent graduateS", and a
// \b there would refuse to match the plural -- silently disabling the override
// on the single most common way a posting says this.
const NEW_GRAD_IN_DESC =
  /\b(new\s*grad\w*|recent\s+graduate\w*|university\s+graduate\w*|college\s+graduate\w*|campus\s+hire\w*|graduating\s+(in\s+|by\s+)?(20)?2[67]|final[\s-]year|entry[\s-]level|no\s+prior\s+experience|currently\s+(enrolled|pursuing))/i;

// The LOWEST year count the posting asks for anywhere -- minimum, not maximum.
// "1 year required, 5+ preferred" is a 1-year role; taking the max would drop it.
export function minYearsRequired(text) {
  let min = null;
  for (const m of String(text || "").matchAll(YEARS_RE)) {
    const n = Number(m[1] ?? m[2]);
    if (!Number.isFinite(n) || n > 20) continue;   // 20+ is a typo or a date, not a req
    if (min === null || n < min) min = n;
  }
  return min;
}

// true = drop. Fires only on a CONFIDENT signal: an empty or unfetchable
// description returns false, so like every other gate here it FAILS OPEN.
export function tooMuchExperience(text) {
  if (!text) return false;
  if (NEW_GRAD_IN_DESC.test(text)) return false;
  const y = minYearsRequired(text);
  return y !== null && y > MAX_YEARS;
}

// The only sentences that bear on "is this a new grad role". Shipping the whole
// 12KB posting to the LLM would be 20x the tokens for the same verdict.
function requirementLines(desc) {
  if (!desc) return "";
  return String(desc)
    .split(/(?<=[.;!?])\s+/)
    .filter((s) => /\b(year|experien|degree|graduat|qualif|require|bachelor|master|phd|student|intern)\w*/i.test(s))
    .join(" ")
    .slice(0, 500);
}

const PROMPT = `You screen job titles for a US CS undergrad graduating May 2027. They want BOTH of:

(A) NEW GRAD: a full-time, entry-level software engineering role they could start after May 2027.
(B) OFF-SEASON INTERNSHIP: a software internship or co-op for Fall 2026, Winter 2026-27, or Spring 2027.

YES if the title plausibly describes either (A) or (B).
NO only if you are confident it is neither: SUMMER internships (they are graduating, so summer terms are useless), senior/staff/lead levels, roles clearly needing years of experience, PhD-only research, non-engineering roles, or a term/class year they cannot take.

Naming varies wildly. "Technology Development Program", "SDE I", "Engineer, University Graduate", "Associate Software Engineer" are all YES. "Software Engineer II" is NO. "Summer 2027 Intern" is NO. "Fall Co-op, Software" is YES. A bare "Software Engineer" or a bare "Software Engineer Intern" with no level or term is UNSURE.

If a REQUIREMENTS excerpt is given, weigh it above the title: a role asking for years of professional (non-internship) experience is NO, however junior the title sounds. An empty excerpt means we could not fetch one — judge on the title alone, and stay UNSURE rather than guessing NO.

Reply with exactly one word: YES, NO, or UNSURE. When genuinely torn, say UNSURE.

`;

async function askLLM(env, title, company, requirements) {
  const content =
    `${PROMPT}Title: ${company}: ${title}\n` +
    `Requirements (excerpt, may be empty): ${requirements || "(none available)"}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 5,
      messages: [{ role: "user", content }],
    }),
  });
  // FAIL OPEN. An API hiccup must never silently eat a real posting.
  if (!r.ok) return "maybe";
  const d = await r.json();
  const t = (d.content || []).map((b) => b.text || "").join("").trim().toUpperCase();
  if (t.startsWith("YES")) return "high";
  if (t.startsWith("NO")) return "no";
  return "maybe";
}

// `c` is the company CONFIG, not just its name -- describe() needs the adapter
// and slug to go get the posting.
export async function classify(env, c, job) {
  const t = job.title || "";
  if (!t) return "maybe";
  const company = c?.name || String(c);
  // The aggregator's feed is new-grad-curated, so a bare title from it is trusted
  // where the same title on a company's own board would be dropped as mid-level.
  const trusted = c?.adapter === "aggregator";

  const v = screen(t, { trusted });
  if (v) return v;   // the title settled it -- no description needed, no request made

  // ONLY HERE. The title is genuinely ambiguous ("Software Engineer"), which is
  // both the bucket that floods the quiet channel and the only bucket where a
  // description changes the answer. One extra request, for a handful of jobs a
  // tick. Seeding never reaches this (index.js skips classify entirely).
  const desc = await describe(c, job);
  if (tooMuchExperience(desc)) return "no";        // "5+ years, not including internships"

  // Cache the verdict per company+title, forever. Companies repost the same
  // titles endlessly, so this barely fires after week one. Keyed on the company
  // too because a bare "Software Engineer" means different things at different
  // shops -- and because the excerpt we send is now company-specific.
  //
  // The gate above runs BEFORE this on purpose: a cached "maybe" must not be
  // able to resurrect a job whose description asks for five years.
  const key = `verdict:${company}|${t}`.toLowerCase().slice(0, 200);
  const cached = await env.JOBS.get(key);
  if (cached) return cached;

  const verdict = await askLLM(env, t, company, requirementLines(desc));
  await env.JOBS.put(key, verdict);
  return verdict;
}
