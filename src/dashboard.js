// Application tracker. A private CRM for roles you've applied to -- distinct
// from the discovery pipeline (that stays Telegram-only). Same Worker, same KV,
// same ADMIN_KEY gate. New-grad vs internship split comes from track() for free.
//
// KV: one key "applications" holding an array of:
//   { id, company, title, url, location, track, status,
//     createdAt, appliedAt, updatedAt, notes, priority }
// id is a deterministic hash of company+url, so logging the same alert twice
// upserts instead of duplicating.
//
// createdAt is when the row appeared; appliedAt is when you applied. Staleness
// reads updatedAt, so nothing may touch updatedAt unless the row actually
// changed -- see the write rule in handleApi().

import { track } from "./classify.js";

// The pipeline. `kind` drives the header counts (tracked/active/offers/closed),
// `color` is the single source of truth for the pill, the card's left border and
// the kanban column -- the CSS classes below are generated from it.
// The chrome accent is azure (--acc). `applied` is deliberately INDIGO rather
// than the sky blue it used to be: a status pill sitting in the same hue as every
// button and link on the page made both harder to read. It stays unmistakably
// blue, just violet-leaning, so status and chrome never blur together.
//
// There is no "saved" stage. This is a record of what you APPLIED to; a row
// exists because you applied. normalize() maps any leftover "saved" row (and any
// other unknown status) to "applied" on read, so old data migrates itself.
// The array order is the PIPELINE order (the status menu and the kanban columns
// read it left-to-right / top-to-bottom, so it must stay the natural progression
// applied → … → ghosted).
//
// `rank` is a different thing: DISPLAY priority in the list view. Lower floats
// higher. It is not the pipeline order because the two disagree -- an Offer needs
// your attention most so it rises to the top, while the dead statuses sink, with
// Rejected pinned dead last. Change a rank to reorder the list without disturbing
// the menu or the board.
export const STATUSES = [
  { id: "applied",  label: "Applied",     kind: "active", color: "#7c8cff", rank: 4 },
  { id: "oa",       label: "OA",          kind: "active", color: "#c084fc", rank: 3 },
  { id: "phone",    label: "Phone Screen",kind: "active", color: "#22d3ee", rank: 2 },
  { id: "onsite",   label: "Onsite",      kind: "active", color: "#fbbf24", rank: 1 },
  { id: "offer",    label: "Offer",       kind: "win",    color: "#34d399", rank: 0 },
  { id: "ghosted",  label: "Ghosted",     kind: "dead",   color: "#5c646f", rank: 5 },
  { id: "rejected", label: "Rejected",    kind: "dead",   color: "#fb7185", rank: 6 },
];
const STATUS_IDS = new Set(STATUSES.map((s) => s.id));

// An Applied/OA role nobody has touched in this long needs a nudge.
export const STALE_DAYS = 14;

// FNV-1a -> base36. Deterministic id from the job identity, for dedup.
function jobId(company, url) {
  let h = 0x811c9dc5;
  const s = `${company}|${url}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Rows written before saved/priority/notes existed are missing those fields, and
// old rows have no createdAt. Fill the gaps on READ. Doing it here (not as a
// migration write) keeps the poll-path invariant honest: reads are free, writes
// are the scarce resource, so we never rewrite the blob just to reshape it.
function normalize(a) {
  const stamp = a.updatedAt || a.appliedAt || a.createdAt || new Date(0).toISOString();
  const status = STATUS_IDS.has(a.status) ? a.status : "applied";
  return {
    id: a.id,
    company: a.company || "",
    title: a.title || "",
    url: a.url || "",
    location: a.location || "",
    // Free text on purpose: "$120k", "180-200k + equity", "unknown, ask Dana".
    // Anything that tries to parse a number here will be wrong by Thursday.
    comp: a.comp || "",
    track: a.track === "internship" ? "internship" : "new grad",
    status,
    createdAt: a.createdAt || a.appliedAt || stamp,
    // Every row was applied to -- that is what the tracker is. A row left over
    // from when "saved" existed has a null appliedAt; fall back to when it was
    // created, so it lands somewhere sane on the timeline instead of nowhere.
    appliedAt: a.appliedAt || a.createdAt || stamp,
    updatedAt: stamp,
    notes: typeof a.notes === "string" ? a.notes : "",
    priority: !!a.priority,
  };
}

async function getApps(env) {
  const raw = (await env.JOBS.get("applications", "json")) || [];
  return raw.map(normalize);
}
async function putApps(env, apps) {
  await env.JOBS.put("applications", JSON.stringify(apps));
}

// ---- company name out of a posting URL -------------------------------------
// Pre-fills the add form from a pasted link. Best-effort by design: it feeds an
// editable field, so a wrong guess costs one keystroke, not a bad record.

// On these hosts the domain is the ATS, not the employer -- the employer is the
// first meaningful path segment (boards.greenhouse.io/stripe/jobs/1).
const ATS_HOST = /(greenhouse|lever\.co|ashbyhq|smartrecruiters|jobvite|workable|breezy|recruitee|teamtailor|icims|taleo|bamboohr)/i;
const ATS_NOISE = /^(jobs?|careers?|embed|board|boards|postings?|apply|o|en-us|us|job_app)$/i;
// Subdomains that are never the company: careers.stripe.com -> stripe.
const SUBDOMAIN_NOISE = new Set([
  "www", "jobs", "job", "careers", "career", "boards", "board",
  "apply", "work", "talent", "recruiting", "hire", "hiring", "my",
]);

const pretty = (s) =>
  s.replace(/[-_+]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

export function companyFromUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return "";
  }
  if (!/^https?:$/.test(u.protocol)) return "";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  // Workday encodes the tenant in the subdomain: acme.wd1.myworkdayjobs.com
  if (host.endsWith("myworkdayjobs.com")) return pretty(host.split(".")[0]);

  if (ATS_HOST.test(host)) {
    // Greenhouse's embedded board carries the tenant in ?for=
    const forParam = u.searchParams.get("for");
    if (forParam) return pretty(forParam);
    const seg = u.pathname.split("/").filter(Boolean)
      .find((p) => !ATS_NOISE.test(p) && !/^\d+$/.test(p));
    return seg ? pretty(seg) : "";
  }

  // Otherwise the company IS the domain. Take the first label that isn't a
  // generic subdomain -- first, not last, so careers.google.co.uk -> Google
  // rather than "Co".
  const label = host.split(".").slice(0, -1).find((l) => !SUBDOMAIN_NOISE.has(l));
  return label ? pretty(label) : "";
}

// ---- log from a Telegram alert: GET /applied?j=<encoded json> --------------
export async function logApplied(env, u) {
  let job;
  try {
    job = JSON.parse(u.searchParams.get("j") || "");
  } catch {
    return new Response("bad payload", { status: 400 });
  }
  const company = job.c, title = job.t, url = job.u;
  if (!company || !title || !url) return new Response("missing fields", { status: 400 });

  const id = jobId(company, url);
  const apps = await getApps(env);
  const now = new Date().toISOString();
  const existing = apps.find((a) => a.id === id);

  // Re-tap is a deliberate NO-OP: no status change, no timestamp touch, no KV
  // write. Touching updatedAt here would reset the staleness clock on a role
  // you haven't actually done anything about, which is exactly backwards.
  if (!existing) {
    apps.push({
      id, company, title, url,
      location: job.l || "",
      track: job.k || track(title),
      status: "applied",
      createdAt: now, appliedAt: now, updatedAt: now,
      notes: "", priority: false,
    });
    await putApps(env, apps);
  }

  // Tiny confirmation page with a bounce to the dashboard.
  const key = u.searchParams.get("key") || "";
  const dash = `/dashboard?key=${encodeURIComponent(key)}`;
  return html(`<div style="font:15px/1.5 ui-monospace,Menlo,monospace;background:#0a0e15;color:#d5dbe6;min-height:100vh;display:grid;place-items:center;text-align:center;padding:2rem">
    <div>
      <div style="font-size:2rem;margin-bottom:.5rem">✅</div>
      <div style="color:#6aa9ff;font-weight:700">${esc(company)}</div>
      <div style="color:#7c8798;margin:.25rem 0 1.25rem">${esc(title)}</div>
      <div style="color:#7c8798;font-size:13px">${existing ? "already tracked — left as-is" : "logged as Applied"}</div>
      <a href="${dash}" style="display:inline-block;margin-top:1.5rem;color:#06090f;background:#6aa9ff;padding:.6rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:700">Open tracker →</a>
    </div>
  </div>`);
}

// ---- JSON API --------------------------------------------------------------
// GET  /api/apps            list
// GET  /api/parse?url=      company name guessed from a posting URL
// POST /api/import          merge a backup back in
// POST /api/app             add (or restore a deleted row verbatim)
// PATCH /api/app            status / notes / track / priority
// DELETE /api/app           remove
export async function handleApi(env, req, u) {
  if (req.method === "GET") {
    if (u.pathname === "/api/apps") return Response.json(await getApps(env));
    if (u.pathname === "/api/parse") {
      const raw = u.searchParams.get("url") || "";
      return Response.json({ url: raw, company: companyFromUrl(raw) });
    }
    return new Response("not found", { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const now = new Date().toISOString();

  if (u.pathname === "/api/import" && req.method === "POST") {
    const incoming = Array.isArray(body) ? body : body.apps;
    if (!Array.isArray(incoming)) return new Response("expected an array of applications", { status: 400 });

    const byId = new Map((await getApps(env)).map((a) => [a.id, a]));
    let merged = 0;
    for (const row of incoming) {
      if (!row || !row.company || !row.title) continue;
      const id = row.id || jobId(row.company, row.url || row.title);
      const next = normalize({ ...row, id });
      const cur = byId.get(id);
      // Newest updatedAt wins, so restoring an old backup can't silently roll a
      // live application back to Applied.
      if (cur && new Date(next.updatedAt) <= new Date(cur.updatedAt)) continue;
      byId.set(id, next);
      merged++;
    }
    const apps = [...byId.values()];
    if (merged) await putApps(env, apps);
    return Response.json(apps);
  }

  if (u.pathname !== "/api/app") return new Response("not found", { status: 404 });
  const apps = await getApps(env);

  if (req.method === "POST") {
    const { company, title } = body;
    if (!company || !title) return new Response("company and title required", { status: 400 });

    // An id in the body means this is an undo-restore of a row we just deleted:
    // keep its history (status, dates, notes) instead of filing it fresh.
    const id = body.id || jobId(company, body.url || title);
    const existing = apps.find((a) => a.id === id);
    if (existing) return Response.json(existing);

    const status = STATUS_IDS.has(body.status) ? body.status : "applied";
    const row = normalize({
      ...body, id, status,
      createdAt: body.createdAt || now,
      appliedAt: body.appliedAt || now,
      updatedAt: body.updatedAt || now,
    });
    apps.push(row);
    await putApps(env, apps);
    return Response.json(row);
  }

  if (req.method === "PATCH") {
    const a = apps.find((x) => x.id === body.id);
    if (!a) return new Response("not found", { status: 404 });

    // Diff before writing. KV writes are the scarce resource (invariant 1), and
    // the UI fires a PATCH on every menu pick -- including picking the status a
    // row is already in. A no-op must cost a read, not a write.
    let changed = false;
    if (body.status && STATUS_IDS.has(body.status) && body.status !== a.status) {
      a.status = body.status;
      changed = true;
    }

    // Editable text. company and title are the identity of the row, so they may
    // be corrected but never blanked. `id` deliberately does NOT move with them:
    // it is a hash of the ORIGINAL company+url and is what the Telegram
    // "Log as applied" link re-taps against, so recomputing it here would make an
    // old alert file a duplicate instead of finding this row.
    for (const f of ["company", "title", "url", "location", "comp", "notes"]) {
      if (typeof body[f] !== "string") continue;
      const v = f === "company" || f === "title" ? body[f].trim() : body[f];
      if (!v && (f === "company" || f === "title")) {
        return new Response(`${f} cannot be empty`, { status: 400 });
      }
      if (v !== a[f]) { a[f] = v; changed = true; }
    }

    if ((body.track === "internship" || body.track === "new grad") && body.track !== a.track) { a.track = body.track; changed = true; }
    if (typeof body.priority === "boolean" && body.priority !== a.priority) { a.priority = body.priority; changed = true; }
    if (!changed) return Response.json(a);

    a.updatedAt = now;
    await putApps(env, apps);
    return Response.json(a);
  }

  if (req.method === "DELETE") {
    const next = apps.filter((x) => x.id !== body.id);
    if (next.length !== apps.length) await putApps(env, next);
    return Response.json({ ok: true });
  }

  return new Response("method not allowed", { status: 405 });
}

// ---- the dashboard page ----------------------------------------------------
// `owner` is the name on the wordmark -- passed per Worker (RYAN / JOSH) so the
// shared page brands itself to whoever it belongs to.
export async function renderDashboard(env, key, owner = "RYAN") {
  const apps = await getApps(env);
  return html(PAGE(apps, key, { statuses: STATUSES, staleDays: STALE_DAYS }, owner));
}

// ---------------------------------------------------------------------------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// no-store, and it matters: the page embeds your applications inline as JSON, so
// a cached copy is stale DATA, not just stale markup. (It also means a UI change
// shows up on the next reload instead of whenever the browser feels like it.)
const html = (body) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

const statusOptions = STATUSES.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");

function PAGE(apps, key, cfg, owner) {
  const who = esc(owner || "RYAN");
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${who.toLowerCase()} 2027 recruiting</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>${CSS}${STATUS_CSS}</style>
</head><body>
<div class="grain"></div>
<header>
  <div class="wordmark"><span class="dot"></span>${who}<span class="slash">//</span>2027<span class="sub">RECRUITING</span></div>
  <div class="statbar" id="stats"></div>
</header>
<main>
  <div class="controls">
    <div class="segmented" id="trackFilter">
      <button data-v="all" class="on">All</button>
      <button data-v="new grad">New Grad <em data-count="new grad">0</em></button>
      <button data-v="internship">Internships <em data-count="internship">0</em></button>
    </div>
    <input id="search" type="search" placeholder="filter…  /" autocomplete="off">
    <select id="fStatus" title="filter by status"><option value="all">any status</option>${statusOptions}</select>
    <select id="fLoc" title="filter by location"><option value="all">any location</option></select>
    <select id="sort" title="sort">
      <option value="updated">last updated</option>
      <option value="applied">applied date</option>
      <option value="company">company</option>
    </select>
    <div class="segmented" id="viewToggle">
      <button data-v="list" class="on">List</button>
      <button data-v="board">Board</button>
    </div>
    <div class="spacer"></div>
    <input id="paste" placeholder="paste a job URL…" autocomplete="off">
    <button id="addBtn" class="add">+ Add <kbd>n</kbd></button>
    <button id="exportBtn" class="add ghost">Export</button>
    <label class="add ghost" for="importFile">Import</label>
    <input id="importFile" type="file" accept="application/json,.json" hidden>
  </div>
  <form id="addForm" hidden autocomplete="off">
    <input name="company" placeholder="Company" list="companies" required>
    <input name="title" placeholder="Role title" required>
    <input name="url" placeholder="Apply URL (optional)">
    <input name="location" placeholder="Location (optional)" list="locations">
    <input name="comp" placeholder="Comp (optional)">
    <select name="track"><option value="new grad">New Grad</option><option value="internship">Internship</option></select>
    <button type="submit">Save</button>
    <button type="button" id="addCancel" class="ghost">Cancel <kbd>esc</kbd></button>
  </form>
  <datalist id="companies"></datalist>
  <datalist id="locations"></datalist>
  <div id="board"></div>
  <p class="empty" id="empty" hidden></p>
</main>
<div id="menu" class="menu" hidden></div>
<div id="toast" class="toast" hidden></div>
<script>
const DATA = ${JSON.stringify(apps)};
const KEY = ${JSON.stringify(key)};
const CFG = ${JSON.stringify(cfg)};
(function(DATA, KEY, CFG){${CLIENT_JS}})(DATA, KEY, CFG);
</script>
</body></html>`;
}

// Runs in the browser. Shipped as a STRING, not a bundled function -- if this
// were a real function, esbuild's keepNames transform would inject __name()
// calls that reference a bundle-level helper, and .toString() would serialize
// those references into the page where __name doesn't exist (page goes dead).
// A string is emitted verbatim. Keep it backtick-free and ${}-free (it lives in
// a template literal) -- use "+"-concatenation for any HTML it builds.
const CLIENT_JS = String.raw`
function clientMain(DATA, KEY, CFG) {
  const $ = (s, r) => (r || document).querySelector(s);
  const SM = Object.fromEntries(CFG.statuses.map((s) => [s.id, s]));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const board = $("#board");
  const openNotes = new Set();          // survives re-render
  const openEdit = new Set();           // ditto
  let fTrack = "all", fStatus = "all", fLoc = "all", q = "";

  // view + sort are a UI preference, not data -- localStorage, not KV.
  const PREFS = "jobwatch.prefs";
  const prefs = { view: "list", sort: "updated" };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS) || "{}");
    // Validate: a junk value here would otherwise reach a querySelector below
    // and throw before anything renders.
    if (saved.view === "board" || saved.view === "list") prefs.view = saved.view;
    if (["updated", "applied", "company"].includes(saved.sort)) prefs.sort = saved.sort;
  } catch (e) {}
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch (e) {} };

  async function api(method, body, path) {
    const r = await fetch((path || "/api/app") + "?key=" + encodeURIComponent(KEY), {
      method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) { toast("save failed (" + r.status + ") — reload"); throw new Error(String(r.status)); }
    return r.json();
  }

  // ---- time ----------------------------------------------------------------
  const DAY = 86400000;
  const daysSince = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  function rel(iso) {
    if (!iso) return "";
    const d = daysSince(iso);
    if (d <= 0) return "today";
    if (d === 1) return "1d ago";
    if (d < 30) return d + "d ago";
    if (d < 365) return Math.floor(d / 30) + "mo ago";
    return Math.floor(d / 365) + "y ago";
  }
  // Only in-flight-but-waiting states go stale. Onsite/phone are ongoing, and a
  // rejection is not something you follow up on.
  const isStale = (a) =>
    (a.status === "applied" || a.status === "oa") && daysSince(a.updatedAt) >= CFG.staleDays;

  // ---- header counts, derived from status kind ------------------------------
  function renderStats() {
    const n = (kind) => DATA.filter((a) => (SM[a.status] || {}).kind === kind).length;
    const cell = (v, l, c) => '<div class="stat"><b style="color:' + c + '">' + v + '</b><span>' + l + '</span></div>';
    $("#stats").innerHTML =
      cell(DATA.length, "tracked", "#d6dbe3") +
      cell(n("active"), "active", SM.applied.color) +
      cell(n("win"), "offers", SM.offer.color) +
      cell(n("dead"), "closed", "#8a939f");
  }

  // ---- cards ---------------------------------------------------------------
  // The edit panel. Everything on a card is editable after the fact -- you
  // usually log a role from a Telegram alert (which carries no comp, and often
  // no location) and learn the rest later, from the recruiter.
  function editPanel(a) {
    // company and location autocomplete off what you've already typed elsewhere --
    // "New York, NY" and "New York, NY " are two locations to the filter, and you
    // only find that out when the location dropdown has both in it.
    const LISTS = { company: "companies", location: "locations" };
    const f = (name, label, val) =>
      '<label><span>' + label + '</span>' +
      '<input name="' + name + '" value="' + esc(val) + '"' +
      (LISTS[name] ? ' list="' + LISTS[name] + '"' : "") +
      (name === "company" || name === "title" ? " required" : "") + '></label>';
    return '<form class="edit" data-id="' + a.id + '">' +
      f("company", "company", a.company) +
      f("title", "role", a.title) +
      f("location", "loc", a.location) +
      f("comp", "comp", a.comp) +
      f("url", "link", a.url) +
      '<label><span>track</span><select name="track">' +
        '<option value="new grad"' + (a.track === "new grad" ? " selected" : "") + '>New Grad</option>' +
        '<option value="internship"' + (a.track === "internship" ? " selected" : "") + '>Internship</option>' +
      '</select></label>' +
      '<div class="editbtns">' +
        '<button type="submit">Save</button>' +
        '<button type="button" class="ghost" data-act="editcancel">Cancel</button>' +
      '</div>' +
    '</form>';
  }

  // The track is the other axis you scan by, and it is NOT a status -- so it can't
  // reuse the status hue or the left border. It gets its own badge, and internship
  // cards carry a DASHED outline where new-grad cards are solid: a term role vs a
  // permanent one, legible at a glance and in any column, with no new colour.
  const trackClass = (a) => (a.track === "internship" ? "tk-int" : "tk-ng");
  const trackBadge = (a, short) =>
    a.track === "internship"
      ? '<span class="tag int">' + (short ? "INT" : "INTERNSHIP") + '</span>'
      : '<span class="tag ng">' + (short ? "NG" : "NEW GRAD") + '</span>';

  // compact = the board view: the column already tells you the status, and a
  // kanban card you are dragging only needs to be identifiable. Company, track,
  // role. Nothing else. (Notes/edit/apply live on the card in list view.)
  function card(a, { draggable = false, compact = false } = {}) {
    const s = SM[a.status] || SM.applied;
    const open = openNotes.has(a.id);
    const editing = openEdit.has(a.id);
    const stale = isStale(a);
    const cls = "card st-" + a.status + " " + trackClass(a) + (a.priority ? " pri" : "") +
      (compact ? " compact" : "");

    if (compact) {
      return '<article class="' + cls + '" data-id="' + a.id + '"' +
          (draggable ? ' draggable="true"' : "") + '>' +
        '<div class="cardhead">' +
          '<button class="star" data-act="star" title="pin to the top">' + (a.priority ? "★" : "☆") + '</button>' +
          '<span class="co">' + esc(a.company) + '</span>' +
          trackBadge(a, true) +
        '</div>' +
        '<div class="role" title="' + esc(a.title) + '">' + esc(a.title) + '</div>' +
      '</article>';
    }

    // EVERY row is always rendered, empty ones as a dim dash. A card with no comp
    // must be exactly as tall as a card with one, or the grid goes ragged and the
    // eye can't scan down a column. Optional fields reserve their space.
    const field = (k, v, c) =>
      '<dt>' + k + '</dt><dd class="' + (v ? c || "" : "none") + '">' + (v || "—") + '</dd>';

    return '<article class="' + cls + '" data-id="' + a.id + '"' +
        (draggable ? ' draggable="true"' : "") + '>' +
      '<div class="cardhead">' +
        '<button class="star" data-act="star" title="pin to the top">' + (a.priority ? "★" : "☆") + '</button>' +
        '<span class="co">' + esc(a.company) + '</span>' +
        trackBadge(a, false) +
        '<button class="edit-btn' + (editing ? " on" : "") + '" data-act="edit" title="edit">✎</button>' +
        '<button class="del" data-act="del" title="delete">✕</button>' +
      '</div>' +
      '<div class="role" title="' + esc(a.title) + '">' + esc(a.title) + '</div>' +
      '<dl class="fields">' +
        field("loc", esc(a.location), "loc") +
        field("comp", esc(a.comp), "comp") +
        field("applied", rel(a.appliedAt)) +
        field("updated", rel(a.updatedAt) +
          (stale ? ' <span class="stale" title="no movement in ' + CFG.staleDays +
                   '+ days — follow up">stale</span>' : ""), "quiet") +
      '</dl>' +
      (editing ? editPanel(a) : "") +
      '<div class="row">' +
        '<button class="pill st-' + a.status + '" data-act="status">' + esc(s.label) + '</button>' +
        (a.url ? '<a class="ext" href="' + esc(a.url) + '" target="_blank" rel="noopener">apply ↗</a>' : "") +
        '<button class="notesbtn' + (open ? " on" : "") + '" data-act="notes">notes' +
          '<i class="ndot"' + (a.notes ? "" : " hidden") + '></i></button>' +
      '</div>' +
      (open ? '<textarea class="notes" data-id="' + a.id + '" rows="4" ' +
        'placeholder="referral · recruiter · next steps">' + esc(a.notes) + '</textarea>' : "") +
    '</article>';
  }

  // ---- filter + sort -------------------------------------------------------
  function visible(ignoreTrack) {
    const t = q.trim().toLowerCase();
    return DATA.filter((a) =>
      (ignoreTrack || fTrack === "all" || a.track === fTrack) &&
      (fStatus === "all" || a.status === fStatus) &&
      (fLoc === "all" || (a.location || "") === fLoc) &&
      (!t || [a.company, a.title, a.location, a.comp, a.notes]
        .join(" ").toLowerCase().includes(t)));
  }

  const rankOf = (a) => { const s = SM[a.status]; return s && s.rank != null ? s.rank : 99; };

  function cmp(a, b) {
    // Pinned always floats, inside whatever section or column it lives in.
    if (!!b.priority !== !!a.priority) return b.priority ? 1 : -1;
    // Then STATUS priority: Offer at the top, the dead statuses at the bottom,
    // Rejected dead last. This is the primary order in the list view -- the sort
    // dropdown below is the tiebreak WITHIN a status. (In the board view every
    // card in a column shares a status, so rank is a no-op there, as intended.)
    if (rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b);
    if (prefs.sort === "company") return a.company.localeCompare(b.company) || a.title.localeCompare(b.title);
    const key = prefs.sort === "applied" ? (x) => x.appliedAt || x.createdAt : (x) => x.updatedAt;
    return new Date(key(b)) - new Date(key(a));
  }

  // ---- views ---------------------------------------------------------------
  function listView(list) {
    const sect = (title, rows) => !rows.length ? "" :
      '<section><h2>' + title + ' <em>' + rows.length + '</em></h2>' +
      '<div class="grid">' + rows.sort(cmp).map((a) => card(a)).join("") + '</div></section>';
    let out = "";
    if (fTrack !== "internship") out += sect("New Grad", list.filter((a) => a.track === "new grad"));
    if (fTrack !== "new grad") out += sect("Internships", list.filter((a) => a.track === "internship"));
    return out;
  }

  function boardView(list) {
    return '<div class="kanban">' + CFG.statuses.map((s) => {
      const col = list.filter((a) => a.status === s.id).sort(cmp);
      return '<div class="col st-' + s.id + '" data-col="' + s.id + '">' +
        '<h3><i></i>' + esc(s.label) + '<em>' + col.length + '</em></h3>' +
        '<div class="colbody">' +
          (col.length
            ? col.map((a) => card(a, { draggable: true, compact: true })).join("")
            : '<p class="colempty">drop here</p>') +
        '</div></div>';
    }).join("") + '</div>';
  }

  function render() {
    renderStats();
    syncOptions();
    const list = visible(false);
    board.innerHTML = prefs.view === "board" ? boardView(list) : listView(list);

    document.querySelectorAll("#trackFilter em[data-count]").forEach((em) => {
      em.textContent = visible(true).filter((a) => a.track === em.dataset.count).length;
    });

    const empty = $("#empty");
    empty.hidden = list.length > 0;
    empty.innerHTML = DATA.length
      ? 'Nothing matches this filter.'
      : 'No applications yet. Tap <b>✅ Log as applied</b> on a Telegram alert, or press <kbd>n</kbd> to add a role.';
  }

  // Company autocomplete + the location filter both come from the data, so they
  // have to be rebuilt when it changes -- but only when the option set actually
  // differs, or we would clobber the select the user is mid-interaction with.
  let optSig = "";
  function syncOptions() {
    const companies = [...new Set(DATA.map((a) => a.company).filter(Boolean))].sort();
    const locs = [...new Set(DATA.map((a) => a.location).filter(Boolean))].sort();
    const sig = companies.join("|") + "##" + locs.join("|");
    if (sig === optSig) return;
    optSig = sig;
    $("#companies").innerHTML = companies.map((c) => '<option value="' + esc(c) + '">').join("");
    // Same list feeds the location FILTER (a select) and the location INPUTS on
    // the add form and every edit panel (a datalist), so a location you've used
    // before is one keystroke away instead of retyped slightly differently.
    $("#locations").innerHTML = locs.map((l) => '<option value="' + esc(l) + '">').join("");
    const sel = $("#fLoc");
    if (!locs.includes(fLoc)) fLoc = "all";
    sel.innerHTML = '<option value="all">any location</option>' +
      locs.map((l) => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join("");
    sel.value = fLoc;
  }

  // ---- mutations -----------------------------------------------------------
  async function setStatus(id, status) {
    const a = DATA.find((x) => x.id === id);
    closeMenu();
    if (!a || a.status === status) return;
    a.status = status;                                   // optimistic
    a.updatedAt = new Date().toISOString();
    render();
    Object.assign(a, await api("PATCH", { id: id, status: status }));   // server stamps win
  }

  async function toggleStar(id) {
    const a = DATA.find((x) => x.id === id);
    if (!a) return;
    a.priority = !a.priority;
    a.updatedAt = new Date().toISOString();
    render();
    Object.assign(a, await api("PATCH", { id: id, priority: a.priority }));
  }

  async function del(id) {
    const i = DATA.findIndex((x) => x.id === id);
    if (i < 0) return;
    const gone = DATA[i];
    DATA.splice(i, 1);
    render();
    await api("DELETE", { id: id });
    // Undo restores the row verbatim -- id, status, dates, notes -- because POST
    // takes a full record back. No confirm dialog needed.
    toast("deleted " + gone.company, "undo", async () => {
      const back = await api("POST", gone);
      if (!DATA.find((x) => x.id === back.id)) DATA.push(back);
      render();
    });
  }

  async function saveNotes(ta) {
    const a = DATA.find((x) => x.id === ta.dataset.id);
    if (!a || a.notes === ta.value) return;              // no write without a change
    a.notes = ta.value;
    a.updatedAt = new Date().toISOString();
    // Patch the dot in place instead of re-rendering: a blur triggered by a
    // click elsewhere would rip the node out from under that click.
    const dot = board.querySelector('.card[data-id="' + a.id + '"] .ndot');
    if (dot) dot.hidden = !a.notes;
    Object.assign(a, await api("PATCH", { id: a.id, notes: a.notes }));
  }

  // ---- status menu ---------------------------------------------------------
  const menu = $("#menu");
  let menuFor = null;
  function openMenu(btn, id) {
    menuFor = id;
    const cur = (DATA.find((x) => x.id === id) || {}).status;
    menu.innerHTML = CFG.statuses.map((s) =>
      '<button class="mi st-' + s.id + (s.id === cur ? " on" : "") + '" data-s="' + s.id + '">' +
      '<i></i>' + esc(s.label) + '</button>').join("");
    menu.hidden = false;
    const r = btn.getBoundingClientRect();
    const h = menu.offsetHeight, w = menu.offsetWidth;
    menu.style.top = (r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + "px";
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  }
  function closeMenu() { menu.hidden = true; menuFor = null; }
  menu.addEventListener("click", (e) => {
    const b = e.target.closest(".mi");
    if (b && menuFor) setStatus(menuFor, b.dataset.s);
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="status"]')) closeMenu();
  });
  addEventListener("scroll", () => { if (!menu.hidden) closeMenu(); }, true);

  // ---- toast ---------------------------------------------------------------
  let toastTimer;
  function toast(msg, label, fn) {
    const t = $("#toast");
    t.innerHTML = '<span>' + esc(msg) + '</span>';
    if (label) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => { clearTimeout(toastTimer); t.hidden = true; fn(); });
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  // ---- card events (delegated: cards are rebuilt on every render) -----------
  board.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.closest(".card").dataset.id;
    const act = btn.dataset.act;
    if (act === "status") { menu.hidden || menuFor !== id ? openMenu(btn, id) : closeMenu(); }
    else if (act === "star") toggleStar(id);
    else if (act === "del") del(id);
    else if (act === "notes") {
      openNotes.has(id) ? openNotes.delete(id) : openNotes.add(id);
      render();
      const ta = board.querySelector('textarea.notes[data-id="' + id + '"]');
      if (ta) ta.focus();
    }
    else if (act === "edit") {
      openEdit.has(id) ? openEdit.delete(id) : openEdit.add(id);
      render();
      const inp = board.querySelector('form.edit[data-id="' + id + '"] input[name=location]');
      if (inp) inp.focus();   // location is the field you're usually here to fill
    }
    else if (act === "editcancel") { openEdit.delete(id); render(); }
  });

  // Save an edit. Only the fields that actually changed are sent, so a PATCH that
  // touches nothing stays a no-op server-side (and costs no KV write).
  board.addEventListener("submit", async (e) => {
    const form = e.target.closest("form.edit");
    if (!form) return;
    e.preventDefault();
    const id = form.dataset.id;
    const a = DATA.find((x) => x.id === id);
    if (!a) return;

    const patch = { id: id };
    for (const [k, v] of new FormData(form)) {
      if (String(v) !== String(a[k] == null ? "" : a[k])) patch[k] = String(v);
    }
    openEdit.delete(id);
    if (Object.keys(patch).length === 1) return render();   // nothing changed

    Object.assign(a, patch);                                 // optimistic
    render();
    Object.assign(a, await api("PATCH", patch));
    render();                                                // server stamps updatedAt
  });
  // blur does not bubble -- capture it.
  board.addEventListener("blur", (e) => {
    if (e.target.classList && e.target.classList.contains("notes")) saveNotes(e.target);
  }, true);

  // ---- kanban drag/drop ----------------------------------------------------
  board.addEventListener("dragstart", (e) => {
    const c = e.target.closest(".card");
    if (!c) return;
    e.dataTransfer.setData("text/plain", c.dataset.id);
    e.dataTransfer.effectAllowed = "move";
    c.classList.add("dragging");
  });
  board.addEventListener("dragend", () => {
    board.querySelectorAll(".dragging").forEach((c) => c.classList.remove("dragging"));
    board.querySelectorAll(".col.over").forEach((c) => c.classList.remove("over"));
  });
  board.addEventListener("dragover", (e) => {
    const col = e.target.closest(".col");
    if (!col) return;
    e.preventDefault();                                  // required to allow a drop
    e.dataTransfer.dropEffect = "move";
    col.classList.add("over");
  });
  board.addEventListener("dragleave", (e) => {
    const col = e.target.closest(".col");
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("over");
  });
  board.addEventListener("drop", (e) => {
    const col = e.target.closest(".col");
    if (!col) return;
    e.preventDefault();
    col.classList.remove("over");
    const id = e.dataTransfer.getData("text/plain");
    if (id) setStatus(id, col.dataset.col);
  });

  // ---- controls ------------------------------------------------------------
  $("#trackFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("#trackFilter .on").classList.remove("on"); b.classList.add("on");
    fTrack = b.dataset.v; render();
  });
  $("#viewToggle").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("#viewToggle .on").classList.remove("on"); b.classList.add("on");
    prefs.view = b.dataset.v; savePrefs(); render();
  });
  $("#search").addEventListener("input", (e) => { q = e.target.value; render(); });
  $("#fStatus").addEventListener("change", (e) => { fStatus = e.target.value; render(); });
  $("#fLoc").addEventListener("change", (e) => { fLoc = e.target.value; render(); });
  $("#sort").addEventListener("change", (e) => { prefs.sort = e.target.value; savePrefs(); render(); });

  // ---- add form ------------------------------------------------------------
  const form = $("#addForm");
  function openForm() {
    form.hidden = false; $("#addBtn").hidden = true;
    if (!form.company.value) form.company.focus(); else form.title.focus();
  }
  function closeForm() { form.hidden = true; $("#addBtn").hidden = false; form.reset(); }
  $("#addBtn").addEventListener("click", openForm);
  $("#addCancel").addEventListener("click", closeForm);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    closeForm();
    const created = await api("POST", d);
    if (created && !DATA.find((x) => x.id === created.id)) DATA.push(created);
    render();
  });

  // Paste a posting URL -> pre-fill the form with the company off the domain.
  async function quickAdd(url) {
    form.url.value = url;
    openForm();
    try {
      const r = await fetch("/api/parse?key=" + encodeURIComponent(KEY) + "&url=" + encodeURIComponent(url));
      const d = r.ok ? await r.json() : {};
      if (d.company) { form.company.value = d.company; form.title.focus(); }
    } catch (err) { /* best effort -- the field is still editable */ }
  }
  const pasteBox = $("#paste");
  pasteBox.addEventListener("paste", (e) => {
    const text = ((e.clipboardData || window.clipboardData).getData("text") || "").trim();
    if (!/^https?:\/\//i.test(text)) return;
    e.preventDefault();
    pasteBox.value = "";
    quickAdd(text);
  });
  pasteBox.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const text = pasteBox.value.trim();
    if (/^https?:\/\//i.test(text)) { pasteBox.value = ""; quickAdd(text); }
  });

  // ---- export / import -----------------------------------------------------
  $("#exportBtn").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(DATA, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "jobwatch-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
    toast("exported " + DATA.length + " roles");
  });
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";                                 // so re-picking the same file fires again
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const rows = Array.isArray(parsed) ? parsed : parsed.apps;
      if (!Array.isArray(rows)) throw new Error("not a jobwatch export");
      const merged = await api("POST", { apps: rows }, "/api/import");
      DATA.length = 0;
      merged.forEach((x) => DATA.push(x));
      optSig = "";
      render();
      toast("imported — " + DATA.length + " roles tracked");
    } catch (err) {
      toast("import failed: " + err.message);
    }
  });

  // ---- keyboard ------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    const t = e.target.tagName;
    const typing = t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
    if (e.key === "Escape") {
      if (!menu.hidden) return closeMenu();
      const editing = e.target.closest && e.target.closest("form.edit");
      if (editing) { openEdit.delete(editing.dataset.id); return render(); }
      if (typing) return e.target.blur();
      if (!form.hidden) closeForm();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "n") { e.preventDefault(); openForm(); }          // Enter saves, Esc cancels
    else if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
  });

  $("#sort").value = prefs.sort;
  const vb = $("#viewToggle button[data-v=" + prefs.view + "]");
  if (vb) { $("#viewToggle .on").classList.remove("on"); vb.classList.add("on"); }
  render();
}
clientMain(DATA, KEY, CFG);
`;

// One color per status, straight from STATUSES. Everything status-colored --
// pill, card border, kanban column, menu swatch -- reads var(--sc).
const STATUS_CSS = STATUSES.map((s) => `.st-${s.id}{--sc:${s.color}}`).join("");

const CSS = `
/* Cool/azure theme. The base is tinted very slightly blue rather than neutral
   black, so the accent reads as part of the surface instead of stuck on top of
   it. --ink is the text colour that sits ON the accent (buttons, active tabs) --
   never use --txt there, it has nowhere near enough contrast on a light blue. */
:root{--bg:#0a0e15;--panel:#131924;--line:#222b3a;--txt:#d5dbe6;--dim:#7c8798;
  --acc:#6aa9ff;--acc-dim:#3d6ea8;--ink:#06090f}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
/* LOAD-BEARING. The client hides the menu, the toast and the add form with the
   hidden PROPERTY, which only takes effect through the UA rule
   [hidden]{display:none}. Any author display rule outranks that -- and
   .menu/.toast/#addForm all set display:flex. Without this override, closeMenu()
   flips .hidden but the menu stays painted over the cards, so picking a status
   looks like the page broke. It did. Don't set display on a toggled element
   without re-checking this. (Note: this whole block is a template literal --
   a stray backtick here takes the entire page down.) */
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--txt);
  font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;line-height:1.5}
.grain{position:fixed;inset:0;pointer-events:none;z-index:100;opacity:.035;
  background-image:repeating-linear-gradient(0deg,#fff 0 1px,transparent 1px 3px)}
a{color:var(--acc)}
kbd{font:inherit;font-size:10px;border:1px solid var(--line);border-radius:4px;padding:0 4px;color:var(--dim)}
header{position:sticky;top:0;z-index:20;background:rgba(10,14,21,.82);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line);padding:14px clamp(16px,4vw,40px);
  display:flex;flex-wrap:wrap;gap:16px 24px;align-items:center;justify-content:space-between}
.wordmark{font-weight:800;letter-spacing:.14em;font-size:15px;display:flex;align-items:center;gap:8px}
.wordmark .slash{color:var(--acc);margin:0 2px}
.wordmark .sub{color:var(--dim);font-weight:500;margin-left:6px}
.wordmark .dot{width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 10px var(--acc);
  animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.statbar{display:flex;gap:clamp(14px,3vw,30px)}
.stat{display:flex;flex-direction:column;line-height:1.15}
.stat b{font-size:20px;font-weight:800}
.stat span{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
main{max-width:1180px;margin:0 auto;padding:clamp(18px,4vw,36px)}

/* controls */
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:20px}
.controls .spacer{flex:1}
.segmented{display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
.segmented button{background:transparent;border:0;color:var(--dim);font:inherit;font-size:12.5px;
  padding:8px 14px;cursor:pointer;transition:.15s;display:flex;align-items:center;gap:6px}
.segmented button:hover{color:var(--txt)}
.segmented button.on{background:var(--acc);color:var(--ink);font-weight:700}
.segmented em{font-style:normal;font-size:10.5px;color:var(--dim);background:#ffffff0f;
  border-radius:999px;padding:1px 6px;font-weight:700}
.segmented button.on em{background:#06090f2e;color:var(--ink)}
#search,#paste{background:var(--panel);border:1px solid var(--line);border-radius:9px;
  color:var(--txt);font:inherit;font-size:13px;padding:9px 13px}
#search{flex:1;min-width:150px}
#paste{width:170px}
#paste::placeholder,#search::placeholder{color:#5c646f}
#search:focus,#paste:focus{outline:0;border-color:var(--acc)}
.controls select{background:var(--panel);border:1px solid var(--line);border-radius:9px;color:var(--dim);
  font:inherit;font-size:12.5px;padding:9px 10px;cursor:pointer}
.controls select:focus{outline:0;border-color:var(--acc)}
.add{background:transparent;border:1px solid var(--line);color:var(--txt);font:inherit;
  font-size:12.5px;padding:9px 14px;border-radius:9px;cursor:pointer;transition:.15s;
  display:inline-flex;align-items:center;gap:6px}
.add:hover{border-color:var(--acc);color:var(--acc)}
.add.ghost{color:var(--dim)}
.add.ghost:hover{color:var(--acc)}

/* add form */
#addForm{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:22px;padding:16px;background:var(--panel);
  border:1px solid var(--line);border-radius:12px}
#addForm input,#addForm select{flex:1;min-width:140px;background:var(--bg);border:1px solid var(--line);
  border-radius:8px;color:var(--txt);font:inherit;font-size:13px;padding:9px 12px}
#addForm input:focus,#addForm select:focus{outline:0;border-color:var(--acc)}
#addForm button{background:transparent;border:1px solid var(--line);color:var(--txt);font:inherit;
  font-size:12.5px;padding:9px 14px;border-radius:9px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
#addForm button[type=submit]{background:var(--acc);color:var(--ink);font-weight:700;border-color:var(--acc)}
#addForm .ghost{color:var(--dim)}

/* list view */
section{margin-bottom:34px}
section h2{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);
  font-weight:700;margin:0 0 14px;padding-bottom:10px;border-bottom:1px solid var(--line);
  position:sticky;top:64px;background:var(--bg);z-index:5}
section h2 em{color:var(--acc);font-style:normal;margin-left:6px}
/* No align-items:start -- cards STRETCH to fill their grid row. Combined with the
   fixed-height title and the always-rendered field rows, every card is identical
   in size whether or not you filled in the optional fields. */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
@media(min-width:900px){.grid{grid-template-columns:repeat(3,1fr)}}

/* card */
.card{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--sc,var(--line));
  border-radius:10px;padding:13px 14px;display:flex;flex-direction:column;gap:8px;
  animation:rise .4s ease both;transition:transform .15s,box-shadow .15s,border-color .15s}
.card:hover{transform:translateY(-2px);box-shadow:0 8px 22px #00000059;border-top-color:#333a45;
  border-right-color:#333a45;border-bottom-color:#333a45}
.card.pri{background:linear-gradient(180deg,#6aa9ff14,transparent 60%),var(--panel)}
.card.dragging{opacity:.4}
/* Rejected sinks to the bottom (rank 6) AND greys out: dimmed and desaturated so
   the section reads as "these are done" at a glance. Hovering brings it back to
   full for when you do want to read it. */
.card.st-rejected{opacity:.5;filter:grayscale(.55)}
.card.st-rejected:hover{opacity:1;filter:none}

/* TRACK, not status. An internship is a term role and a new grad job is not, so
   internship cards are DASHED and new-grad cards are solid -- a difference you
   can read across a whole board without decoding another colour. The status keeps
   the (solid) left border; only the other three sides carry the track. */
.card.tk-int{border-top-style:dashed;border-right-style:dashed;border-bottom-style:dashed}
.tag{font-size:8.5px;font-weight:800;letter-spacing:.12em;padding:2px 6px;border-radius:4px;
  white-space:nowrap;flex:none}
.tag.ng{color:var(--acc);background:#6aa9ff1f;border:1px solid #6aa9ff40}
.tag.int{color:#9fb0c8;background:0;border:1px dashed #4a5a72}
@keyframes rise{from{opacity:0;transform:translateY(6px)}}
.cardhead{display:flex;align-items:center;gap:6px}
.co{color:var(--acc);font-weight:700;font-size:13.5px;letter-spacing:.02em;flex:1;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.star{background:0;border:0;color:#3f4653;font:inherit;font-size:13px;cursor:pointer;padding:0;transition:.15s}
.star:hover{color:var(--acc)}
.card.pri .star{color:var(--acc)}
.edit-btn{background:0;border:0;color:#3f4653;font:inherit;cursor:pointer;font-size:12px;padding:0 2px;transition:.15s}
.edit-btn:hover,.edit-btn.on{color:var(--acc)}
.del{background:0;border:0;color:#3f4653;font:inherit;cursor:pointer;font-size:13px;padding:0 2px;transition:.15s}
.del:hover{color:#ff6b6b}

/* inline edit panel -- same key/value rhythm as the fields it replaces */
form.edit{display:grid;gap:6px;padding:10px;border:1px solid var(--line);border-radius:8px;
  background:var(--bg);animation:rise .2s ease both}
form.edit label{display:grid;grid-template-columns:46px 1fr;align-items:center;gap:8px}
form.edit label span{color:#5c646f;font-size:9px;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;text-align:right}
form.edit input,form.edit select{width:100%;background:var(--panel);border:1px solid var(--line);
  border-radius:6px;color:var(--txt);font:inherit;font-size:12px;padding:6px 8px}
form.edit input:focus,form.edit select:focus{outline:0;border-color:var(--acc)}
.editbtns{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}
.editbtns button{background:var(--acc);color:var(--ink);border:1px solid var(--acc);font:inherit;
  font-size:11px;font-weight:700;padding:5px 12px;border-radius:6px;cursor:pointer}
.editbtns .ghost{background:0;color:var(--dim);border-color:var(--line);font-weight:400}
.editbtns .ghost:hover{color:var(--txt)}
/* Exactly two lines, always: a one-line title reserves the second, a three-line
   title is clamped (full text is in the tooltip). Titles are the other thing that
   made cards different heights. */
.role{font-size:13.5px;color:var(--txt);line-height:1.35;height:2.7em;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}

/* Labelled key/value rows. A flat row of dim spans made "NYC", "3d ago" and the
   link indistinguishable; the micro-caps key says what each value IS, and the
   two dates (applied vs last moved) can no longer be mistaken for each other. */
.fields{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin:0;
  font-size:11.5px;align-items:baseline}
.fields dt{color:#5c646f;font-size:9px;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;text-align:right;white-space:nowrap}
.fields dd{margin:0;color:#aab3bf;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.fields dd.loc{color:#8fb8c9}                 /* place reads differently from time */
.fields dd.comp{color:#7fd1a8}                /* money reads differently from both */
.fields dd.quiet{color:var(--dim)}
.fields dd.none{color:#333a45}                /* an unfilled field, holding its space */
.stale{color:#e0a83c;border:1px solid #6b5220;background:#6b52201f;border-radius:999px;
  padding:0 6px;margin-left:4px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;
  font-weight:700;white-space:nowrap}
/* margin-top:auto pins the action row to the bottom edge, so a card stretched by
   a taller neighbour keeps its status pill aligned with everyone else's. */
.row{display:flex;align-items:center;gap:10px;margin-top:auto;padding-top:4px}
.row .ext{font-size:11px;white-space:nowrap;text-decoration:none;opacity:.85}
.row .ext:hover{opacity:1;text-decoration:underline}

/* status pill + menu */
.pill{border:1px solid var(--sc);border-radius:999px;font:inherit;font-size:11px;font-weight:700;
  letter-spacing:.06em;text-transform:uppercase;padding:4px 11px;cursor:pointer;
  color:var(--sc);background:color-mix(in srgb,var(--sc) 13%,transparent);transition:.15s}
.pill:hover{background:color-mix(in srgb,var(--sc) 26%,transparent)}
.notesbtn{margin-left:auto;background:0;border:0;color:#5c646f;font:inherit;font-size:11px;cursor:pointer;
  padding:2px 0;display:inline-flex;align-items:center;gap:5px;transition:.15s}
.notesbtn:hover,.notesbtn.on{color:var(--acc)}
.ndot{width:5px;height:5px;border-radius:50%;background:var(--acc);display:inline-block}
.ndot[hidden]{display:none}
textarea.notes{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--txt);
  font:inherit;font-size:12.5px;padding:9px 10px;resize:vertical}
textarea.notes:focus{outline:0;border-color:var(--acc)}
.menu{position:fixed;z-index:60;background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:5px;box-shadow:0 14px 40px #000000a6;display:flex;flex-direction:column;min-width:150px}
.mi{display:flex;align-items:center;gap:8px;background:0;border:0;color:var(--txt);font:inherit;font-size:12px;
  text-align:left;padding:7px 9px;border-radius:6px;cursor:pointer}
.mi:hover{background:#ffffff0d}
.mi.on{color:var(--sc);font-weight:700}
.mi i{width:7px;height:7px;border-radius:50%;background:var(--sc);flex:none}

/* kanban */
.kanban{display:flex;gap:10px;overflow-x:auto;padding-bottom:12px;align-items:flex-start}
.col{flex:1 0 195px;min-width:195px;border:1px dashed var(--line);border-radius:12px;padding:8px;transition:.15s}
.col.over{border-color:var(--sc);border-style:solid;background:#ffffff08}
.col h3{display:flex;align-items:center;gap:7px;margin:2px 4px 10px;font-size:10.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--dim);font-weight:700}
.col h3 i{width:7px;height:7px;border-radius:50%;background:var(--sc);flex:none}
.col h3 em{margin-left:auto;font-style:normal;color:#5c646f}
.colbody{display:flex;flex-direction:column;gap:8px;min-height:60px}
/* Compact board card: company + track + role, nothing else. The column IS the
   status, so a pill here would just repeat the header you are already reading. */
.card.compact{padding:9px 10px;gap:5px;cursor:grab}
.card.compact .co{font-size:12.5px}
.card.compact .role{font-size:12px;height:auto;-webkit-line-clamp:2;line-height:1.3}
.colempty{margin:0;padding:16px 0;text-align:center;color:#3f4653;font-size:11px}

/* toast + empty */
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:80;display:flex;align-items:center;
  gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px 14px;
  font-size:12.5px;box-shadow:0 14px 40px #000000a6;animation:rise .25s ease both}
.toast button{background:0;border:0;color:var(--acc);font:inherit;font-size:12px;font-weight:700;cursor:pointer;
  text-transform:uppercase;letter-spacing:.08em}
.empty{color:var(--dim);text-align:center;padding:60px 20px;font-size:13px}
.empty b{color:var(--acc);font-weight:700}

@media(max-width:560px){
  header{padding:12px 16px}
  .statbar{width:100%;justify-content:space-between;gap:0}
  .stat b{font-size:17px}
  section h2{top:56px}
  .grid{grid-template-columns:1fr}
  .controls .spacer{display:none}
  #paste{width:100%}
}`;
