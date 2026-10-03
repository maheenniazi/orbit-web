/*
 * webjobs.js — the free, no-key job search used by orbit's hosted WEBSITE (browser mode).
 *
 * Why this exists:
 *   The full-power job search (jobs.js + websearch.js) runs on the server and uses sources that
 *   either need secret keys (Google Jobs / Adzuna / Jooble) or block browser requests (CORS). On
 *   the hosted website there is no server, so this file searches job sources that are:
 *     - free and need no key, and
 *     - callable straight from the browser (they send permissive CORS headers).
 *   The two we use are Arbeitnow (a public job-board API) and Remotive (a public remote-jobs API).
 *   These lean toward remote / international roles, so the website search is honestly labelled as
 *   "remote & worldwide". Running orbit locally with `node server.js` unlocks the richer,
 *   Canada-focused search.
 *
 * It returns the SAME shape as the server's /api/jobs/search ({ results, total, sources }) with each
 * job in orbit's common shape, so careers.js can score and show them without caring where they came
 * from. careers.js does its own fit-scoring and sorting; this file just gathers, filters and dedupes.
 *
 * Robustness: each source is fetched independently and may fail (e.g. a CORS block) without breaking
 * the others — a failed source is reported in `sources` so the UI can say "couldn't reach X".
 */

// An optional user-provided CORS proxy. Some sources may block direct browser calls; a proxy that
// echoes the target with the right CORS headers can rescue them. Off by default. Saved alongside the
// AI keys under this localStorage key as { proxy: 'https://my-proxy/?url=' }.
const JOB_CFG = 'studyos:webjobs';

/*
 * readCfg() — load the website job-search config (currently just an optional proxy prefix).
 * Returns an object; never throws.
 */
export function readCfg() {
  try { return JSON.parse(localStorage.getItem(JOB_CFG) || '{}') || {}; } catch { return {}; }
}
/*
 * setProxy(prefix) — save (or clear) the optional CORS proxy prefix. A prefix is put in front of the
 * target URL, e.g. 'https://proxy.example/?url='. Empty string clears it. Returns the config.
 */
export function setProxy(prefix = '') {
  const cfg = readCfg();
  if (prefix.trim()) cfg.proxy = prefix.trim(); else delete cfg.proxy;
  localStorage.setItem(JOB_CFG, JSON.stringify(cfg));
  return cfg;
}
// wrap(url): apply the proxy prefix if one is configured, else return the url unchanged.
const wrap = (url) => { const p = readCfg().proxy; return p ? p + encodeURIComponent(url) : url; };

// clean(s): strip HTML tags/entities and squeeze whitespace, same idea as the server's clean().
const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
// lc(s): lowercase a string safely.
const lc = (s) => String(s || '').toLowerCase();

// getJSON(url): fetch + parse JSON with a timeout and a clear error on failure.
async function getJSON(url) {
  const r = await fetch(wrap(url), { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------------- sources ----------------
// Each fetcher takes the search text `q` and returns a list of jobs in the common shape.
const SOURCES = {
  // Arbeitnow public job-board API. No key, permissive CORS. Returns a page of recent jobs; we
  // filter by the query text ourselves (the API has no full-text query parameter on the free feed).
  arbeitnow: {
    label: 'Arbeitnow',
    async fetch(q) {
      const d = await getJSON('https://www.arbeitnow.com/api/job-board-api');
      const words = lc(q).split(/\s+/).filter(Boolean);
      return (d.data || []).map((j) => ({
        id: `an:${j.slug}`.slice(0, 200),
        company: clean(j.company_name),
        title: clean(j.title),
        locations: [clean(j.location)].filter(Boolean),
        remote: Boolean(j.remote),
        url: j.url || '',
        via: 'Arbeitnow',
        posted: Number(j.created_at) ? Number(j.created_at) * 1000 : 0,
        desc: clean(j.description).slice(0, 4000),
        schedule: (j.job_types || []).join(' '),
        tags: j.tags || [],
      })).filter((j) => !words.length || words.some((w) => (lc(j.title) + ' ' + lc(j.desc) + ' ' + (j.tags || []).join(' ').toLowerCase()).includes(w)));
    },
  },
  // Remotive public remote-jobs API. No key. Supports a `search` parameter. CORS may vary, so this
  // source can fail independently; that's reported, not fatal.
  remotive: {
    label: 'Remotive',
    async fetch(q) {
      const params = new URLSearchParams({ limit: '50' });
      if (q) params.set('search', q);
      const d = await getJSON(`https://remotive.com/api/remote-jobs?${params}`);
      return (d.jobs || []).map((j) => ({
        id: `rm:${j.id}`,
        company: clean(j.company_name),
        title: clean(j.title),
        locations: [clean(j.candidate_required_location) || 'Remote'].filter(Boolean),
        remote: true,
        url: j.url || '',
        via: 'Remotive',
        posted: Date.parse(j.publication_date) || 0,
        desc: clean(j.description).slice(0, 4000),
        schedule: j.job_type || '',
        salary: j.salary || '',
      }));
    },
  },
};

// Role words per category, mirroring websearch.js so the search text matches the server's intent.
const ROLE = { software: 'software engineer', data: 'data', quant: 'quantitative', product: 'product', hardware: 'hardware engineer', design: 'designer', research: 'research', business: 'business analyst', psych: 'psychology' };

/*
 * queryText(f) — turn the Careers filters into one search string for the free sources.
 * Input: the filters object. Returns a string like "software engineer intern".
 */
function queryText(f) {
  // Prefer the student's own typed keywords; else up to 2 category role-words.
  if (f.keywords) return f.keywords;
  const roles = (f.categories || []).slice(0, 2).map((c) => ROLE[c] || c);
  // Add an intern/newgrad word so results skew to student-appropriate roles.
  const types = f.types?.length ? f.types : ['internship'];
  const typeWord = types.includes('internship') ? 'intern' : types.includes('newgrad') ? 'new grad' : '';
  return [roles.join(' '), typeWord].filter(Boolean).join(' ').trim();
}

/*
 * passesFilters(job, f) — basic client-side filtering (same spirit as the server's matches()).
 * Keeps the result set sensible: honour "remote only" and "posted within N days". Type/role
 * filtering is already baked into the query text; careers.js does the fine-grained fit scoring.
 */
function passesFilters(job, f) {
  if (f.remote && !job.remote) return false;
  if (f.postedWithinDays && job.posted) {
    const days = (Date.now() - job.posted) / 86400000;
    if (days > Number(f.postedWithinDays)) return false;
  }
  return true;
}

/*
 * search(f) — the website job search. Runs the free sources in parallel, merges, filters and
 * dedupes, and returns { results, total, sources } exactly like the server endpoint.
 */
export async function search(f = {}) {
  const q = queryText(f);
  const sources = {};
  const all = [];
  // Run every source at once; a failure in one is recorded and skipped.
  await Promise.all(Object.entries(SOURCES).map(async ([k, src]) => {
    try {
      const items = await src.fetch(q);
      sources[src.label] = { count: items.length, error: null, at: Date.now() };
      all.push(...items);
    } catch (e) {
      // A browser CORS/network failure usually throws here. Report a friendly message.
      const msg = e.name === 'TimeoutError' || e.name === 'AbortError'
        ? `${src.label} timed out`
        : `couldn’t reach ${src.label} from the browser (CORS). add a proxy in settings, or run orbit locally`;
      sources[src.label] = { count: 0, error: msg, at: Date.now() };
    }
  }));

  // Dedupe by a company|title|location fingerprint (same approach as the server).
  const seen = new Map();
  const results = [];
  const keyOf = (it) => lc(`${it.company}|${it.title}`).replace(/[^a-z0-9|]+/g, '') + '|' + lc((it.locations[0] || '').split(',')[0]);
  for (const it of all) {
    if (!passesFilters(it, f)) continue;
    const key = keyOf(it);
    const prev = seen.get(key);
    if (prev) {
      // Keep one copy; fill in gaps and remember every place it was found.
      if (!prev.desc && it.desc) prev.desc = it.desc;
      if (!prev.posted && it.posted) prev.posted = it.posted;
      prev.foundOn = [...new Set([...(prev.foundOn || []), it.via])];
      continue;
    }
    const item = { ...it, foundOn: [it.via].filter(Boolean) };
    seen.set(key, item);
    results.push(item);
  }
  // Newest first (careers.js re-sorts by fit when a profile exists).
  results.sort((a, b) => b.posted - a.posted);
  const limit = Math.min(Number(f.limit) || 300, 600);
  return { total: results.length, results: results.slice(0, limit), sources };
}

/*
 * testSources() — the "test my sources" probe for website mode. Runs a tiny search per source and
 * reports whether each is reachable. Returns { Arbeitnow: { label, ok, message }, ... }.
 */
export async function testSources() {
  const out = {};
  await Promise.all(Object.entries(SOURCES).map(async ([k, src]) => {
    const t = Date.now();
    try {
      const items = await src.fetch('intern');
      out[k] = { label: src.label, ok: true, message: `working · ${items.length} jobs in ${((Date.now() - t) / 1000).toFixed(1)}s` };
    } catch (e) {
      out[k] = { label: src.label, ok: false, message: e.name === 'TimeoutError' ? 'timed out' : 'blocked by CORS from the browser — add a proxy or run orbit locally' };
    }
  }));
  return out;
}
