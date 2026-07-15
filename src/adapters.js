// Every company gets an adapter. Three tiers:
//   1. ATS adapters      — stable, public JSON. Use when possible.
//   2. Portal adapters   — undocumented endpoints the company's own SPA calls.
//                          These DRIFT. See capture.md when one breaks.
//   3. html              — last-resort fallback. Diffs job links out of raw HTML.
//
// All return: [{ id, title, location, url }]
//
// Some also return `description` (lever, ashby) because their list payload
// already contains it -- free. Everyone else describes LAZILY: see describe().

const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json,text/html",
};

async function j(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Decode the handful of HTML entities that show up in job titles (iCIMS emits
// &amp;, &#39;, &#x27; ...). Not a full decoder -- just what a title needs.
const entities = (s) =>
  String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'");

// Descriptions come back as HTML nearly everywhere. We only ever regex it, so
// flatten to text once, here.
const strip = (h) =>
  String(h || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

export const ADAPTERS = {
  // ---------- tier 1: public ATS APIs ----------
  // These ARE the company's portal. stripe.com/jobs renders from this exact
  // endpoint. No aggregator layer, no lag.

  async greenhouse(c) {
    const d = await j(`https://boards-api.greenhouse.io/v1/boards/${c.slug}/jobs`);
    return (d.jobs || []).map((x) => ({
      id: String(x.id), title: x.title,
      location: x.location?.name || "", url: x.absolute_url,
    }));
  },

  // Lever hands us the description in the LIST response, so it is free. The
  // requirements usually live in `lists` ("Requirements", "What we look for"),
  // not in the prose -- which is exactly where the years-of-experience line is.
  async lever(c) {
    const d = await j(`https://api.lever.co/v0/postings/${c.slug}?mode=json`);
    return (d || []).map((x) => ({
      id: String(x.id), title: x.text,
      location: x.categories?.location || "", url: x.hostedUrl,
      description: [x.descriptionPlain || "", ...(x.lists || []).map((l) => `${l.text} ${strip(l.content)}`)]
        .join(" ").trim(),
    }));
  },

  // Ashby's board payload carries descriptionPlain too -- also free.
  async ashby(c) {
    const d = await j(`https://api.ashbyhq.com/posting-api/job-board/${c.slug}`);
    return (d.jobs || []).map((x) => ({
      id: String(x.id), title: x.title,
      location: x.location || "", url: x.jobUrl,
      description: x.descriptionPlain || strip(x.descriptionHtml),
    }));
  },

  async smartrecruiters(c) {
    const d = await j(`https://api.smartrecruiters.com/v1/companies/${c.slug}/postings?limit=100`);
    return (d.content || []).map((x) => ({
      id: String(x.id), title: x.name,
      location: [x.location?.city, x.location?.region].filter(Boolean).join(", "),
      url: `https://jobs.smartrecruiters.com/${c.slug}/${x.id}`,
    }));
  },

  // Workday: c.host / c.tenant / c.site  (Capital One, Schwab, Salesforce, USAA...)
  async workday(c) {
    const base = `https://${c.host}/wday/cxs/${c.tenant}/${c.site}`;
    const d = await j(`${base}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appliedFacets: c.facets || {},
        limit: 20, offset: 0,
        searchText: c.searchText ?? "",
      }),
    });
    return (d.jobPostings || []).map((x) => ({
      id: String(x.bulletFields?.[0] || x.externalPath),
      title: x.title, location: x.locationsText || "",
      // Apply-URL path is usually /en-US/{site}, but *.myworkdaysite.com tenants
      // (e.g. Chewy) use /en-US/recruiting/{tenant}/{site}. c.applyPath overrides.
      url: `https://${c.host}${c.applyPath ?? `/en-US/${c.site}`}${x.externalPath}`,
      // Kept for the lazy describer below -- the detail endpoint hangs off it.
      path: x.externalPath,
    }));
  },

  // ---------- tier 2: custom company portals ----------
  // ⚠️ UNDOCUMENTED. Amazon publishes no developer API for amazon.jobs; this is
  // the endpoint their own search page calls. Same for the others. Verify each
  // against DevTools before trusting it, and expect to re-capture them
  // occasionally. The worker alerts you when an adapter starts erroring.

  async amazon(c) {
    const u = new URL("https://www.amazon.jobs/en/search.json");
    u.searchParams.set("base_query", c.query ?? "software development engineer");
    u.searchParams.set("loc_query", c.loc ?? "United States");
    u.searchParams.set("result_limit", "100");
    u.searchParams.set("sort", "recent");
    const d = await j(u.toString());
    return (d.jobs || []).map((x) => ({
      id: String(x.id_icims), title: x.title,
      location: x.location || x.normalized_location || "",
      url: `https://www.amazon.jobs${x.job_path}`,
    }));
  },

  async apple(c) {
    const d = await j("https://jobs.apple.com/api/role/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: c.query ?? "software engineer",
        filters: { postingpostLocation: c.locs || [] },
        page: 1,
        locale: "en-us",
        sort: "newest",
      }),
    });
    return (d.searchResults || []).map((x) => ({
      id: String(x.id || x.positionId),
      title: x.postingTitle,
      location: x.locations?.map((l) => l.name).join(", ") || "",
      url: `https://jobs.apple.com/en-us/details/${x.positionId}`,
    }));
  },

  async microsoft(c) {
    const u = new URL("https://gcsservices.careers.microsoft.com/search/api/v1/search");
    u.searchParams.set("q", c.query ?? "software engineer");
    u.searchParams.set("l", "en_us");
    u.searchParams.set("pg", "1");
    u.searchParams.set("pgSz", "20");
    u.searchParams.set("o", "Recent");
    const d = await j(u.toString());
    const r = d.operationResult?.result?.jobs || [];
    return r.map((x) => ({
      id: String(x.jobId), title: x.title,
      location: x.properties?.primaryLocation || "",
      url: `https://jobs.careers.microsoft.com/global/en/job/${x.jobId}`,
    }));
  },

  // Snap. Undocumented -- careers.snap.com is an SPA and this is the endpoint it
  // calls. The payload is an Elasticsearch hit list; the useful fields are on
  // `_source`, which happens to be Greenhouse-shaped. External_Posting === "1"
  // filters out internal-only reqs, which are visible in the response but not
  // applyable. Expect this one to drift; see capture.md.
  async snap() {
    const d = await j("https://careers.snap.com/api/jobs");
    return (d.body || [])
      .map((x) => x._source)
      .filter((x) => x && x.External_Posting === "1" && x.absolute_url)
      .map((x) => ({
        id: String(x.id),
        title: x.title,
        location: x.primary_location || (x.offices || []).join(", ") || "",
        url: x.absolute_url,
      }));
  },

  // Eightfold. A whole ATS FAMILY, not one company -- Netflix, Qualcomm,
  // Northrop and others all sit behind it on vanity domains. Public-ish JSON,
  // no auth. c.host is the careers hostname; c.domain is the tenant key the
  // API wants (usually the bare company domain).
  //   sort_by=timestamp gives newest-first, so this is a sliding window like
  //   Amazon and Workday -- invariant #2 (cumulative union) covers it.
  // Eightfold IGNORES `num` and hard-caps a page at 10, so we page explicitly.
  // 3 pages = the 30 newest, which is ample at a 5-min cadence -- we'd only miss
  // a job if a company posted 30+ SWE roles inside one 5-minute window.
  async eightfold(c) {
    const PAGE = 10;
    const pages = c.pages ?? 3;
    const out = [];
    for (let p = 0; p < pages; p++) {
      const u = new URL(`https://${c.host}/api/apply/v2/jobs`);
      u.searchParams.set("domain", c.domain);
      u.searchParams.set("start", String(p * PAGE));
      u.searchParams.set("num", String(PAGE));
      u.searchParams.set("query", c.query ?? "software engineer");
      u.searchParams.set("sort_by", "timestamp");
      const d = await j(u.toString());
      const got = d.positions || [];
      out.push(...got);
      if (got.length < PAGE) break;   // last page
    }
    return out.map((x) => ({
      id: String(x.id),
      title: x.name,
      location: x.location || (x.locations || []).join(", ") || "",
      url: x.canonicalPositionUrl || `https://${c.host}/careers/job/${x.id}`,
    }));
  },

  // Uber. Undocumented -- this is the POST its own careers SPA makes. It insists
  // on an x-csrf-token header but does not appear to validate the value, so a
  // dummy works. That is exactly the kind of thing that changes without notice;
  // when it breaks, re-capture per capture.md.
  async uber(c) {
    const d = await j("https://www.uber.com/api/loadSearchJobsResults?localeCode=en", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": "x" },
      body: JSON.stringify({
        params: { query: c.query ?? "software engineer", location: [{ country: "USA" }] },
        page: 0,
        limit: c.limit ?? 100,
      }),
    });
    return (d.data?.results || []).map((x) => ({
      id: String(x.id),
      title: x.title,
      location: [x.location?.city, x.location?.region, x.location?.countryName]
        .filter(Boolean).join(", "),
      url: `https://www.uber.com/global/en/careers/list/${x.id}/`,
    }));
  },

  // Oracle Recruiting Cloud (Oracle Fusion HCM). Another ATS FAMILY -- lots of
  // banks and legacy enterprises run it. c.host is the Fusion pod hostname,
  // c.site is the recruiting site number (e.g. "CX_1001"). sortBy newest-first,
  // so it's a sliding window; invariant #2 (cumulative union) covers it.
  async oracle(c) {
    const finder =
      `findReqs;siteNumber=${c.site},limit=${c.limit ?? 50}` +
      `,keyword=${encodeURIComponent(c.query ?? "software engineer")}` +
      `,sortBy=POSTING_DATES_DESC`;
    const u =
      `https://${c.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
      `?onlyData=true&expand=requisitionList.secondaryLocations,flexFieldsFacet.values` +
      `&finder=${finder}`;
    const d = await j(u, { headers: { Accept: "application/json" } });
    const list = d.items?.[0]?.requisitionList || [];
    return list.map((x) => ({
      id: String(x.Id),
      title: x.Title,
      location: x.PrimaryLocation || "",
      url: `https://${c.host}/hcmUI/CandidateExperience/en/sites/${c.site}/job/${x.Id}`,
    }));
  },

  // Gem (jobs.gem.com). GraphQL, must hit the PUBLIC path -- plain /api/graphql
  // is forbidden. c.slug is the vanity board id. extId (not id) builds the URL.
  async gem(c) {
    const d = await j("https://jobs.gem.com/api/public/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationName: "JobBoardList",
        variables: { boardId: c.slug },
        query:
          "query JobBoardList($boardId: String!){ oatsExternalJobPostings(boardId:$boardId){ jobPostings{ id extId title locations{ name } } } }",
      }),
    });
    return (d.data?.oatsExternalJobPostings?.jobPostings || []).map((x) => ({
      id: String(x.id),
      title: x.title,
      location: x.locations?.[0]?.name || "",
      url: `https://jobs.gem.com/${c.slug}/${x.extId}`,
    }));
  },

  // Phenom People (/widgets). Another FAMILY -- Chewy, RTX/Raytheon, and many
  // enterprises. One host can cover several sub-brands, so c.filter narrows to
  // one (RTX serves Raytheon + Collins + Pratt; without the filter you'd track
  // all three). c.host is the careers hostname.
  async phenom(c) {
    const d = await j(`https://${c.host}/widgets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lang: "en_us", deviceType: "desktop", country: "us",
        pageName: "search-results", ddoKey: "refineSearch",
        sortBy: "Most recent", from: 0, jobs: true, counts: false,
        all_fields: c.filter ? Object.keys(c.filter) : [],
        size: c.size ?? 50, clearAll: false, jdsource: "facets",
        pageId: "page", siteType: "external", keywords: c.query ?? "",
        global: true, selected_fields: c.filter || {},
      }),
    });
    return (d.refineSearch?.data?.jobs || []).map((x) => ({
      id: String(x.jobId),
      title: x.title,
      location: x.cityState || x.location || "",
      url: x.applyUrl,
    }));
  },

  // ByteDance. Undocumented; jobs.bytedance.com is an SPA calling this. Needs the
  // two portal-* headers. Location display defaults to Chinese -- use en_name.
  async bytedance(c) {
    const d = await j("https://jobs.bytedance.com/api/v1/search/job/posts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "portal-channel": "website",
        "portal-platform": "pc",
      },
      body: JSON.stringify({
        keyword: c.query ?? "software engineer",
        limit: c.limit ?? 50, offset: 0,
        job_category_id_list: [], tag_id_list: [], location_code_list: [],
        subject_id_list: [], recruitment_id_list: [],
      }),
    });
    return (d.data?.job_post_list || []).map((x) => ({
      id: String(x.id),
      title: x.title,
      location: x.city_info?.en_name || (x.city_list || []).map((l) => l.en_name).join(", ") || "",
      url: `https://jobs.bytedance.com/en/position/${x.id}/detail`,
    }));
  },

  // iCIMS. An ATS FAMILY -- lots of enterprises and engineering/AEC firms. The
  // main careers page is a SPA, but iCIMS still serves an "iframe" job list that
  // is plain server-rendered HTML, so we diff job links out of it (like the html
  // tier, but with a stable per-row shape). c.host is the portal host, e.g.
  // jobs-kimley-horn.icims.com. Each row puts the job id in the href and the full
  // title in the anchor's title attribute as "{id} - {Title}". Paginated by `pr`,
  // 50/page; location lives in a sibling cell we skip (empty -> US gate fails
  // open, fine for these US firms).
  async icims(c) {
    const PAGE = 50;
    const pages = c.pages ?? 3;
    const out = [];
    const seen = new Set();
    const re = /href="(https:\/\/[^"]*\/jobs\/(\d+)\/[^"]*\/job[^"]*)"[^>]*\btitle="\d+\s*-\s*([^"]+)"/gi;
    for (let p = 0; p < pages; p++) {
      const u = new URL(`https://${c.host}/jobs/search`);
      u.searchParams.set("pr", String(p));
      u.searchParams.set("in_iframe", "1");
      if (c.query) u.searchParams.set("searchKeyword", c.query);
      const r = await fetch(u.toString(), { headers: UA });
      if (!r.ok) throw new Error(`${r.status} ${u}`);
      const html = await r.text();
      let m, added = 0;
      while ((m = re.exec(html)) !== null) {
        if (seen.has(m[2])) continue;
        seen.add(m[2]);
        added++;
        out.push({ id: m[2], title: entities(m[3]).trim(), location: "", url: entities(m[1]) });
      }
      re.lastIndex = 0;
      if (added < PAGE) break;   // last page
    }
    return out;
  },

  // ---------- coverage net ----------
  // Not a company — a firehose. The SimplifyJobs new-grad repo regenerates
  // every ~30 min and covers hundreds of employers. Slower than direct polling
  // and it will never be first, but it catches the company you never thought to
  // put on your list. That's the whole point: your list is the coverage gap.
  async aggregator(c) {
    const d = await j("https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json");
    return (d || [])
      .filter((x) => x.active !== false && x.is_visible !== false)
      .slice(0, 400)
      .map((x) => ({
        id: String(x.id),
        title: `${x.company_name} — ${x.title}`,
        location: (x.locations || []).join(", "),
        url: x.url,
      }));
  },

  // ---------- tier 3: generic HTML diff ----------
  // For portals with no capturable JSON. Pulls hrefs matching a pattern out of
  // the raw page. Crude, but it notices when a link appears that wasn't there
  // before — which is all you actually need.
  //   c.url         page to fetch
  //   c.linkPattern regex with 2 capture groups: (href)(title)
  async html(c) {
    const r = await fetch(c.url, { headers: UA });
    if (!r.ok) throw new Error(`${r.status} ${c.url}`);
    const body = await r.text();
    const re = new RegExp(c.linkPattern, "gi");
    const out = [];
    let m;
    while ((m = re.exec(body)) !== null) {
      const href = m[1];
      out.push({
        id: href,
        title: (m[2] || "").replace(/<[^>]+>/g, "").trim(),
        location: "",
        url: href.startsWith("http") ? href : new URL(href, c.url).toString(),
      });
      if (out.length > 300) break;
    }
    return out;
  },
};

export async function fetchCompany(c) {
  const f = ADAPTERS[c.adapter];
  if (!f) throw new Error(`unknown adapter: ${c.adapter}`);
  return f(c);
}

// ---------- job descriptions ----------
// A title like "Software Engineer" cannot tell you whether a role wants a new
// grad or five years of non-internship experience -- that line lives in the
// description. So we fetch it. But ONLY for the jobs whose title genuinely
// can't decide (classify.js calls this exactly there): a "Senior Staff" or a
// "New Grad SWE" title is already settled and costs nothing extra.
//
// That keeps this to a handful of requests per tick instead of one per job --
// and note Greenhouse's list endpoint DOES take ?content=true, which would give
// us every description in one call and looks tempting. It returns ~7MB for a
// single large board. Per poll. Don't.
const DESCRIBERS = {
  async greenhouse(c, job) {
    const d = await j(`https://boards-api.greenhouse.io/v1/boards/${c.slug}/jobs/${job.id}`);
    return strip(d.content);
  },

  async workday(c, job) {
    if (!job.path) return "";
    const d = await j(`https://${c.host}/wday/cxs/${c.tenant}/${c.site}${job.path}`);
    return strip(d.jobPostingInfo?.jobDescription);
  },
};

// Returns the description text, or "" if we can't get one. An adapter with no
// describer (and the aggregator, which has no description at all) returns "" --
// and "" means the experience gate abstains, so the poll behaves exactly as it
// did before. Never let a missing description drop a real job, or break a poll.
export async function describe(c, job) {
  if (job.description) return job.description;   // lever, ashby: already in the payload
  const f = DESCRIBERS[c.adapter];
  if (!f) return "";
  try {
    return await f(c, job);
  } catch {
    return "";
  }
}
