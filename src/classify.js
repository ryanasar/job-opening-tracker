// Returns "high" | "no".
//
// TWO tracks, both from companies.txt only (there is no aggregator/firehose):
//   new grad   -- full-time entry-level SWE, class of May 2027
//   internship -- software internships and co-ops for any 2026/2027 term,
//                 SUMMER 2027 INCLUDED (the user asked for that explicitly)
//
// Posture, by track:
//   NEW GRAD -- an ALLOWLIST. A full-time engineering title alerts only if it
//     positively says entry-level (new grad, grad, junior, 2027, entry level,
//     level 1, Engineer I/1, associate, apprentice, ...). A bare "Software
//     Engineer" is dropped: in practice a genuine new-grad role names itself in
//     the title, so this costs almost no real jobs and kills the mid-level flood.
//   INTERN   -- the word "intern"/"internship"/"co-op" IS the entry-level signal,
//     so the gate is about FIELD, not level: it needs a software-ish word and no
//     other engineering discipline (Anduril posts "Mechanical Engineer Intern",
//     "Warhead Engineer Co-op" -- "engineer" alone would let those through).
//     Seasonless titles ("Software Engineer, Internship") alert -- with every
//     term in scope there is nothing left to ask. Wrong years (Summer 2026 is
//     over, 2028 is after graduation) and high-school / PhD programs drop.
//
// Still pure regex, no LLM call, no description fetch. The old internship track
// needed an LLM only to guess the term of a seasonless intern title, because
// summer was out; with summer in, the title is enough.
//
// The trade-off, stated plainly: there is NO aggregator backstop (the
// SimplifyJobs firehoses were removed -- only companies.txt is polled). So a
// company that titles its new-grad req plainly "Software Engineer" is MISSED
// rather than caught late on the quiet channel. Widen coverage by adding a
// phrase to NEWGRAD_SIGNAL, or a company to companies.txt -- not by loosening
// the allowlist back to fail-open, which is what flooded the channel before.

// Seniority / non-engineering. Kills "Senior Engineer" and "Account Executive".
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

// What an intern title must say to be a SOFTWARE internship. Narrower than
// HAS_ENG_SIGNAL on purpose: "program" there matches "Accelerations Programs
// Intern", which is not an engineering role.
const INTERN_SWE = /\b(software|swe|sde|developer|programmer|engineer\w*)\b/i;

// Other engineering disciplines that also say "engineer". An intern title that
// names one of these is not a software internship. Kept to words that never
// describe a software team -- "hardware", "systems" and "test" are left out
// because "Systems Software Intern" / "Software Test Intern" are real SWE roles.
const NON_SWE_DISCIPLINE =
  /\b(mechanical|electrical|industrial|manufacturing|quality|reliability|propulsion|warhead|harness|ewis|civil\s+engineer\w*|chemical|process|structural|aerospace|materials|thermal|optical|rf|analog|mixed[\s-]signal|program\s+management)\b/i;

// Programs the user can't take: high-school internships, and PhD-only ones.
const INTERN_NOT_FOR_US = /\bhigh[\s-]school\b|\bph\.?\s?d\b/i;

// A term that's already over, or that lands after graduation. Covers the
// two-digit "'26" shorthand (Vercel writes "Summer '27"), which YEAR misses.
const INTERN_DEAD_TERM =
  /\b(summer|spring)\s*(of\s*)?('|20)?26\b|('|\b20)2[89]\b/i;

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

// Which track a title belongs to. Tags the alert and stamps the tracker row;
// never gates anything.
export function track(title) {
  return INTERNISH.test(title || "") ? "internship" : "new grad";
}

// A positive US signal: "United States"/"USA", or a ", XX" state abbreviation,
// or a ", Statename" full state name (Greenhouse writes "San Francisco,
// California"). The comma prefix matters -- bare two-letter matching would fire
// on "IN" inside unrelated words, and a bare "Georgia"/"Washington" is ambiguous.
// Adapters that return "United States" literally (Amazon, Uber) match the first
// branch.
const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois",
  "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana",
  "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york",
  "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah",
  "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming",
  "district of columbia",
];
const US_SIGNAL = new RegExp(
  "\\bunited states\\b|\\bUSA\\b|\\bU\\.S\\.A?\\.?\\b" +
  "|,\\s*(A[LKZR]|C[AOT]|DE|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|TN|TX|UT|V[AT]|W[AIVY]|DC)\\b" +
  "|,\\s*(" + US_STATES.join("|") + ")\\b",
  "i",
);

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
//
// A multi-location posting ("Bellevue, Washington; ...; Vancouver, Canada") is
// judged per location and kept if ANY of them is US. Testing the joined string
// let one foreign entry drop the whole role -- the Databricks 2027 SWE intern miss.
export function inUS(location) {
  const locs = (location || "").split(/[;|\n]/).map((l) => l.trim()).filter(Boolean);
  if (!locs.length) return true;      // no data -> don't miss it
  return locs.some(oneInUS);
}

function oneInUS(loc) {
  if (US_SIGNAL.test(loc)) return true;
  if (NON_US.test(loc)) return false; // Warsaw, Bengaluru, London...
  return true;                        // ambiguous ("Remote", bare city) -> keep
}

// The whole classifier. Returns "high" | "no" -- there is no "maybe" any more:
// new grad is an allowlist, and every internship term is in scope.
export function screen(t) {
  const s = t || "";
  if (CERTAIN_NO.some((r) => r.test(s))) return "no";     // senior / manager / non-eng

  if (INTERNISH.test(s)) {
    if (!INTERN_SWE.test(s)) return "no";                 // "Accelerations Programs Intern"
    if (NON_SWE_DISCIPLINE.test(s)) return "no";          // "Mechanical Engineer Intern"
    if (INTERN_NOT_FOR_US.test(s)) return "no";           // high school / PhD
    if (INTERN_DEAD_TERM.test(s) || yearsAreWrong(s)) return "no"; // Summer 2026, 2028
    return "high";
  }

  if (!HAS_ENG_SIGNAL.test(s)) return "no";               // not an engineering role
  if (!NEWGRAD_SIGNAL.some((r) => r.test(s))) return "no"; // bare title -> mid-level
  if (yearsAreWrong(s)) return "no";                      // "...Class of 2028"
  return "high";
}

// No LLM, no description read -- the title allowlist is the whole decision, so
// this costs nothing and never fails. `env` and `c` are unused but kept so the
// engine can call every profile's classify() the same way.
//
// The one non-"high"/"no" case left: a job with NO title at all means the
// adapter's mapping broke, not that the role is uninteresting. That fails OPEN
// to the quiet channel (invariant 3) -- it's the only thing 🟡 still means.
export async function classify(env, c, job) {
  if (!job.title) return "maybe";
  return screen(job.title);
}
