/*
 * jobs.js — the SERVER-side job search engine for the Careers section (runs in Node, not the browser).
 *
 * server.js calls two things from here:
 *   - search(filters)  for POST /api/jobs/search: gathers job/internship postings from several
 *                      sources, filters them by what you asked for, removes duplicates, and returns the matches.
 *   - jobText(url)     for GET /api/job-text: downloads one job posting page and extracts its text
 *                      (so the AI can tailor a resume / cover letter to it).
 *   pages.js also reuses htmlToText, isPrivateHost and UA from here.
 *
 * Where jobs come from:
 *   1. "Feeds": big community-maintained lists on GitHub (Canadian internship READMEs, SimplifyJobs JSON lists).
 *   2. "Boards": a specific company's public applicant-tracking-system (ATS) board on Greenhouse, Lever or Ashby,
 *      written like "greenhouse:faire".
 *   3. Web search results from websearch.js (Google Jobs, Adzuna, Jooble), if API keys are configured.
 *   Every source is converted ("normalized") into the SAME object shape so they can be filtered together.
 *   Downloads are cached in memory for 30 minutes so repeated searches are fast.
 *
 * Beginner terms:
 *   - CommonJS modules: Node's older module style. `require('./file')` loads another file and
 *     `module.exports = {...}` (bottom of this file) is what this file shares.
 *   - fetch / async / await: fetch makes an HTTP request and returns a Promise (a value that arrives later);
 *     `await` waits for it inside an `async` function.
 *   - JSON: text format for data; r.json() parses a response body into a JS object.
 *   - Regex (regular expression): a text pattern like /intern/i. Flags: i = ignore case, g = find all,
 *     u = full Unicode support. \b = a word boundary (edge of a word), \s = whitespace, \d = a digit,
 *     [abc] = one of a/b/c, [^abc] = any char except those, ? = optional, + = one or more, * = zero or more,
 *     (a|b) = a or b, ( ) also "captures" the matched part so code can read it as m[1], m[2]...
 *   - Map: a key -> value store (like an object, but any key type and easy .get/.set). Set: a list with no duplicates.
 */
// Job & internship sources for the careers section (zero dependencies).
//  - SimplifyJobs community lists (Summer 2027 internships, new grad), updated hourly by Simplify + Pitt CSC
//  - Any company's public ATS board: greenhouse:<token>, lever:<company>, ashby:<board>
// Listings are cached in memory, filtered here, and only matches are sent to the browser.

// How long a cached download stays fresh: 30 minutes, written in milliseconds (30 × 60 seconds × 1000 ms).
const TTL = 30 * 60 * 1000;
// Request headers sent with every download. 'user-agent' tells the website which browser is asking;
// we pretend to be Safari on a Mac because some sites block or change their response for unknown programs.
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' };

// FEEDS: the big community job lists. Each key ('canada', 'internships', 'newgrad') describes one feed:
//   label = name shown in the UI, type = what kind of jobs it holds, urls = where to download it.
const FEEDS = {
  // Canadian internship & co-op lists. These are README (Markdown/HTML) files with tables, not JSON.
  canada: {
    label: 'Canadian internship & co-op lists (2027)',
    type: 'internship',
    // kind 'readme' tells loadFeed() to parse tables with parseReadmeTables() instead of reading JSON.
    kind: 'readme',
    // Year these lists are for; used when a posting doesn't say which term (see matches()).
    year: '2027',
    // Note: nothing in this file currently reads this `region` value; each item's region is worked out by regionOf().
    region: 'CA',
    // List of README URLs. process.env.JOBS_CANADA_URLS lets you override them in .env as a comma-separated string.
    // `||` means: use the .env value if set, otherwise the default list below joined into one comma-separated string.
    // Then .split(',') breaks it into pieces, .map((u) => u.trim()) removes spaces around each,
    // and .filter(Boolean) throws away empty pieces.
    urls: (process.env.JOBS_CANADA_URLS || [
      'https://raw.githubusercontent.com/negarprh/Canadian-Tech-Internships-2027/main/README.md',
      'https://raw.githubusercontent.com/zapplyjobs/Canada-Internships-2027/main/README.md',
    ].join(',')).split(',').map((u) => u.trim()).filter(Boolean),
    // Note: loadReadmeFeed() always fetches every URL, so this flag documents the intent but isn't read by the code.
    all: true, // merge every URL instead of using the first that works
  },
  // SimplifyJobs' Summer 2027 internship list (a JSON file). Can be overridden with JOBS_INTERNSHIPS_URL in .env.
  internships: {
    label: 'Simplify internships (Summer 2027)',
    type: 'internship',
    urls: [process.env.JOBS_INTERNSHIPS_URL || 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json'],
  },
  // SimplifyJobs' new-grad list (JSON). Can be overridden with JOBS_NEWGRAD_URL in .env.
  newgrad: {
    label: 'Simplify new grad',
    type: 'newgrad',
    urls: [process.env.JOBS_NEWGRAD_URL || 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json'],
  },
};

// In-memory cache: key (feed name or 'board:<spec>') -> { at: when downloaded, items: the jobs, error: message or null }.
// A Map is used because we need .get(key)/.set(key, value). It's emptied when the server restarts.
const cache = new Map(); // key -> { at, items, error }

// arr(v): always give back an array of strings.
//   - already an array -> drop empty values (filter(Boolean)) and turn each into a string (map(String));
//   - a single non-empty value -> wrap it in an array: [String(v)];
//   - nothing -> []. (Nested `a ? b : c ? d : e` is an if / else-if / else on one line.)
const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : v ? [String(v)] : []);
// ms(v): turn a date in any common form into milliseconds since 1970 (0 if unknown).
const ms = (v) => {
  // Missing -> 0.
  if (!v) return 0;
  // A number: if it's smaller than 1e12 (1,000,000,000,000) it must be in SECONDS (Unix time), so ×1000;
  // otherwise it's already in milliseconds.
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  // A string like '2025-09-01': let Date.parse read it (gives NaN = 'Not a Number' if it can't).
  const t = Date.parse(v);
  // Return 0 for unreadable dates, otherwise the milliseconds.
  return Number.isNaN(t) ? 0 : t;
};
// isRemote(locs): true if any location string contains the word 'remote' (any case: /remote/i).
const isRemote = (locs) => locs.some((l) => /remote/i.test(l));

/*
 * inferType(title) — guess the job type from its title.
 * Input: job title. Returns: 'internship', 'newgrad' or 'job'.
 */
function inferType(title) {
  // Regex: the word 'intern', 'interns', 'internship' or 'internships' (\b = whole word),
  // OR 'coop' / 'co-op' (the -? makes the dash optional). i = ignore case.
  if (/\bintern(ship)?s?\b|co-?op/i.test(title)) return 'internship';
  // Regex: any of these phrases suggests an early-career role: 'new grad', 'graduate', 'entry level' / 'entry-level'
  // ([- ] = a dash or a space), 'early career', 'university', 'campus', 'junior', 'associate'.
  if (/new grad|graduate|entry[- ]level|early career|university|campus|junior|associate/i.test(title)) return 'newgrad';
  // Anything else is a regular job.
  return 'job';
}
// Season words (English + French) -> the standard English season name. 'été'/'ete' = summer,
// 'automne' = fall, 'hiver' = winter, 'printemps' = spring. Keys with accents need quotes.
const SEASONS = { summer: 'Summer', fall: 'Fall', autumn: 'Fall', spring: 'Spring', winter: 'Winter', 'été': 'Summer', ete: 'Summer', automne: 'Fall', hiver: 'Winter', printemps: 'Spring' };
/*
 * inferTerms(text) — find work terms like 'Summer 2027' or "Fall '26" in a piece of text.
 * Input: any text (usually a title). Returns: an array of unique terms, e.g. ['Summer 2027', 'Fall 2026'].
 */
function inferTerms(text) {
  // A Set so the same term found twice is only kept once.
  const out = new Set();
  // English + French (Québec postings) season names
  // matchAll gives every match of the regex. The regex, piece by piece:
  //   (?<![\p{L}])  — 'not right after a letter' (a lookbehind; \p{L} = any Unicode letter), so 'Summer' must start a word;
  //   (summer|...|printemps) — a season word (captured as m[1]);
  //   \s*'?        — optional spaces and an optional apostrophe (as in Fall '26);
  //   (20\d{2}|\d{2}) — a 4-digit year starting with 20, or a 2-digit year (captured as m[2]);
  //   \b           — the year must end there.
  // Flags: g = all matches, i = ignore case, u = Unicode (needed for \p{L} and accented letters).
  for (const m of String(text).matchAll(/(?<![\p{L}])(summer|fall|autumn|spring|winter|été|ete|automne|hiver|printemps)\s*'?(20\d{2}|\d{2})\b/giu)) {
    // Turn a 2-digit year like '27' into '2027'.
    const y = m[2].length === 2 ? '20' + m[2] : m[2];
    // Store e.g. 'Summer 2027' (lowercase the season to look it up in SEASONS).
    out.add(`${SEASONS[m[1].toLowerCase()]} ${y}`);
  }
  // Spread `...out` turns the Set into a normal array.
  return [...out];
}

// ---------- HTML -> text ----------
// ENT: named HTML entities (like &amp; or &nbsp;) -> the actual character they stand for.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', hellip: '…' };
/*
 * decode(s) — turn HTML entities back into real characters, e.g. '&amp;' -> '&', '&#39;' -> "'".
 * Input: a string. Returns: the decoded string.
 */
function decode(s) {
  return s
    // &#123; style (decimal number): (\d+) captures the digits; String.fromCodePoint turns the number into its character.
    // `_` is just a name for the full match we don't need; `+n` converts the text to a number.
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    // &#x1F600; style (hexadecimal): ([0-9a-f]+) captures hex digits; parseInt(n, 16) reads them as base 16.
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    // &name; style: look the name up in ENT. `??` (nullish coalescing) means 'if that's undefined, use m instead'
    // — so unknown entities are left exactly as they were.
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
/*
 * htmlToText(html) — turn a chunk of HTML into readable plain text (keeps line breaks and bullet points).
 * Input: HTML string (default ''). Returns: tidy plain text.
 */
function htmlToText(html = '') {
  let s = String(html);
  // Some APIs send HTML that's escaped twice (shows up as '&lt;p&gt;' instead of '<p>').
  // If we see '&lt;' + a letter but no real '<' + letter, decode once to get normal HTML back.
  if (/&lt;\w/.test(s) && !/<\w/.test(s)) s = decode(s); // Greenhouse double-encodes HTML
  // Chain of replacements, top to bottom:
  s = s
    // 1. Remove whole blocks we never want as text: <script>, <style>, <noscript>, <svg>, <head>, <nav>, <footer>.
    //    ([\s\S]*? = anything incl. newlines, as little as possible; <\/\1> = the closing tag with the SAME name as captured group 1.)
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    // 2. Each <li ...> (list item) becomes a new line starting with '- '.
    .replace(/<li[^>]*>/gi, '\n- ')
    // 3. Closing tags of block elements (</p>, </div>, </li>, </ul>, </ol>, </h1>-</h6>, </tr>, </section>, </article>)
    //    and <br>, <br/>, <br /> become a newline.
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, '\n')
    // 4. An opening heading tag (<h1>-<h6>) becomes a blank line before the heading.
    .replace(/<h[1-6][^>]*>/gi, '\n\n')
    // 5. Any other remaining tag <...> is replaced by a space.
    .replace(/<[^>]+>/g, ' ');
  // Then decode entities and tidy up whitespace:
  return decode(s)
    // Runs of spaces, tabs and non-breaking spaces (\u00a0) become one space.
    .replace(/[ \t\u00a0]+/g, ' ')
    // Remove spaces around newlines.
    .replace(/ *\n */g, '\n')
    // 3 or more newlines in a row become just 2 (at most one blank line).
    .replace(/\n{3,}/g, '\n\n')
    // Remove whitespace at the very start and end.
    .trim();
}

/*
 * getJSON(url) — download a URL and parse it as JSON.
 * Input: URL string. Returns: (Promise of) the parsed data. Throws on HTTP errors or after 25 seconds.
 */
async function getJSON(url) {
  // AbortSignal.timeout(25_000) cancels the request after 25,000 ms. (The _ in numbers is just a readable separator.)
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) });
  // r.ok is false for error codes like 404 or 500 -> throw an Error so the caller knows it failed.
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  // Parse the body as JSON (returns a Promise; the async function passes it along).
  return r.json();
}

// ---------- Feeds ----------
/*
 * normalizeSimplify(l, type) — convert one SimplifyJobs listing into our standard job object.
 * Inputs: l = raw listing from Simplify's JSON; type = 'internship' or 'newgrad' (from the feed).
 * Returns: a job object with the same fields every source uses (id, company, title, locations, ...).
 */
function normalizeSimplify(l, type) {
  // Make sure locations is an array of strings.
  const locations = arr(l.locations);
  return {
    // Unique id: 'sim:' + Simplify's id, or if missing, company-title-date glued together (nested template literal).
    id: `sim:${l.id || `${l.company_name}-${l.title}-${l.date_posted}`}`,
    // Where it came from.
    source: 'simplify',
    // Company name (Simplify uses company_name; fall back to company, then '').
    company: l.company_name || l.company || '',
    title: l.title || '',
    // `locations,` is shorthand for `locations: locations`.
    locations,
    // true if any location mentions remote.
    remote: isRemote(locations),
    // Use Simplify's own terms if it lists any; otherwise guess them from the title.
    terms: arr(l.terms).length ? arr(l.terms) : inferTerms(l.title || ''),
    // Shorthand for `type: type`.
    type,
    category: l.category || '',
    // Apply link (or the company's site as a fallback).
    url: l.url || l.company_url || '',
    // Posting date in ms (posted date, else last-updated date).
    posted: ms(l.date_posted || l.date_updated),
    // Visa sponsorship note (used by the work-authorization filters in matches()).
    sponsorship: l.sponsorship || '',
    degrees: arr(l.degrees),
    // Still open? Only false if Simplify explicitly says inactive or hidden (`!== false` treats missing as true).
    active: l.active !== false && l.is_visible !== false,
    // No description in this feed.
    desc: '',
  };
}

// Community lists publish Markdown or HTML tables in their README. Map columns by header name.
/*
 * parseReadmeTables(src, feed, url) — read job tables out of a README file.
 * Inputs: src = README text; feed = the FEEDS entry (for its year); url = where the README came from.
 * Returns: an array of standard job objects.
 * Works with both HTML tables (<table><tr><td>) and Markdown tables (| a | b |). It finds the header row
 * by looking for 'company' + 'role'-like column names, then reads each row by column position.
 */
function parseReadmeTables(src, feed, url) {
  // The jobs we find.
  const items = [];
  // linkOf(cell): the first link in a table cell, or ''. Tries, in order:
  //   - an HTML link:   href="..."            -> captures what's inside the quotes;
  //   - a Markdown link: ](https://...)      -> captures the URL inside the parentheses;
  //   - a bare URL:      http(s)://...        -> up to a space, ), |, " or <.
  // `a || b || c || []` takes the first one that matched; [1] is the captured URL; `|| ''` if none.
  const linkOf = (cell) => (cell.match(/href="([^"]+)"/) || cell.match(/\]\((https?:[^)\s]+)\)/) || cell.match(/(https?:\/\/[^\s)|"<]+)/) || [])[1] || '';
  // clean(cell): plain text of a cell:
  //   - remove Markdown images ![alt](src) entirely (company logos);
  //   - turn Markdown links [text](url) into just their text ($1);
  //   - convert any HTML to text; remove ** and __ (bold markers); squash whitespace; trim.
  const clean = (cell) => htmlToText(cell.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')).replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
  // All table rows from all tables, in order. Each row is an array of raw cell strings; `null` marks the end of a table.
  const rows = [];
  // HTML tables
  // Each <table>...</table> block (non-greedy so tables are found one at a time).
  for (const t of src.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    // For each <tr>...</tr> row inside it, collect the contents of every <th> or <td> cell (t[hd] = th or td).
    // [...x] turns the matchAll results into an array; .map((m) => m[1]) keeps the captured cell content.
    for (const tr of t[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) rows.push([...tr[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => m[1]));
    rows.push(null); // table boundary
  }
  // Markdown tables
  // Go through the README line by line.
  for (const line of src.split('\n')) {
    // Remove spaces at both ends of the line.
    const l = line.trim();
    // A Markdown table row starts and ends with '|'.
    if (/^\|.*\|$/.test(l)) {
      // The separator row under the header (only |, -, :, spaces, e.g. '|---|:--:|') -> skip it.
      if (/^\|[\s:|-]+\|$/.test(l)) continue; // separator
      // Drop the outer pipes (slice(1, -1)) and split on '|' — but not on an escaped '\|' ((?<!\\) = 'not preceded by a backslash').
      rows.push(l.slice(1, -1).split(/(?<!\\)\|/));
    // A non-table line right after a table: add a null to mark the table ended (only once).
    } else if (rows.length && rows[rows.length - 1] !== null) rows.push(null);
  }
  // The header row (lowercased cell texts) of the table we're currently reading; null = not found yet.
  let head = null;
  // Lists often write '↳' instead of repeating the company name; remember the last real company name.
  let lastCompany = '';
  // col(names): position of the first header column whose name contains any of the given words (-1 if none).
  // (It's defined here but called later, once `head` is set.)
  const col = (names) => head.findIndex((h) => names.some((n) => h.includes(n)));
  // Walk through every row.
  for (const r of rows) {
    // null = table ended: forget the header so the next table finds its own.
    if (!r) { head = null; continue; }
    // Raw cells, trimmed (keeps links for linkOf).
    const cells = r.map((c) => c.trim());
    // Clean text version of each cell.
    const text = cells.map(clean);
    // No header yet: is this row the header?
    if (!head) {
      // Lowercase every cell for matching.
      const h = text.map((x) => x.toLowerCase());
      // It's a header if one cell mentions company/employer/organization AND one mentions role/position/title/job.
      if (h.some((x) => /company|employer|organization/.test(x)) && h.some((x) => /role|position|title|job/.test(x))) head = h;
      // Header (or junk before it) isn't a job, so move to the next row.
      continue;
    }
    // Find which column holds each piece of information (company, role, location, term, date, apply link).
    const ci = col(['company', 'employer', 'organization']);
    const ri = col(['role', 'position', 'title', 'job']);
    const li = col(['location', 'city', 'where']);
    const ti = col(['term', 'season', 'cycle', 'duration']);
    const di = col(['date', 'posted', 'age', 'added']);
    const ai = col(['apply', 'link', 'application', 'url']);
    // The company text for this row.
    let company = text[ci] || '';
    // If the company cell is empty or just a 'same as above' marker (↳, ⤷, ^, -, or ") after removing spaces,
    // use the previous company; otherwise remember this one as the latest.
    if (/^(↳|⤷|\^|-|")?$/.test(company.replace(/\s/g, ''))) company = lastCompany; else lastCompany = company;
    // The job title.
    const title = text[ri] || '';
    // Skip rows missing either.
    if (!company || !title) continue;
    // Closed postings are marked with a 🔒 emoji or the word 'closed' anywhere in the row.
    const closed = /🔒|closed/i.test(cells.join(' '));
    // Split the location cell into separate places on ';', '/', the word 'or', '<br>' or newlines (with optional spaces around).
    const locations = (text[li] || '').split(/\s*(?:;|\/|\bor\b|<br>|\n)\s*/i).map((x) => x.trim()).filter(Boolean);
    // Find terms in the term column plus the title.
    const terms = inferTerms(`${text[ti] || ''} ${title}`);
    // Apply link: from the apply column, else from the title cell, else anywhere in the row.
    const url2 = linkOf(cells[ai] || '') || linkOf(cells[ri] || '') || linkOf(cells.join(' '));
    // Add a standard job object.
    items.push({
      // Id built from company, title and first location (lowercased) — lc() is defined further down the file.
      id: `md:${lc(company)}:${lc(title)}:${lc(locations[0] || '')}`,
      source: 'canada-list',
      // Shorthand for company: company, title: title, locations: locations.
      company, title, locations,
      remote: isRemote(locations),
      terms,
      // true when no term could be found — matches() then decides based on the feed's year.
      termUnknown: !terms.length,
      year: feed.year,
      // Titles mentioning 'new grad' or 'full time' / 'full-time' / 'fulltime' are new-grad roles; everything else is an internship.
      type: /new grad|full.?time/i.test(title) ? 'newgrad' : 'internship',
      category: '',
      url: url2,
      // Posted date from the date column (0 if missing/unreadable).
      posted: ms(text[di]) || 0,
      sponsorship: '',
      degrees: [],
      // Active unless marked closed.
      active: !closed,
      desc: '',
      // Which README it came from.
      from: url,
    });
  }
  return items;
}

/*
 * loadReadmeFeed(key, feed, hit) — download and parse all README URLs of a feed.
 * Inputs: key = cache key; feed = FEEDS entry; hit = the old cache entry (or undefined).
 * Returns: a cache entry { at, items, error }.
 */
async function loadReadmeFeed(key, feed, hit) {
  // All jobs from all URLs.
  const items = [];
  // Error messages from URLs that failed.
  const errors = [];
  // Promise.all runs all downloads AT THE SAME TIME and waits until every one has finished.
  // feed.urls.map(async (url) => ...) starts one async task per URL.
  await Promise.all(feed.urls.map(async (url) => {
    try {
      // Download the README (25 second limit).
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) });
      // Error status (e.g. 404) -> jump to catch below.
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Read the text, parse its tables, and add all found jobs (`...` spreads the array into push's arguments).
      items.push(...parseReadmeTables(await r.text(), feed, url));
    } catch (e) {
      // Record the failure with a short name: parts 3–4 of the URL path (the GitHub 'owner/repo') + the error message.
      errors.push(`${url.split('/').slice(3, 5).join('/')}: ${e.message}`);
    }
  }));
  // Nothing worked but we have old data? Return the old data with a note (`...hit` copies the old entry, then error is overwritten).
  if (!items.length && hit?.items) return { ...hit, error: `refresh failed; showing cached` };
  // Build the new entry; join multiple errors with '; ' (or null if none).
  const entry = { at: Date.now(), items, error: errors.length ? errors.join('; ') : null };
  // Only cache it if we actually got jobs (so an empty failure doesn't hide good data for 30 minutes).
  if (items.length) cache.set(key, entry);
  return entry;
}

/*
 * loadFeed(key) — get one feed's jobs, from cache if fresh, otherwise by downloading.
 * Input: a FEEDS key. Returns: (Promise of) a cache entry { at, items, error }.
 */
async function loadFeed(key) {
  // The feed's settings.
  const feed = FEEDS[key];
  // What's in the cache for it (undefined if nothing).
  const hit = cache.get(key);
  // Cached, younger than TTL (30 min) and has items -> just use it.
  if (hit && Date.now() - hit.at < TTL && hit.items) return hit;
  // README feeds are handled by their own function.
  if (feed.kind === 'readme') return loadReadmeFeed(key, feed, hit);
  // Remember the last error in case every URL fails.
  let lastErr;
  // Try each URL in turn and stop at the first one that works.
  for (const url of feed.urls) {
    try {
      // Download and parse the JSON list.
      const data = await getJSON(url);
      // The JSON might be a plain array, or an object with the list under 'listings' or 'jobs'.
      const list = Array.isArray(data) ? data : data.listings || data.jobs || [];
      // Convert every listing into our standard shape.
      const entry = { at: Date.now(), items: list.map((l) => normalizeSimplify(l, feed.type)), error: null };
      // Save in the cache and return it.
      cache.set(key, entry);
      return entry;
    } catch (e) {
      // This URL failed; remember why and try the next one.
      lastErr = e;
    }
  }
  // Keep serving stale data if a refresh fails
  if (hit?.items) return { ...hit, error: `refresh failed (${lastErr.message}); showing cached` };
  // No cached data either: return an empty result with the error message (`?.` in case there were no URLs at all).
  return { at: Date.now(), items: [], error: lastErr?.message || 'unavailable' };
}

// ---------- Company boards ----------
/*
 * fetchBoard(spec) — download every posting from one company's ATS (applicant tracking system) board.
 * Input: spec like 'greenhouse:faire', 'lever:palantir' or 'ashby:cohere'.
 * Returns: (Promise of) an array of standard job objects. Throws for unknown board types or failures.
 * Each ATS has its own public API with different field names, so each branch maps them to our shape.
 */
async function fetchBoard(spec) {
  // Split 'greenhouse:faire' into ats = 'greenhouse' and slugRaw = 'faire' (array destructuring).
  const [ats, slugRaw] = String(spec).split(':');
  // Clean the company slug (trim, lowercase) and make it safe to put in a URL (encodeURIComponent escapes odd characters).
  const slug = encodeURIComponent((slugRaw || '').trim().toLowerCase());
  if (!slug) throw new Error('missing company');
  // --- Greenhouse ---
  if (ats === 'greenhouse') {
    // Greenhouse's public jobs API; content=true includes each job's description HTML.
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    // Undo the URL-escaping to get a readable company name.
    const company = decodeURIComponent(slug);
    // Convert each Greenhouse job (`|| []` in case 'jobs' is missing).
    return (d.jobs || []).map((j) => {
      // Greenhouse gives one location name; `?.` avoids a crash if location is missing.
      const locations = arr(j.location?.name);
      // Description as plain text, cut to 4000 characters to keep responses small.
      const desc = htmlToText(j.content || '').slice(0, 4000);
      // Build the standard object. Notable fields: terms are guessed from the title + start of the description;
      // category = department names joined by ', '; url = the public job page; posted = first published (or updated) date.
      return { id: `gh:${slug}:${j.id}`, source: `greenhouse:${company}`, company: j.company_name || company, title: j.title, locations, remote: isRemote(locations), terms: inferTerms(`${j.title} ${desc.slice(0, 600)}`), type: inferType(j.title), category: (j.departments || []).map((x) => x.name).join(', '), url: j.absolute_url, posted: ms(j.first_published || j.updated_at), sponsorship: '', degrees: [], active: true, desc };
    });
  }
  // --- Lever ---
  if (ats === 'lever') {
    // Lever's public postings API (mode=json gives JSON instead of HTML).
    const d = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    const company = decodeURIComponent(slug);
    // Lever returns a plain array (guard against anything else).
    return (Array.isArray(d) ? d : []).map((j) => {
      // Use the full list of locations if there is one (and it's not empty), otherwise the single main location.
      const locations = arr(j.categories?.allLocations?.length ? j.categories.allLocations : j.categories?.location);
      // Lever often provides a plain-text description; otherwise convert the HTML one. Keep 4000 chars.
      const desc = (j.descriptionPlain || htmlToText(j.description || '')).slice(0, 4000);
      // Standard object. Remote if a location says so or Lever's workplaceType is 'remote'. It's an internship if the
      // commitment (e.g. 'Intern', 'Full-time') mentions intern, else guess from the title. Category = team + department.
      return { id: `lv:${slug}:${j.id}`, source: `lever:${company}`, company, title: j.text, locations, remote: isRemote(locations) || j.workplaceType === 'remote', terms: inferTerms(`${j.text} ${j.categories?.commitment || ''} ${desc.slice(0, 600)}`), type: /intern/i.test(j.categories?.commitment || '') ? 'internship' : inferType(j.text), category: [j.categories?.team, j.categories?.department].filter(Boolean).join(', '), url: j.hostedUrl, posted: ms(j.createdAt), sponsorship: '', degrees: [], active: true, desc };
    });
  }
  // --- Ashby ---
  if (ats === 'ashby') {
    // Ashby's public job-board API.
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    const company = decodeURIComponent(slug);
    // Skip postings Ashby marks as unlisted, then convert the rest.
    return (d.jobs || []).filter((j) => j.isListed !== false).map((j) => {
      // Main location plus any secondary locations, with empty ones removed.
      const locations = [j.location, ...(j.secondaryLocations || []).map((x) => x.location)].filter(Boolean);
      // Plain-text description if given, else converted from HTML; max 4000 chars.
      const desc = (j.descriptionPlain || htmlToText(j.descriptionHtml || '')).slice(0, 4000);
      // Standard object. Remote if Ashby says so or a location mentions it; internship if employmentType mentions intern.
      return { id: `ab:${slug}:${j.id}`, source: `ashby:${company}`, company, title: j.title, locations, remote: j.isRemote || isRemote(locations), terms: inferTerms(`${j.title} ${desc.slice(0, 600)}`), type: /intern/i.test(j.employmentType || '') ? 'internship' : inferType(j.title), category: [j.department, j.team].filter(Boolean).join(', '), url: j.jobUrl, posted: ms(j.publishedAt), sponsorship: '', degrees: [], active: true, desc };
    });
  }
  // Anything other than the three supported systems is an error.
  throw new Error(`unknown board type "${ats}" (use greenhouse:, lever: or ashby:)`);
}

/*
 * loadBoard(spec) — like loadFeed but for one company board, with caching.
 * Input: spec like 'greenhouse:faire'. Returns: (Promise of) { at, items, error }. Never throws.
 */
async function loadBoard(spec) {
  // Cache key for this board.
  const key = `board:${spec}`;
  const hit = cache.get(key);
  // Fresh cache entry -> reuse it.
  if (hit && Date.now() - hit.at < TTL) return hit;
  try {
    // Download and wrap the results in a cache entry.
    const entry = { at: Date.now(), items: await fetchBoard(spec), error: null };
    cache.set(key, entry);
    return entry;
  } catch (e) {
    // On failure: return the old items if we had any (else an empty list) plus the error message.
    return { at: Date.now(), items: hit?.items || [], error: e.message };
  }
}

// ---------- Search ----------
// CATEGORY_RE: for each job category the user can pick, a regex that recognises it in a job's category + title.
// \b...\b means 'as a whole word' (so 'ai' doesn't match inside 'maintain'). '.?' = one optional character,
// so full.?stack matches 'fullstack', 'full-stack', 'full stack'. 'scien' matches science/scientist.
const CATEGORY_RE = {
  software: /software|\bswe\b|developer|engineer|full.?stack|back.?end|front.?end|mobile|ios|android|platform|infrastructure|devops|security/i,
  data: /data|machine learning|\bml\b|\bai\b|artificial intelligence|analytics|scien|statistic/i,
  quant: /quant|trading|trader/i,
  product: /product/i,
  hardware: /hardware|electrical|embedded|firmware|asic|fpga|robotics|mechanical/i,
  design: /design|\bux\b|\bui\b|creative/i,
  research: /research/i,
  business: /business|finance|financial|consult|marketing|operations|strategy|analyst|sales|accounting|banking/i,
  psych: /psycholog|behavior|clinical|mental health|counsel|human factors|user research|ux research|people|\bhr\b|human resources/i,
};

// lc(s): lowercase any value safely (null/undefined become '').
const lc = (s) => String(s || '').toLowerCase();

// CA_RE: does a location look Canadian? Matches any of:
//   - the words 'canada' or 'canadian';
//   - a province name (ontario, british columbia, ... including 'québec');
//   - a comma followed by a province/territory code, e.g. ', ON' or ', BC';
//   - a major Canadian city (toronto, vancouver, montreal/montréal ([eé] = e or é), waterloo, ...).
//     'london, on' and 'richmond, bc' include the province so they aren't confused with London UK / Richmond VA.
const CA_RE = /\bcanada\b|\bcanadian\b|\b(ontario|british columbia|alberta|quebec|québec|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island)\b|,\s*(on|bc|qc|ab|mb|sk|ns|nb|nl|pe|yt|nt|nu)\b|\b(toronto|vancouver|montr[eé]al|waterloo|kitchener|ottawa|calgary|edmonton|mississauga|markham|brampton|oakville|burlington|hamilton|london, on|guelph|winnipeg|halifax|victoria|burnaby|richmond, bc|surrey|quebec city|qu[eé]bec|saskatoon|regina|fredericton|gatineau|laval|kelowna)\b/i;
// US_RE: does a location look American? 'usa', 'u.s.' / 'u.s.a.' (dots optional), 'united states', 'remote in us',
// or a comma followed by a two-letter US state code (', NY', ', CA', ... ', DC').
const US_RE = /\b(usa|u\.s\.a?\.?|united states|remote in us)\b|,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/i;
/*
 * regionOf(item) — classify a job's location.
 * Input: a job object. Returns: 'CA', 'US', 'unknown' (no location or just 'Remote'), or 'other'.
 * Canada is checked first, so a job listed in both Toronto and NYC counts as CA.
 */
function regionOf(item) {
  // All locations as one string, separated by ' | '.
  const locs = item.locations.join(' | ');
  if (CA_RE.test(locs)) return 'CA';
  if (US_RE.test(locs)) return 'US';
  // Empty, or exactly 'remote' (any case) -> we can't tell.
  if (!locs || /^remote$/i.test(locs.trim())) return 'unknown';
  return 'other';
}
// "ON", "CA", "NY" etc. must match as a state/province code, not as a substring ("toronto" contains "on").
// fold(x): lowercase and strip accents so 'Montréal' matches 'montreal'.
// normalize('NFD') splits 'é' into 'e' + an accent mark; the regex [\u0300-\u036f] matches those accent marks; we remove them.
const fold = (x) => lc(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/*
 * locMatch(locs, want) — does the location text match what the user asked for?
 * Inputs: locs = all locations joined by ' | '; want = e.g. 'Toronto' or 'ON'. Returns true/false.
 */
function locMatch(locs, want) {
  // If want is exactly two letters (a state/province code), build a regex at runtime with new RegExp:
  // the code must come at the start, after a comma (+ spaces), or after a '|' (+ spaces),
  // and must NOT be followed by another letter ((?![a-z]) is a 'negative lookahead'). 'i' = ignore case.
  // In a normal string, '\\s' is needed to produce the regex \s (the backslash itself has to be escaped).
  if (/^[A-Za-z]{2}$/.test(want)) return new RegExp(`(^|,\\s*|\\|\\s*)${want}(?![a-z])`, 'i').test(locs);
  // Otherwise: simple 'contains' check, ignoring case and accents.
  return fold(locs).includes(fold(want));
}

/*
 * matches(item, f) — the main filter: should this job be shown for the filters f?
 * Inputs: item = a standard job object; f = filters sent by the browser (careers.js), e.g.
 *   { types, terms, region, remote, remoteOk, locations, categories, keywords, company,
 *     usNeedsVisa, usNotCitizen, caNotPR, caNotCitizen, postedWithinDays, includeInactive }.
 * Returns: true to keep it, false to drop it. Each `if` below rejects the job for one reason.
 */
function matches(item, f) {
  // Hide closed postings unless asked to include them.
  if (!f.includeInactive && !item.active) return false;
  // Job type filter (internship/newgrad/job). `f.types?.length` is falsy if types is missing or empty -> no filter.
  if (f.types?.length && !f.types.includes(item.type)) return false;
  // Term filter, e.g. ['Summer 2027'].
  if (f.terms?.length) {
    // Text to search: the job's terms + title, lowercased ('hay' as in 'haystack').
    const hay = lc(`${item.terms.join(' ')} ${item.title}`);
    // Lists that don't state a term still count if they're for the right year
    // Keep it if any wanted term appears, OR if the list didn't state a term and either has no year or
    // a wanted term contains the list's year (e.g. 'Summer 2027' contains '2027').
    const ok = f.terms.some((t) => hay.includes(lc(t))) || (item.termUnknown && (!item.year || f.terms.some((t) => t.includes(item.year))));
    if (!ok) return false;
  }
  // Work out the job's region once and save it on the item (`a || (a = b)` = 'use a, or compute and store it').
  const region = item.region || (item.region = regionOf(item));
  // Canada only: keep CA jobs, or 'unknown' ones that came from a Canadian list or mention Canada.
  if (f.region === 'CA' && !(region === 'CA' || (region === 'unknown' && (item.source === 'canada-list' || /canada/i.test(item.locations.join(' ')))))) return false;
  // Canada + US: keep CA, US and unknown.
  if (f.region === 'CA_US' && !['CA', 'US', 'unknown'].includes(region)) return false;
  // US only: keep US and unknown.
  if (f.region === 'US' && !['US', 'unknown'].includes(region)) return false;
  // Remote-only filter.
  if (f.remote && !item.remote) return false;
  // Location filter, e.g. ['Toronto', 'ON'].
  if (f.locations?.length) {
    const locs = item.locations.join(' | ');
    // Keep if any wanted location matches, or the user accepts remote and this job is remote.
    const ok = f.locations.some((l) => locMatch(locs, l)) || (f.remoteOk && item.remote);
    if (!ok) return false;
  }
  // Category filter, e.g. ['software', 'data'].
  if (f.categories?.length) {
    // Search in category + title.
    const hay = `${item.category} ${item.title}`;
    // Use our predefined regex for known categories, otherwise treat the category word itself as a case-insensitive regex.
    if (!f.categories.some((c) => (CATEGORY_RE[c] || new RegExp(c, 'i')).test(hay))) return false;
  }
  // Keyword filter: every keyword must appear somewhere in title, company, category or description.
  if (f.keywords) {
    const hay = lc(`${item.title} ${item.company} ${item.category} ${item.desc}`);
    // Split keywords on spaces/commas, drop empties, and require ALL of them (.every) to be found.
    if (!lc(f.keywords).split(/[\s,]+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  // Company filter: company name must contain the given text.
  if (f.company && !lc(item.company).includes(lc(f.company))) return false;
  // Work authorization (flags computed from the profile in the browser).
  // Simplify's sponsorship field describes US visas, so it only applies to US roles.
  // Text to scan for citizenship / sponsorship restrictions.
  const sp = `${item.sponsorship} ${item.title}`;
  // US job + you'd need a visa: drop jobs that say no sponsorship, or require US citizenship, clearance, a green card or permanent residence.
  // (u\.?s\.? = 'us' or 'u.s.' with optional dots.)
  if (region === 'US' && f.usNeedsVisa && /does not offer|no sponsorship|citizenship|u\.?s\.? citizen|clearance|green card|permanent resident/i.test(sp)) return false;
  // US job + not a US citizen: drop jobs requiring US citizenship or security clearance.
  if (region === 'US' && f.usNotCitizen && /citizenship|u\.?s\.? citizen|clearance/i.test(sp)) return false;
  // Canadian job + not a Canadian PR/citizen: drop jobs saying 'citizens or/and permanent residents', 'must be a (Canadian) citizen',
  // 'permanent resident/residency (is) required', security clearance, reliability status, or 'without (the need for) sponsorship'.
  if (region === 'CA' && f.caNotPR && /citizens? (or|and|\/) permanent residents?|must be (a )?(canadian )?citizen|permanent residen(t|cy) (is )?required|security clearance|reliability status|without (the need for )?sponsorship/i.test(sp)) return false;
  // Canadian job + not a Canadian citizen: drop jobs requiring Canadian citizenship or secret clearance.
  if (region === 'CA' && f.caNotCitizen && /canadian citizen(ship)? (is |only )?required|must be a canadian citizen|secret clearance/i.test(sp)) return false;
  // Posted-within filter: drop jobs older than N days (86,400,000 ms = 1 day). Jobs with no date are kept.
  if (f.postedWithinDays && item.posted && Date.now() - item.posted > f.postedWithinDays * 86400000) return false;
  // Passed every filter.
  return true;
}

// Web results (Google Jobs, Adzuna, Jooble) → the same shape as list/board items
/*
 * normalizeWeb(j) — fill in a web search result (from websearch.js) so it looks like our other job objects.
 * Input: a web result j. Returns: the completed job object, including a region.
 */
function normalizeWeb(j) {
  // Text to look for terms in: title, schedule (e.g. 'Internship') and the first 800 characters of the description.
  const text = `${j.title} ${j.schedule || ''} ${(j.desc || '').slice(0, 800)}`;
  const terms = inferTerms(text);
  // Internship if title/schedule mentions intern, co-op/coop, or 'stage' (French for internship); else guess from title.
  const type = /intern|co-?op|stage\b/i.test(`${j.title} ${j.schedule || ''}`) ? 'internship' : inferType(j.title);
  // Defaults first, then `...j` copies all of the web result's own fields over them; source/via are set explicitly last.
  const item = { terms, termUnknown: !terms.length, type, category: j.category || '', sponsorship: '', degrees: [], active: true, ...j, source: j.source, via: j.via };
  // Region from the location text.
  let region = regionOf(item);
  // If the location didn't tell us, use the search query instead: 'in united states' -> US; 'in canada' (or no query) -> CA;
  // otherwise keep what we had.
  if (region === 'unknown' || region === 'other') region = /\bin united states\b/i.test(j.query) ? 'US' : /\bin canada\b/i.test(j.query) || !j.query ? 'CA' : region;
  // Return a copy with the region added.
  return { ...item, region };
}

/*
 * search(f) — THE main function: run a job search across every source.
 * Input: filters object from the browser (see matches()), plus companies (board specs), web, limit.
 * Returns: { total, results, sources } — total matches, the (limited) list sorted newest first,
 * and per-source info (how many items, any error, when downloaded) for the UI.
 */
async function search(f = {}) {
  // Which job types are wanted (all three if none chosen).
  const wantTypes = f.types?.length ? f.types : ['internship', 'newgrad', 'job'];
  // Which FEEDS to load, based on the wanted types.
  const feedKeys = [];
  // Canadian lists: only for internships, and not when the region is 'any_no_ca'.
  if (wantTypes.includes('internship') && f.region !== 'any_no_ca') feedKeys.push('canada');
  if (wantTypes.includes('internship')) feedKeys.push('internships');
  if (wantTypes.includes('newgrad') || wantTypes.includes('job')) feedKeys.push('newgrad');
  // Company boards to check, at most 25 (slice keeps the first 25).
  const boards = (f.companies || []).slice(0, 25);

  // Load everything AT THE SAME TIME with Promise.all, then destructure the three results:
  const [feeds, boardRes, web] = await Promise.all([
    // feeds: each loadFeed result paired with its key, as [key, result].
    Promise.all(feedKeys.map((k) => loadFeed(k).then((r) => [k, r]))),
    // boardRes: each board's result paired with its spec, as [spec, result].
    Promise.all(boards.map((b) => loadBoard(b).then((r) => [b, r]))),
    // web: web search results — skipped (null) if f.web is false. websearch.js is required here, only when needed.
    // If it fails, return an empty result with the error instead of failing the whole search.
    f.web === false ? null : require('./websearch').searchWeb(f).catch((e) => ({ items: [], sources: { 'web search': { count: 0, error: e.message } } })),
  ]);

  // Per-source status for the UI.
  const sources = {};
  // Every job from every source, before filtering.
  const all = [];
  // For each feed: record its status under its label and add its items. `for (const [k, r] of feeds)` destructures each pair.
  for (const [k, r] of feeds) { sources[FEEDS[k].label] = { count: r.items.length, error: r.error, at: r.at }; all.push(...r.items); }
  // Same for each company board (status saved under the spec, e.g. 'greenhouse:faire').
  for (const [b, r] of boardRes) { sources[b] = { count: r.items.length, error: r.error, at: r.at }; all.push(...r.items); }
  // Web results: merge their source info in and add the items after normalizing them.
  if (web) { Object.assign(sources, web.sources); all.push(...web.items.map(normalizeWeb)); }

  // Duplicate detection: key -> the first copy of that job we kept.
  const seen = new Map();
  // The final list.
  const results = [];
  // keyOf(it): a 'fingerprint' for a job: company|title lowercased with everything except a-z, 0-9 and '|' removed,
  // plus '|' and the first part (before a comma) of the first location — so the same job from two sources gets the same key.
  const keyOf = (it) => lc(`${it.company}|${it.title}`).replace(/[^a-z0-9|]+/g, '') + '|' + lc((it.locations[0] || '').split(',')[0]);
  // Check every job.
  for (const it of all) {
    // Skip jobs that don't pass the filters.
    if (!matches(it, f)) continue;
    const key = keyOf(it);
    // Did we already keep a job with this fingerprint?
    const prev = seen.get(key);
    if (prev) {
      // keep one copy; fill in what the first copy was missing and remember every place it was found
      // aggregator(u): is this URL from a job-aggregator site (Adzuna, Jooble, Indeed, LinkedIn, Glassdoor, ZipRecruiter,
      // Google search) rather than the company's own site? (`u || ''` avoids errors for missing URLs.)
      const aggregator = (u) => /adzuna|jooble|indeed|linkedin|glassdoor|ziprecruiter|google\.com\/search/i.test(u || '');
      if (it.url && (!prev.url || (aggregator(prev.url) && !aggregator(it.url)))) prev.url = it.url; // prefer the company's own apply link
      // Fill in a missing description or date from this copy.
      if (!prev.desc && it.desc) prev.desc = it.desc;
      if (!prev.posted && it.posted) prev.posted = it.posted;
      // Add this source to the list of places it was found (a Set removes duplicates; spread turns it back into an array).
      prev.foundOn = [...new Set([...(prev.foundOn || []), it.via || it.source])];
      // Don't add the duplicate itself.
      continue;
    }
    // First time seeing this job: copy it, make sure it has a region, and start its foundOn list (filter(Boolean) drops empty names).
    const item = { ...it, region: it.region || regionOf(it), foundOn: [it.via || it.source].filter(Boolean) };
    // Remember it for duplicate detection, and add it to the results.
    seen.set(key, item);
    results.push(item);
  }
  // Sort newest first (a positive result puts b before a).
  results.sort((a, b) => b.posted - a.posted);
  // How many to return: f.limit or 300 by default, but never more than 600.
  const limit = Math.min(Number(f.limit) || 300, 600);
  // Send back the total count, the first `limit` results, and the per-source status.
  return { total: results.length, results: results.slice(0, limit), sources };
}

// ---------- Job description fetch ----------
/*
 * isPrivateHost(host) — safety check: is this hostname a private/internal address?
 * Input: hostname. Returns: true if private. We refuse to fetch those so nobody can use our server
 * to reach machines on the local network (an attack called SSRF).
 * Regex 1: starts with localhost, 127. (this machine), 10., 192.168., 169.254. (private ranges), 0., or is ::1 (IPv6 localhost).
 * Regex 2: 172.16. to 172.31. (another private range: 1[6-9] = 16-19, 2\d = 20-29, 3[01] = 30-31).
 * Also: anything ending in .local (local network names).
 */
function isPrivateHost(host) {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');
}

/*
 * jobText(rawUrl) — get a job posting's title, company, location and full description text from its link.
 * Input: the job URL. Returns: (Promise of) { title, company, location, text }. Throws friendly errors.
 * Tries the clean APIs of Greenhouse/Lever first, then structured data in the page, then the visible page text.
 */
async function jobText(rawUrl) {
  // Will hold the parsed URL.
  let u;
  // new URL() parses the link into parts (protocol, hostname, pathname, ...) and throws if it isn't a valid URL.
  try { u = new URL(rawUrl); } catch { throw new Error('That doesn’t look like a link'); }
  // Only allow http:/https: links to public hosts (protocol regex: 'http' + optional 's' + ':').
  if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) throw new Error('Only public job links are supported');

  // Clean APIs for common ATSes
  // m will hold regex match results.
  let m;
  // Greenhouse job page (hostname ends with greenhouse.io) with a path like '/<company>/jobs/<number>'
  // (optionally after '/embed/job_app?...'). m[1] = company board name, m[2] = job id (digits).
  if (/greenhouse\.io$/.test(u.hostname) && (m = u.pathname.match(/^\/(?:embed\/job_app\?.*)?([^/]+)\/jobs\/(\d+)/))) {
    // Ask Greenhouse's API for that one job.
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`);
    // Return the details; the description HTML is converted to text.
    return { title: d.title, company: d.company_name || m[1], location: d.location?.name || '', text: htmlToText(d.content || '') };
  }
  // Greenhouse embed link that uses query parameters instead: ?for=<company>&gh_jid=<job id>.
  if (/greenhouse\.io$/.test(u.hostname) && u.searchParams.get('gh_jid') && (m = u.searchParams.get('for'))) {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${m}/jobs/${u.searchParams.get('gh_jid')}`);
    return { title: d.title, company: d.company_name || m, location: d.location?.name || '', text: htmlToText(d.content || '') };
  }
  // Lever job page: jobs.lever.co/<company>/<36-character id made of hex digits and dashes>.
  if (u.hostname === 'jobs.lever.co' && (m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/))) {
    // Ask Lever's API for that posting.
    const d = await getJSON(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`);
    // Lever splits descriptions into titled lists (Responsibilities, Requirements, ...): turn each into 'title + text'.
    const lists = (d.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join('\n\n');
    // Combine: main description (plain or converted), the lists, and any additional info, separated by blank lines.
    return { title: d.text, company: m[1], location: d.categories?.location || '', text: `${d.descriptionPlain || htmlToText(d.description)}\n\n${lists}\n\n${d.additionalPlain || ''}`.trim() };
  }

  // Generic page: prefer schema.org JobPosting JSON-LD (Workday, iCIMS, many career sites), else visible text
  // Download the page (follow redirects, give up after 20 seconds).
  const r = await fetch(u, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  // Error status -> ask the user to paste the description instead.
  if (!r.ok) throw new Error(`The site returned ${r.status}. Paste the description instead.`);
  // The page's HTML as text.
  const html = await r.text();
  // Look at every <script type="application/ld+json"> block: many career sites put machine-readable job data there.
  // [^>]+ / [^>]* = the rest of the tag's attributes; ([\s\S]*?) captures the script's contents.
  for (const block of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      // Parse the block's contents as JSON.
      const data = JSON.parse(block[1].trim());
      // Some pages wrap several items in '@graph'; [].concat(x) makes sure we have an array either way.
      const list = [].concat(data['@graph'] || data);
      // Find the item whose @type is 'JobPosting' (or a list of types that includes it).
      const jp = list.find((x) => x && (x['@type'] === 'JobPosting' || (Array.isArray(x['@type']) && x['@type'].includes('JobPosting'))));
      // Found one with a description?
      if (jp?.description) {
        // Its first location's address (jobLocation may be a single object or an array).
        const loc = [].concat(jp.jobLocation || [])[0]?.address;
        // Return the details; location = 'City, Region' from the address (if any).
        return { title: jp.title || '', company: jp.hiringOrganization?.name || '', location: loc ? [loc.addressLocality, loc.addressRegion].filter(Boolean).join(', ') : '', text: htmlToText(jp.description) };
      }
    } catch { /* ignore bad JSON-LD */ }
  }
  // Fallback: the page title from <title>...</title>, with entities decoded.
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  // Text of the <main> section if there is one, else the <body>, else the whole HTML.
  const text = htmlToText((html.match(/<main[\s\S]*?<\/main>/i) || html.match(/<body[\s\S]*<\/body>/i) || [html])[0]);
  // Very little text usually means the page builds its content with JavaScript, which we can't run here.
  if (text.length < 300) throw new Error('This site loads its job description with JavaScript, so I can’t read it. Paste the description instead.');
  // Return the visible text, capped at 20,000 characters.
  return { title, company: '', location: '', text: text.slice(0, 20000) };
}

// What this file shares with server.js / pages.js. _cache is exposed (with an underscore = 'internal') e.g. for testing.
module.exports = { search, jobText, htmlToText, inferTerms, parseReadmeTables, regionOf, isPrivateHost, UA, _cache: cache };
