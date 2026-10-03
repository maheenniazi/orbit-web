/*
 * websearch.js — searches big job websites (through their APIs) for the Careers page.
 *
 * Where it fits: jobs.js does the main job search (free public job lists and company
 * job boards) and also calls searchWeb() from this file to add results from three
 * "whole-web" job search services. server.js also uses status() (which sources have
 * keys) and testSources() (the "test my sources" button).
 * Key ideas for a beginner:
 *  - Each service is an API: we send a web request with our search and our API key
 *    (a secret password from .env), and it replies with JSON (job data as text).
 *  - Free plans have limited searches per month ("quota"), so results are saved in a
 *    cache (memory) for 3 hours and reused instead of searching again.
 *  - async/await lets us wait for slow network replies; Promise.all runs many at once.
 *  - Every job from every service is converted into the same shape
 *    ({ id, company, title, locations, url, ... }) so the rest of the app can treat them alike.
 */
// Whole-web job sources. Each one needs its own free key in .env:
//  SERPAPI_KEY           → Google Jobs (Google's job index: LinkedIn, Indeed, Glassdoor, company career sites, startup boards…)
//  ADZUNA_APP_ID/_KEY    → Adzuna (large aggregator, Canada + US)
//  JOOBLE_API_KEY        → Jooble (large aggregator, Canada + US)
// Results are cached so repeat searches don't use up free quotas.
// Short name for the environment variables loaded from .env.
const env = process.env;
// How long cached results stay fresh: 3 hours in milliseconds (3 × 60 min × 60 s × 1000 ms).
const TTL = 3 * 60 * 60 * 1000;
// A Map is a key → value store. Here: a text key describing a search → { at, items }.
const cache = new Map();

// The three sources. Each has a display label and a ready() function that says whether
// its key(s) are set. Boolean(x) turns any value into true/false (empty/undefined → false).
// `() => ...` is an arrow function (a short way to write a function).
const SOURCES = {
  google: { label: 'Google Jobs', ready: () => Boolean(env.SERPAPI_KEY) },
  // Adzuna needs both an app ID and an app key.
  adzuna: { label: 'Adzuna', ready: () => Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) },
  jooble: { label: 'Jooble', ready: () => Boolean(env.JOOBLE_API_KEY) },
};
// status(): returns e.g. { google: { label: 'Google Jobs', ready: true }, ... } for the UI.
// Object.entries turns the object into [key, value] pairs; .map() builds new pairs
// ([k, v] destructures each pair); Object.fromEntries turns the pairs back into an object.
const status = () => Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, { label: v.label, ready: v.ready() }]));

// Search words to use for each job category the student can tick in the Careers filters.
const ROLE = { software: 'software engineer', data: 'data', quant: 'quantitative', product: 'product', hardware: 'hardware engineer', design: 'designer', research: 'research', business: 'business analyst', psych: 'psychology' };

// Turn filters into a few focused search queries: [{ what, where, country, text }]
/*
 * buildQueries(f)
 * Input: f — the filters object from the Careers page (types, region, terms, keywords,
 * categories, locations, remote...).
 * Returns: up to 4 query objects { what, role, kindWords, where, country, text }.
 */
function buildQueries(f) {
  // Job types wanted. `f.types?.length` uses optional chaining (?.): if f.types is missing
  // it gives undefined instead of crashing. Default to internships.
  const types = f.types?.length ? f.types : ['internship'];
  // A word describing the job type: for internships "intern" (US) or "intern co-op"
  // (Canada uses "co-op"); for new-grad jobs "new grad"; otherwise nothing.
  const typeWord = types.includes('internship') ? (f.region === 'US' ? 'intern' : 'intern co-op') : types.includes('newgrad') ? 'new grad' : '';
  // The first chosen term (e.g. "Summer 2026"), or '' if none.
  const term = f.terms?.[0] || '';
  // What role(s) to search for: the student's own keywords if typed, otherwise up to 3
  // ticked categories turned into search words via ROLE (or the category name itself).
  const roles = f.keywords ? [f.keywords] : (f.categories || []).slice(0, 3).map((c) => ROLE[c] || c);
  // Make sure there's at least one (empty) role so the loop below runs.
  if (!roles.length) roles.push('');
  // Where to search: a list of { where, country } places.
  let places;
  // Specific locations chosen: use up to 2, in the US or Canada depending on the region.
  if (f.locations?.length) places = f.locations.slice(0, 2).map((l) => ({ where: l, country: f.region === 'US' ? 'us' : 'ca' }));
  // US only.
  else if (f.region === 'US') places = [{ where: '', country: 'us' }];
  // Canada and US: search both countries.
  else if (f.region === 'CA_US') places = [{ where: '', country: 'ca' }, { where: '', country: 'us' }];
  // "Anywhere": search Canada.
  else if (f.region === 'any') places = [{ where: '', country: 'ca' }];
  // Default: Canada.
  else places = [{ where: '', country: 'ca' }];
  // Remote only: replace places with a single "remote" search in the first place's country.
  if (f.remote) places = [{ where: 'remote', country: places[0].country }];
  const out = [];
  // Make one query for every role × place combination (two loops, one inside the other).
  for (const role of roles) for (const p of places) {
    // The search words: role + type word + term, skipping empty ones (.filter(Boolean)
    // removes empty strings), joined with spaces. If that's empty, just "internship".
    const what = [role, typeWord, term].filter(Boolean).join(' ').trim() || 'internship';
    // A readable place name for the query text.
    const whereText = p.where || (p.country === 'us' ? 'United States' : 'Canada');
    // Extra words where ANY may match (used by Adzuna's "what_or" option).
    const kindWords = types.includes('internship') ? 'intern internship co-op coop student' : types.includes('newgrad') ? 'graduate junior entry' : '';
    // Save the query. `text` is a human-readable version like "software engineer intern in Canada".
    out.push({ what, role, kindWords, where: p.where, country: p.country, text: `${what} in ${whereText}` });
  }
  // At most 4 queries, to protect the free quotas.
  return out.slice(0, 4);
}

// clean(s): turn a bit of HTML/text into tidy plain text.
// `s ?? ''` (nullish coalescing) uses '' only if s is null or undefined. Then, in order:
// replace every tag (<...>) with a space; replace &nbsp; or &#160; (non-breaking space
// codes) with a space; turn &amp; into &; collapse runs of whitespace into one space; trim.
const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/*
 * relTime(s)
 * What it does: converts a relative date like "3 days ago" into a timestamp
 * (milliseconds since 1970, the way JavaScript stores times).
 * Input: s — the text. Returns: a timestamp number, or 0 if it can't be understood.
 */
function relTime(s) {
  // Matches a number (optionally followed by "+", as in "30+ days ago"), spaces, a unit
  // (minute/hour/day/week/month, optionally plural), and the word "ago".
  // m[1] = the number, m[2] = the unit.
  const m = String(s || '').match(/(\d+)\+?\s*(minute|hour|day|week|month)s?\s+ago/i);
  // No match: "just posted" or "today" means now; anything else is unknown (0).
  if (!m) return /just posted|today/i.test(s) ? Date.now() : 0;
  // Milliseconds in each unit (6e4 means 6 × 10⁴ = 60,000 ms = 1 minute; a month counts as 30 days).
  // We build the object and immediately look up the unit with [ ... ].
  const mult = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2].toLowerCase()];
  // Now minus (number × unit length). The + in front of m[1] turns the text into a number.
  return Date.now() - +m[1] * mult;
}
// sleep(ms): a Promise that finishes after ms milliseconds, so `await sleep(1500)` pauses 1.5 s.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fetch JSON with a generous timeout, and retry busy/slow responses (429, 5xx, timeouts) before giving up.
/*
 * getJSON(url, opts, { timeout, retries })
 * Inputs: url; opts — fetch options (method, headers, body); an options object with
 * timeout (ms per attempt, default 30 s) and retries (extra attempts, default 2).
 * Returns (a Promise of): the parsed JSON. Throws an Error (with .status) if it fails.
 */
async function getJSON(url, opts = {}, { timeout = 30_000, retries = 2 } = {}) {
  // Remembers the most recent error, so we can throw it if every attempt fails.
  let last;
  // Try once, plus up to `retries` more times.
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Before a retry, wait a little longer each time (1.5 s, then 3 s) to give the server a break.
    if (attempt) await sleep(1500 * attempt);
    try {
      // Make the request, copying the caller's options (spread ...opts) and adding a timeout.
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
      // Read the reply as text first (so a non-JSON reply doesn't crash us).
      const raw = await r.text();
      // Try to parse it as JSON; leave d as {} if it's empty or not JSON.
      let d = {};
      try { d = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
      // Find an error message, wherever this particular API puts it: d.error as text,
      // d.error.message, d.display, d.exception, or d.message. '' if none.
      const msg = (typeof d.error === 'string' && d.error) || d.error?.message || d.display || d.exception || d.message || '';
      // Success status and no error field: return the data.
      if (r.ok && !d.error) return d;
      // Otherwise build an error: the message (or "HTTP 500"), plus " (HTTP 500)" if there
      // was a message and the status is an error code (nested template literals).
      const err = new Error(`${msg || `HTTP ${r.status}`}${msg && r.status >= 400 ? ` (HTTP ${r.status})` : ''}`);
      // Attach the status code so explain() can give advice.
      err.status = r.status;
      // Retry only things that are likely temporary
      // 429 = "too many requests", 500+ = server trouble. Anything else, or the last
      // attempt, gives up now.
      if (!(r.status === 429 || r.status >= 500) || attempt === retries) throw err;
      last = err;
    } catch (e) {
      // Errors with a non-temporary status (e.g. 401 wrong key) are passed on right away.
      if (e.status && !(e.status === 429 || e.status >= 500)) throw e;
      // Turn a timeout into a clear "timed out after 30s" error with status 'timeout';
      // keep any other error (e.g. no internet) as it is.
      last = e.name === 'TimeoutError' || e.name === 'AbortError' ? Object.assign(new Error(`timed out after ${timeout / 1000}s`), { status: 'timeout' }) : e;
      // Out of attempts: give up.
      if (attempt === retries) throw last;
    }
  }
  // Safety net (normally not reached): throw the last error.
  throw last;
}

// Plain-English explanation for the UI
/*
 * explain(src, e)
 * Inputs: src — the source's label (e.g. 'Adzuna'); e — the error.
 * Returns: the error message plus a friendly hint about what probably went wrong.
 */
function explain(src, e) {
  // The error's message as a string (or the value itself if it isn't an Error).
  const m = String(e.message || e);
  // 401/403 or words like "auth", "invalid api key", "unauthorized/unauthorised" (the [sz]
  // matches either spelling), "forbidden" → the key is probably wrong.
  if (e.status === 401 || e.status === 403 || /auth|invalid api key|unauthori[sz]ed|forbidden/i.test(m)) return `${m}. the key looks wrong. copy it again into .env (no spaces) and restart`;
  // 429 or words about limits/quota → out of free searches.
  if (e.status === 429 || /run out of searches|limit|quota/i.test(m)) return `${m}. you’ve hit this month’s free limit`;
  // Our own timeout status → the service is slow.
  if (e.status === 'timeout') return `${m}. ${src} is slow right now, try again in a minute`;
  // 500+ → the service's own servers are having problems.
  if (e.status >= 500) return `${m}. ${src}’s servers are having trouble right now (not your setup). try again later`;
  // Network-level failures (no connection, unknown host, connection reset).
  if (/fetch failed|ENOTFOUND|ECONNRESET|network/i.test(m)) return `${m}. couldn’t connect. check your internet`;
  // Otherwise just the message.
  return m;
}

// fetchers: one function per source. Each takes a query q, a number of pages, and (for
// Adzuna) the filters f, and returns (a Promise of) a list of jobs in our common shape.
const fetchers = {
  // SerpApi Google Jobs: 10 results/page, next_page_token for more. Each page = 1 search from your quota.
  async google(q, pages) {
    const out = [];
    // Token SerpApi gives us to ask for the next page ('' = first page).
    let token = '';
    for (let i = 0; i < pages; i++) {
      // URLSearchParams builds the "?a=1&b=2" part of a URL safely (escaping special characters).
      // engine = which SerpApi search; q = query text; gl = country; hl = language;
      // google_domain = google.com for the US or google.ca for Canada; api_key = our key.
      const params = new URLSearchParams({ engine: 'google_jobs', q: q.text, gl: q.country, hl: 'en', google_domain: q.country === 'us' ? 'google.com' : 'google.ca', api_key: env.SERPAPI_KEY });
      // Add the next-page token if this isn't the first page.
      if (token) params.set('next_page_token', token);
      // Fetch the results: 60-second timeout and only 1 retry (each attempt costs quota).
      const d = await getJSON(`https://serpapi.com/search.json?${params}`, {}, { timeout: 60_000, retries: 1 });
      // Go through each job result (or an empty list if there are none).
      for (const j of d.jobs_results || []) {
        // Choose the apply link: prefer one that is NOT a big job board (LinkedIn, Indeed,
        // Glassdoor, ZipRecruiter) — usually the company's own site — otherwise the first option.
        const apply = (j.apply_options || []).find((a) => a.link && !/linkedin|indeed|glassdoor|ziprecruiter/i.test(a.title || a.link)) || (j.apply_options || [])[0];
        // Convert to our common job shape:
        out.push({
          // A unique id starting with "g:" — the job_id, or company-title if missing — max 200 characters.
          id: `g:${j.job_id || `${j.company_name}-${j.title}`}`.slice(0, 200),
          // Company, job title, and the location as a list (filter(Boolean) drops it if empty).
          company: j.company_name || '', title: j.title || '', locations: [j.location].filter(Boolean),
          // Remote if Google flagged "work from home" or the location mentions "remote".
          remote: Boolean(j.detected_extensions?.work_from_home) || /remote/i.test(j.location || ''),
          // Link to apply (or Google's share link); "via" = which site it came from, without the word "via ".
          url: apply?.link || j.share_link || '', via: clean(j.via || '').replace(/^via\s+/i, ''),
          // When it was posted ("3 days ago" → timestamp), and the description cut to 4000 characters.
          posted: relTime(j.detected_extensions?.posted_at), desc: clean(j.description).slice(0, 4000),
          // e.g. "Full-time" or "Internship".
          schedule: j.detected_extensions?.schedule_type || '',
        });
      }
      // Is there a next page? If not, stop the loop early with break.
      token = d.serpapi_pagination?.next_page_token || '';
      if (!token) break;
    }
    return out;
  },
  // Adzuna: up to 50 per page
  async adzuna(q, pages, f) {
    const out = [];
    // Adzuna pages are numbered from 1.
    for (let page = 1; page <= pages; page++) {
      // Required settings: our app ID and key, 50 results per page, JSON replies.
      const params = new URLSearchParams({ app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY, results_per_page: '50', 'content-type': 'application/json' });
      // Adzuna requires every word in "what", so keep it to the role and let any intern-type word match
      if (q.role) params.set('what', q.role);
      // "what_or": any one of these words may match.
      if (q.kindWords) params.set('what_or', q.kindWords);
      // If we have neither, search with the full query words instead.
      if (!q.role && !q.kindWords) params.set('what', q.what);
      // Add the place, unless it's "remote" (Adzuna has no remote location).
      if (q.where && q.where !== 'remote') params.set('where', q.where);
      // Only jobs posted within N days, if the student set that filter.
      if (f.postedWithinDays) params.set('max_days_old', String(f.postedWithinDays));
      // The country (ca/us) and page number go in the URL path itself.
      const d = await getJSON(`https://api.adzuna.com/v1/api/jobs/${q.country}/search/${page}?${params}`);
      // Convert each result to our common shape.
      for (const j of d.results || []) out.push({
        // Id with "az:" prefix; cleaned company, title and location (as a list).
        id: `az:${j.id}`, company: clean(j.company?.display_name), title: clean(j.title), locations: [clean(j.location?.display_name)].filter(Boolean),
        // Remote if the title or description mentions it; Adzuna's redirect link; post date
        // (Date.parse turns a date string into a timestamp, or NaN → 0 if it fails).
        remote: /remote/i.test(`${j.title} ${j.description}`), url: j.redirect_url || '', via: 'Adzuna', posted: Date.parse(j.created) || 0,
        // Description; schedule like "full_time permanent" (empty parts removed); category label.
        desc: clean(j.description).slice(0, 4000), schedule: [j.contract_time, j.contract_type].filter(Boolean).join(' '), category: j.category?.label || '',
      });
      // Fewer than 50 results means this was the last page, so stop.
      if ((d.results || []).length < 50) break;
    }
    return out;
  },
  // Jooble: country-specific host (ca.jooble.org for Canada)
  async jooble(q, pages) {
    const out = [];
    // Which Jooble website to ask.
    const host = q.country === 'us' ? 'jooble.org' : 'ca.jooble.org';
    for (let page = 1; page <= pages; page++) {
      // Jooble wants a POST request with the key in the URL and the search as JSON in the body.
      const d = await getJSON(`https://${host}/api/${encodeURIComponent(env.JOOBLE_API_KEY)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // keywords = search words; location = '' for remote, else the place, or "Canada" when
        // searching Canada with no place (US with no place stays ''); page number as text.
        body: JSON.stringify({ keywords: q.what, location: q.where === 'remote' ? '' : q.where || (q.country === 'us' ? '' : 'Canada'), page: String(page) }),
      });
      // Convert each job to our common shape.
      for (const j of d.jobs || []) out.push({
        // Id with "jb:" prefix (the job id, or its link if there's no id); company, title, location.
        id: `jb:${j.id || j.link}`, company: clean(j.company), title: clean(j.title), locations: [clean(j.location)].filter(Boolean),
        // Remote if the location or title says so; link; original site (or "Jooble"); update date.
        remote: /remote/i.test(`${j.location} ${j.title}`), url: j.link || '', via: clean(j.source) || 'Jooble', posted: Date.parse(j.updated) || 0,
        // Short description (Jooble only gives a snippet), job type, and salary if listed.
        desc: clean(j.snippet).slice(0, 2000), schedule: j.type || '', salary: j.salary || '',
      });
      // Fewer than 20 jobs means no more pages.
      if ((d.jobs || []).length < 20) break;
    }
    return out;
  },
};

// Run every enabled source for every query. Returns raw items + per-source status.
/*
 * searchWeb(f, wanted)
 * Inputs: f — the Careers filters; wanted — optional list of source names to use
 * (e.g. ['adzuna']); if missing, all ready sources are used.
 * Returns (a Promise of): { items, sources, queries } — all jobs found, a status entry per
 * source ({ count, error, at, queries }), and the queries that were run.
 */
async function searchWeb(f, wanted) {
  // Turn the filters into search queries.
  const queries = buildQueries(f);
  // Pages per query: WEB_JOB_PAGES from .env (default 2), kept between 1 and 3
  // (Math.min caps it at 3, Math.max makes it at least 1).
  const pages = Math.max(1, Math.min(3, Number(env.WEB_JOB_PAGES) || 2));
  // Which sources to use: those whose keys are set and (if a wanted list was given) are in it.
  const keys = Object.keys(SOURCES).filter((k) => SOURCES[k].ready() && (!wanted || wanted.includes(k)));
  // Per-source status, and the combined list of all jobs.
  const sources = {};
  const items = [];
  // Run all sources at the same time and wait for all to finish (Promise.all).
  await Promise.all(keys.map(async (k) => {
    const label = SOURCES[k].label;
    // Error messages and job count for this source.
    const errors = [];
    let count = 0;
    // Google Jobs uses a paid-per-search quota (free plan: 250/month), so keep it to 1 page × 2 queries by default
    // SERPAPI_PAGES in .env can raise it (still 1–3); other sources use `pages`.
    const srcPages = k === 'google' ? Math.max(1, Math.min(3, Number(env.SERPAPI_PAGES) || 1)) : pages;
    // Run all of this source's queries at the same time (Google only gets the first 2).
    await Promise.all((k === 'google' ? queries.slice(0, 2) : queries).map(async (q) => {
      // Cache key: everything that changes the results, joined with "|".
      const ck = `${k}|${q.text}|${q.country}|${f.postedWithinDays || 0}|${srcPages}`;
      // Look for saved results.
      let hit = cache.get(ck);
      // Nothing saved, or it's older than 3 hours: fetch fresh results.
      if (!hit || Date.now() - hit.at > TTL) {
        try {
          // fetchers[k] picks the right function by source name.
          hit = { at: Date.now(), items: await fetchers[k](q, srcPages, f) };
          cache.set(ck, hit);
        } catch (e) {
          // On failure: make a friendly message, log it in the terminal, remember it,
          // and skip this query (return ends just this query's function).
          const why = explain(label, e);
          console.log(`  [jobs] ${label} failed for "${q.text}": ${why}`);
          errors.push(why);
          return;
        }
      }
      // Add each job to the combined list, copying it (spread ...it) and noting which
      // source and query it came from.
      hit.items.forEach((it) => items.push({ ...it, source: k, query: q.text }));
      // Count them. (count and items are shared by all these inner functions because they
      // were declared outside — a "closure".)
      count += hit.items.length;
    }));
    // Record this source's status. new Set(errors) removes duplicate messages; [...set]
    // turns it back into an array; join with "; ". error is null if there were none.
    sources[label] = { count, error: errors.length ? [...new Set(errors)].join('; ') : null, at: Date.now(), queries: queries.map((q) => q.text) };
  }));
  return { items, sources, queries };
}

// One tiny search per source, used by the "test my sources" button
/*
 * testSources()
 * Inputs: none. Returns (a Promise of): { google: { label, ok, message }, adzuna: ..., jooble: ... }.
 * Each source runs one small search ("intern in Canada", 1 page) and reports how it went.
 */
async function testSources() {
  const out = {};
  // Test every source at the same time. ([k, v] = the source name and its settings.)
  await Promise.all(Object.entries(SOURCES).map(async ([k, v]) => {
    // No key: report that and stop for this source.
    if (!v.ready()) { out[k] = { label: v.label, ok: false, message: 'no key in .env' }; return; }
    // Start time, to measure how long the search takes.
    const t = Date.now();
    try {
      // A hand-made test query (same shape buildQueries makes), 1 page, no filters ({}).
      const items = await fetchers[k]({ what: 'intern', role: '', kindWords: 'intern internship co-op', where: '', country: 'ca', text: 'intern in Canada' }, 1, {});
      // Success message, e.g. "working · 42 jobs in 1.3s" (.toFixed(1) = one decimal place).
      out[k] = { label: v.label, ok: true, message: `working · ${items.length} jobs in ${((Date.now() - t) / 1000).toFixed(1)}s` };
    } catch (e) {
      // Failure: the friendly explanation.
      out[k] = { label: v.label, ok: false, message: explain(v.label, e) };
    }
  }));
  return out;
}

// Make these available to other files (jobs.js uses searchWeb; server.js uses status and testSources).
module.exports = { searchWeb, buildQueries, status, testSources, SOURCES };
