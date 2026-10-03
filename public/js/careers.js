/*
 * careers.js — the "careers" page: a job/internship finder plus a resume helper.
 *
 * The page has 4 tabs:
 *   - find:    search for internships/jobs. The browser sends your filters to OUR server
 *              (POST /api/jobs/search, handled in jobs.js), which gathers postings from many
 *              lists and job boards. Each result then gets a "fit score" for how well it matches you.
 *   - tailor:  paste a job posting and the AI (via ask() in ai.js) writes a resume, CV or cover
 *              letter tailored to it, built ONLY from your real resume. You can save it as a PDF.
 *   - tracker: saved jobs sorted into columns (saved / applied / interview / offer / rejected).
 *   - profile: your default resume + info about you (skills, roles you want, work authorization…).
 *
 * Main ideas for a beginner:
 *   1. Turning a typed sentence ("summer 2027 co-op in toronto or remote") into filters, using
 *      regular expressions (regex = a pattern for matching text) — see parseJobQuery().
 *   2. Fit scoring: count overlaps between the job's text and your skills/roles/resume — fitScore().
 *   3. Prompt design: the AI instructions strictly forbid inventing experience — docPrompt().
 *   4. Printing to PDF: open a new window with nicely styled HTML and call print() — printDoc().
 * All your data is saved in the browser through store.js (nothing about you is kept on the server).
 */
// Careers: find internships/jobs that fit you, tailor resumes/CVs/cover letters, track applications.
// store = the app's saved data; addEvents = put events (like deadlines) on the calendar.
import { store, addEvents } from './store.js';
// aiEnabled = is an AI set up? ask = send a prompt to the AI; getStatus = status; isBrowserMode = hosted website (no server).
import { aiEnabled, ask, getStatus, isBrowserMode } from './ai.js';
// webjobs = the free, no-key, browser-direct job search used on the hosted website.
import * as webjobs from './webjobs.js';
// Small helpers: esc (make text safe for HTML), md (Markdown -> HTML), uid (random id), todayISO (today as
// "YYYY-MM-DD", imported but not used in this file), fmtDate (pretty date), extractJSON (pull JSON out of an AI reply).
import { esc, md, uid, todayISO, fmtDate, extractJSON } from './util.js';
// UI helpers: toast (small pop-up message), readFileText (read a PDF/Word/photo as text), enableImagePaste
// (paste a screenshot into a textarea), ACCEPT (allowed file types), spinner (loading dots), modal (pop-up dialog).
import { toast, readFileText, enableImagePaste, ACCEPT, spinner, modal } from './ui.js';

// car(): shortcut that returns the careers part of the saved data.
// `() => ...` is an arrow function: a short way to write a function that returns the value after =>.
const car = () => store.get().careers;
// updCar(fn): change the careers data. store.update gives us the whole state `s`, and we pass
// only `s.careers` to fn. store.update then saves everything and tells the app to refresh.
const updCar = (fn) => store.update((s) => fn(s.careers));

// ============ Query parsing ("summer 2027 software internships in nyc or remote") ============
// CITY_ALIASES: words someone might type -> the location name we filter on.
// Keys with spaces or accents need quotes ('new york'); simple keys don't (toronto).
// Cities map to the city name; provinces/states map to their short code (ontario -> 'ON').
// (Note: 'toronto' appears twice; in JavaScript the later one simply wins, and both say 'Toronto'.)
const CITY_ALIASES = {
  // Canadian cities and regions (gta = Greater Toronto Area, kw = Kitchener-Waterloo).
  toronto: 'Toronto', gta: 'ON', 'greater toronto': 'ON', vancouver: 'Vancouver', montreal: 'Montreal', 'montréal': 'Montreal', waterloo: 'Waterloo',
  kitchener: 'Kitchener', 'kitchener-waterloo': 'Waterloo', kw: 'Waterloo', ottawa: 'Ottawa', calgary: 'Calgary', edmonton: 'Edmonton',
  mississauga: 'Mississauga', markham: 'Markham', brampton: 'Brampton', oakville: 'Oakville', hamilton: 'Hamilton', guelph: 'Guelph',
  winnipeg: 'Winnipeg', halifax: 'Halifax', victoria: 'Victoria', burnaby: 'Burnaby', saskatoon: 'Saskatoon', regina: 'Regina', kelowna: 'Kelowna',
  // Canadian provinces -> two-letter codes.
  'quebec city': 'Quebec City', ontario: 'ON', 'british columbia': 'BC', bc: 'BC', alberta: 'AB', quebec: 'QC', 'québec': 'QC', manitoba: 'MB',
  'nova scotia': 'NS', 'new brunswick': 'NB', saskatchewan: 'SK',
  // US cities, nicknames (nyc, sf, philly) and regions (bay area -> California).
  nyc: 'New York', 'new york': 'New York', manhattan: 'New York', brooklyn: 'New York', sf: 'San Francisco', 'san francisco': 'San Francisco',
  'bay area': 'CA', 'silicon valley': 'CA', la: 'Los Angeles', 'los angeles': 'Los Angeles', boston: 'Boston', seattle: 'Seattle', chicago: 'Chicago',
  austin: 'Austin', dc: 'Washington', 'washington dc': 'Washington', atlanta: 'Atlanta', miami: 'Miami', denver: 'Denver', philly: 'Philadelphia',
  // More cities, plus US states -> two-letter codes.
  philadelphia: 'Philadelphia', pittsburgh: 'Pittsburgh', toronto: 'Toronto', london: 'London', california: 'CA', texas: 'TX', 'new jersey': 'NJ',
  massachusetts: 'MA', washington: 'WA', illinois: 'IL', 'north carolina': 'NC', georgia: 'GA', florida: 'FL', colorado: 'CO', 'san diego': 'San Diego',
  'san jose': 'San Jose', 'mountain view': 'Mountain View', 'palo alto': 'Palo Alto', 'menlo park': 'Menlo Park', dallas: 'Dallas', houston: 'Houston',
  // The United Kingdom.
  uk: 'UK',
};
// CATEGORY_WORDS: for each job field, a regex of words that signal it.
// \b means "word boundary", so \b(ml)\b matches "ml" as a whole word, not inside "html".
// (a|b|c) means "a or b or c". A dot "." matches any single character and "?" makes it optional,
// so full.?stack matches "fullstack", "full stack" and "full-stack".
const CATEGORY_WORDS = {
  // Software: software, swe (software engineer), sde (software dev engineer), developer, coding, full/back/front-end, web, mobile, ios, android.
  software: /\b(software|swe|sde|developer|coding|full.?stack|back.?end|front.?end|web|mobile|ios|android)\b/,
  // Data/AI: data, ml, machine learning, ai, analytics, data science.
  data: /\b(data|ml|machine learning|ai|analytics|data science)\b/,
  // Quantitative finance: quant or trading.
  quant: /\b(quant|trading)\b/,
  // Product management: product, pm (product manager), apm (associate PM).
  product: /\b(product|pm|apm)\b/,
  // Hardware/engineering: hardware, electrical, embedded, robotics, mechanical.
  hardware: /\b(hardware|electrical|embedded|robotics|mechanical)\b/,
  // Design: design, ux, ui.
  design: /\b(design|ux|ui)\b/,
  // Research: the whole word "research".
  research: /\bresearch\b/,
  // Business: business, finance, consulting, marketing, banking, operations, strategy.
  business: /\b(business|finance|consulting|marketing|banking|operations|strategy)\b/,
  // Psychology / people roles: psych, psychology, behavioral, clinical, mental health.
  psych: /\b(psych|psychology|behavioral|clinical|mental health)\b/,
};
// Friendly names for each category, shown on the filter chips. `export` lets other files import it.
export const CATEGORY_LABELS = { software: 'software', data: 'data / ai', quant: 'quant', product: 'product', hardware: 'hardware', design: 'design', research: 'research', business: 'business', psych: 'psych / people' };

// Canadian-first work authorization. Old US values are mapped on read.
// WORK_AUTH: the choices in the profile's "work authorization" dropdown: saved code -> label shown.
export const WORK_AUTH = {
  // Canadian citizen.
  ca_citizen: 'Canadian citizen',
  // Canadian permanent resident (PR).
  ca_pr: 'Canadian permanent resident',
  // International student who can work through a study/co-op permit.
  ca_study: 'international student (study permit / co-op work permit)',
  // Open work permit, e.g. the post-graduation work permit.
  ca_open: 'open work permit (e.g. PGWP)',
  // Needs an employer to sponsor them (LMIA = Canada's labour market impact assessment).
  ca_needs: 'will need employer sponsorship (LMIA)',
  // Allowed to work in both Canada and the US.
  dual: 'Canadian + US citizen / green card',
};
// Older versions of the app saved US-style codes. This maps them to the new codes.
const LEGACY_AUTH = { citizen: 'ca_citizen', permanent: 'ca_pr', needs: 'ca_needs' };
// workAuthOf(p): input = a profile object; returns a valid WORK_AUTH code.
// If p.workAuth is already a known code, use it; otherwise translate an old code; otherwise assume 'ca_citizen'.
// (`a ? b : c` is the ternary operator: "if a then b else c". `x || y` = "x, or y if x is empty".)
export const workAuthOf = (p) => (WORK_AUTH[p.workAuth] ? p.workAuth : LEGACY_AUTH[p.workAuth] || 'ca_citizen');
/*
 * authFlags(p) — turns your work authorization into simple yes/no flags the server understands,
 * so jobs.js can hide postings you aren't allowed to take.
 * Input: the profile object. Returns: { usNeedsVisa, caNotPR, caNotCitizen } (all true/false).
 */
function authFlags(p) {
  // Your work-authorization code, e.g. 'ca_study'.
  const a = workAuthOf(p);
  // Build and return the object of flags.
  return {
    // Everyone except "dual" needs a visa to work in the US.
    usNeedsVisa: a !== 'dual', // Canadians need a US visa (usually J-1 for internships, TN for full-time)
    // Not a Canadian citizen or PR (student, open permit, or needs sponsorship). .includes checks if a is in the list.
    caNotPR: ['ca_study', 'ca_open', 'ca_needs'].includes(a),
    // A PR is not a citizen (matters for jobs that require Canadian citizenship).
    caNotCitizen: a === 'ca_pr',
  };
}

/*
 * parseJobQuery(q) — turns a typed sentence into search filters.
 * Example: "summer 2027 software co-op in toronto or remote" ->
 *   { types: ['internship'], terms: ['Summer 2027'], locations: ['Toronto'], categories: ['software'], remoteOk: true, ... }
 * Input: q = the text typed in the search box.
 * Returns: a filters object (the same shape the filter controls use).
 */
export function parseJobQuery(q) {
  // Lowercase the text and add a space on each side (a template literal: backticks with ${...} inserting a value).
  // The extra spaces make whole-word matching at the start/end easier.
  const t = ` ${q.toLowerCase()} `;
  // Start with "no filters": empty lists, false flags, 0 = any posting date, no keyword.
  const f = { types: [], terms: [], locations: [], categories: [], remote: false, remoteOk: false, postedWithinDays: 0, keywords: '' };
  // Internship: matches "intern", "interns", "internship", "internships" as whole words, or "coop"/"co-op".
  // (ship)? and s? are optional parts; -? is an optional dash. .test(t) returns true/false.
  if (/\bintern(ship)?s?\b|co-?op/.test(t)) f.types.push('internship');
  // New grad: "new grad"/"newgrad", "entry level"/"entry-level", "early career", or "graduate role".
  if (/new ?grad|entry.?level|early career|graduate role/.test(t)) f.types.push('newgrad');
  // Full-time jobs: "full time"/"full-time", or the word "job"/"jobs" when "intern" doesn't come later
  // ((?!.*intern) = "not followed anywhere later by intern"). Only used if no type was found yet,
  // and then it means both new-grad roles and other jobs.
  if (/\bfull.?time\b|\bjobs?\b(?!.*intern)/.test(t) && !f.types.length) f.types.push('newgrad', 'job');
  // Today's date, used to guess the year when someone types a season without one.
  const now = new Date();
  // The month (0 = January) each term starts in, used to decide if this year's term has already begun.
  const SEASON_START = { Winter: 0, Spring: 2, Summer: 4, Fall: 8 }; // co-op terms: winter jan–apr, summer may–aug, fall sep–dec
  // Find every season mention. The regex: a season word (captured as m[1]), optional spaces (\s*),
  // an optional apostrophe ('?), then an optional year (m[2]): either "20" + 2 digits (2027) or just 2 digits (27).
  // The g flag + matchAll gives us every match, not just the first. `for...of` loops over them.
  for (const m of t.matchAll(/\b(summer|fall|autumn|spring|winter)\s*'?(20\d{2}|\d{2})?\b/g)) {
    // Turn the season into a capitalized name: "autumn" becomes "Fall"; otherwise uppercase the first
    // letter (m[1][0]) and add the rest (.slice(1)), e.g. "summer" -> "Summer".
    const season = m[1] === 'autumn' ? 'Fall' : m[1][0].toUpperCase() + m[1].slice(1);
    // The year: if one was typed, use it ("27" becomes "2027"). If not, use this year — or next year
    // if we're already in/past that term's start month (true counts as 1, so we add 1 or 0).
    const y = m[2] ? (m[2].length === 2 ? '20' + m[2] : m[2]) : String(now.getFullYear() + (now.getMonth() >= SEASON_START[season] ? 1 : 0));
    // Add e.g. "Summer 2027" to the list of terms.
    f.terms.push(`${season} ${y}`);
  }
  // Did they mention Canada? Matches "canada" or "canadian".
  const saysCanada = /\bcanad(a|ian)\b/.test(t);
  // Did they mention the US? Matches "us", "usa", "u.s." (\. is a literal dot), "united states", "america", "american".
  const saysUS = /\b(us|usa|u\.s\.|united states|america|american)\b/.test(t);
  // Pick the region: both -> 'CA_US'; only US -> 'US'; "anywhere/worldwide/global" -> 'any'; otherwise Canada ('CA').
  // (Chained ternaries: read it as if / else if / else if / else.)
  f.region = saysCanada && saysUS ? 'CA_US' : saysUS ? 'US' : /\b(anywhere|worldwide|global)\b/.test(t) ? 'any' : 'CA';
  // If the word "remote" appears…
  if (/\bremote\b/.test(t)) {
    // …and it's phrased as an extra option ("or remote", "remote or", "remote ok", "+remote"/"+ remote"),
    // or there's also an "in <place>" in the sentence (we check for "in" after removing the word remote),
    // then remote is ALLOWED alongside locations (remoteOk)…
    if (/\bor remote\b|remote or|remote ok|\+ ?remote/.test(t) || /\bin\b/.test(t.replace(/remote/g, ''))) f.remoteOk = true;
    // …otherwise they want remote ONLY.
    else f.remote = true;
  }
  // All the alias words, sorted longest first, so longer names like "kitchener-waterloo" or "greater toronto"
  // are checked (and listed) before shorter ones like "waterloo" or "toronto". Every alias that matches is
  // still added. (sort's compare function: b.length - a.length puts longer strings first.)
  const aliasKeys = Object.keys(CITY_ALIASES).sort((a, b) => b.length - a.length);
  // For each alias…
  for (const k of aliasKeys) {
    // …build a regex for it as a whole word (new RegExp makes a regex from a string; "\\b" in a string becomes \b),
    // and if it appears and we haven't already added that location, add it.
    if (new RegExp(`\\b${k}\\b`).test(t) && !f.locations.includes(CITY_ALIASES[k])) f.locations.push(CITY_ALIASES[k]);
  }
  // If they named places AND said remote, they mean "these places or remote", not "remote only".
  if (f.locations.length && f.remote) { f.remote = false; f.remoteOk = true; }
  // Check each field's regex. Object.entries gives [key, value] pairs; `const [k, re]` "destructures" each pair
  // into two variables. If the regex matches, add that category.
  for (const [k, re] of Object.entries(CATEGORY_WORDS)) if (re.test(t)) f.categories.push(k);
  // Posting date: "today", "past day" or "last 24" (hours) -> only the last 1 day.
  if (/\b(today|past day|last 24)/.test(t)) f.postedWithinDays = 1;
  // "this week", "past week", "last week", "new" or "recent" -> last 7 days.
  else if (/\b(this week|past week|last week|new|recent)\b/.test(t)) f.postedWithinDays = 7;
  // "this month" or "past month" -> last 30 days.
  else if (/\b(this month|past month)\b/.test(t)) f.postedWithinDays = 30;
  // Keyword: the word right after "at", "with" or "using", e.g. "using python" -> "python".
  // (?:...) groups without capturing; \s+ = spaces; ([a-z0-9+#.]+) captures letters/digits/+/#/. (so "c++", "c#", "node.js" work).
  const kw = t.match(/\b(?:at|with|using)\s+([a-z0-9+#.]+)/);
  // Use it, unless that word is actually a place (e.g. "at google" is fine, "at toronto" is a location).
  if (kw && !CITY_ALIASES[kw[1]]) f.keywords = kw[1];
  // Hand back the finished filters.
  return f;
}

// ============ Fit scoring against profile + resume ============
// STOP: very common words that tell us nothing about fit ("and", "team", "skills"…), so we ignore them.
// We split one long string on spaces into an array, and put it in a Set (a list with no duplicates
// and very fast "is this word in it?" checks via .has()).
const STOP = new Set('and or the a an of to in for with on at by from as is are be this that your you our we will work team using experience skills ability strong'.split(' '));
/*
 * profileTokens() — breaks your profile and resume into lists of words/phrases to compare against jobs.
 * Input: none (reads the saved careers data).
 * Returns: { skills, roles, resumeWords, prefLocs }
 *   skills/roles/prefLocs = arrays of lowercase phrases, resumeWords = a Set of words from your resume.
 */
function profileTokens() {
  // Destructuring with renaming: take `profile` out of the careers data and call it `p`, and take `resume` as is.
  const { profile: p, resume } = car();
  // Skills: `${p.skills}` makes sure it's a string; lowercase; split on commas, semicolons or new lines
  // ([,;\n]+ = one or more of those); .map trims spaces off each piece; .filter(Boolean) drops empty pieces.
  const skills = `${p.skills}`.toLowerCase().split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  // Target roles, split the same way (e.g. "software engineering, ux research").
  const roles = `${p.targetRoles}`.toLowerCase().split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  // Every word in the resume: a letter followed by at least one more letter or + # . (so "c++" and "node.js" count).
  // match returns null if nothing is found, so `|| []` gives an empty array. Drop stop-words, then put them in a Set.
  const resumeWords = new Set((resume.toLowerCase().match(/[a-z][a-z+#.]{1,}/g) || []).filter((w) => !STOP.has(w)));
  // Return everything. prefLocs = your preferred locations, split on commas/semicolons the same way.
  // (Writing just `skills` inside { } is shorthand for `skills: skills`.)
  return { skills, roles, resumeWords, prefLocs: `${p.locations}`.toLowerCase().split(/[,;]+/).map((s) => s.trim()).filter(Boolean) };
}
/*
 * fitScore(job, tok) — how well does a job match you? (A simple points system, not AI.)
 * Inputs: job = a job object from the server; tok = your profile words (computed if not given —
 *   `tok = profileTokens()` is a default parameter value).
 * Returns: { score: 0–99, matched: [your skills found in the job] }.
 * Points: 20 base + 30 if one of your target roles fits + up to 30 for matching skills (10 each)
 *   + up to 10 for resume words in the title (4 each) + 5 for location + up to 5 for being recently posted.
 */
export function fitScore(job, tok = profileTokens()) {
  // The text we search in ("haystack"): title, category and description, lowercased. `job.desc || ''` avoids "undefined".
  const hay = `${job.title} ${job.category} ${job.desc || ''}`.toLowerCase();
  // Your skills that appear somewhere in the job text.
  const matched = tok.skills.filter((s) => s && hay.includes(s));
  // Role match: true if for SOME target role (.some), EVERY word of it (.every) appears in the job text.
  // E.g. "ux research" matches if both "ux" and "research" appear.
  const roleHit = tok.roles.some((r) => r.split(/\s+/).every((w) => hay.includes(w)));
  // How many words of 3+ letters in the job title (not stop-words) also appear in your resume.
  const resumeHits = (job.title.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOP.has(w) && tok.resumeWords.has(w)).length;
  // Location is OK if: you have no preferred locations, OR the job is remote, OR any preferred location
  // appears in the job's location list.
  const locHit = !tok.prefLocs.length || job.remote || tok.prefLocs.some((l) => job.locations.join(' ').toLowerCase().includes(l));
  // Freshness from 1 (posted just now) down to 0 (30+ days old). Dates are in milliseconds; 86400000 ms = 1 day.
  // Math.max(0, ...) stops it going negative. Jobs with no posted date get a middling 0.3.
  const fresh = job.posted ? Math.max(0, 1 - (Date.now() - job.posted) / (30 * 86400000)) : 0.3;
  // Add up the points (see the function description above). Math.min caps each part.
  let score = 20 + (roleHit ? 30 : 0) + Math.min(30, matched.length * 10) + Math.min(10, resumeHits * 4) + (locHit ? 5 : 0) + fresh * 5;
  // If you haven't filled in any skills, roles or resume, we can't judge fit at all, so score 0 (no badge shown).
  if (!tok.skills.length && !tok.roles.length && !tok.resumeWords.size) score = 0;
  // Round to a whole number, cap at 99 (never "100% perfect"), and return it with the matched skills.
  return { score: Math.round(Math.min(99, score)), matched };
}

// ============ Document generation ============
// The three kinds of documents the tailor tab can write: key -> { label shown on the button, tooltip text }.
const DOC_KINDS = {
  // A one-page resume.
  resume: { label: 'resume', desc: '1 page, tailored bullets' },
  // A longer academic CV (curriculum vitae).
  cv: { label: 'CV', desc: 'full academic CV' },
  // A cover letter.
  cover: { label: 'cover letter', desc: '3–4 paragraphs' },
};

/*
 * profileBlock() — your profile as plain text lines ("Name: Ada", "Skills: python, spss"…) for the AI prompt.
 * Input: none (reads the saved profile). Returns: a string with one "Label: value" per line,
 * skipping anything you left empty.
 */
function profileBlock() {
  // Your saved profile.
  const p = car().profile;
  // Build an object of label -> value, then turn it into [label, value] pairs with Object.entries.
  return Object.entries({
    Name: p.name, Email: p.email, Phone: p.phone, Location: p.location, Links: p.links, School: p.school, Degree: p.degree,
    // Work authorization is stored as a code, so look up its readable label in WORK_AUTH.
    'Graduation': p.gradDate, GPA: p.gpa, 'Work authorization': WORK_AUTH[workAuthOf(p)],
    'Target roles': p.targetRoles, Skills: p.skills, 'Other things about me': p.extra,
  // .filter keeps pairs whose value isn't empty: `([, v])` destructures the pair, skipping the first item (the label).
  // .map turns each pair into "Label: value", and .join('\n') puts them on separate lines.
  }).filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/*
 * docPrompt(kind, job) — writes the instructions ("prompt") we send to the AI to create a document.
 * Inputs: kind = 'resume' | 'cv' | 'cover'; job = { company, title, location, text } from the tailor tab.
 * Returns: { system, user } — `system` is the AI's rules/role, `user` is the actual material
 *   (the job posting, your profile and your resume).
 * Prompt design idea: the most important rule is HONESTY. The AI may reorder and reword what's really
 * in your resume, but must never invent jobs, dates, numbers or skills.
 */
function docPrompt(kind, job) {
  // The honesty rules (a multi-line template literal; line breaks inside backticks are kept as real new lines).
  // They say: use ONLY facts from the resume/profile, never invent employers/titles/dates/degrees/awards/
  // metrics/technologies; you MAY reorder, pick bullets, use stronger verbs and mirror the job's wording
  // only when it's true; and don't add numbers that aren't in the source.
  const rules = `STRICT HONESTY RULES:
- Use ONLY facts found in the candidate's resume and profile. Never invent employers, titles, dates, degrees, awards, metrics, or technologies.
- You MAY reorder sections, choose which bullets to include, rephrase bullets with stronger verbs, and mirror the job's wording WHEN it truthfully describes what the candidate did.
- If a number isn't in the source, don't add one.`;
  // The format instructions, one per document kind. We write an object with all three and then
  // immediately pick the one we need with `[kind]` (the `}[kind]` at the end).
  const format = {
    // Resume: a one-page, ATS-friendly (ATS = the "applicant tracking system" software companies use to scan resumes)
    // Markdown resume with an exact structure: # name, a contact line, ## Education, ## Experience
    // (### Title — Organization | Location | Dates, 2–4 bullets, most relevant first), optional Projects and
    // Leadership sections only if they exist, ## Skills grouped as "**Category:** items", ordered by relevance,
    // about 450–600 words. (Our md() turns # into the big name heading and ## into section headings.)
    resume: `Write a ONE-PAGE, ATS-friendly resume in Markdown using exactly this structure:
# Full Name
email · phone · location · links (one line, only what's provided)
## Education
### School — Degree | Dates
- GPA / relevant coursework / honors (only if provided)
## Experience
### Title — Organization | Location | Dates
- 2–4 bullets, strongest and most relevant to the job first
## Projects   (only if the source has projects)
## Leadership & Activities   (only if present)
## Skills
- **Category:** comma-separated items
Order experience and bullets by relevance to the job. Keep it to what fits on one page (about 450–600 words).`,
    // CV: a complete academic CV in Markdown with sections like Education, Research, Publications, Teaching,
    // Honors… but only sections that have real content; "### Role — Organization | Dates" headings; can be longer than a page.
    cv: `Write a complete academic-style CV in Markdown:
# Full Name
contact line
## Education  ## Research Experience  ## Professional Experience  ## Publications & Presentations  ## Teaching  ## Honors & Awards  ## Skills  ## Activities
Only include sections that have real content in the source. Use "### Role — Organization | Dates" headings with bullets. A CV can be longer than one page; include everything relevant.`,
    // Cover letter: name + contact line, date, "Dear Hiring Team," (or a named manager), 3–4 short paragraphs
    // (why this specific role, 2 real examples matching the job, a confident close), signed with the name,
    // warm not generic, under 350 words.
    cover: `Write a cover letter in Markdown:
# Full Name
contact line
Then the date, "Dear Hiring Team," (or the hiring manager's name if given), 3–4 short paragraphs: why this role/company specifically (use details from the posting), 2 concrete examples from the candidate's real experience that match the job's requirements, and a confident close. Sign off with the candidate's name. Warm and genuine, not generic; under 350 words.`,
  }[kind];
  // Return the two parts of the prompt.
  return {
    // system: sets the AI's role ("expert career coach for Canadian university students"), inserts the honesty
    // rules, then Canadian conventions: Canadian spelling; never a photo, age, birth date, SIN, marital status or
    // nationality; only mention immigration status if the posting asks; say "co-op" where it applies; Canadian
    // date style; write in French if the posting is in French. Then the chosen format (\n\n = blank lines).
    // Finally it asks for a line "===NOTES===" followed by: what was tailored, keywords from the posting you're
    // missing (real gaps only), and 1–3 honest tips. Later we split the reply at ===NOTES=== to separate
    // the document from these notes.
    system: `You are an expert career coach and resume writer for Canadian university students. ${rules}
CANADIAN CONVENTIONS:
- Use Canadian English spelling (colour, centre, behaviour, analyse, program, cheque; "-ize" endings are fine).
- Never include a photo, age, date of birth, SIN, marital status, or nationality. Only mention work authorization or immigration status if the posting explicitly asks for it.
- Say "co-op" when the role is a co-op; list co-op work terms like any other experience. Canadian dates are fine as "Sept. 2025 – Apr. 2026".
- If the job posting is written in French, write the whole document in French.\n\n${format}\n\nAfter the document, output a line with exactly ===NOTES=== and then:\n- **What I tailored:** 2–4 bullets\n- **Keywords from the posting you're missing:** comma list (only real gaps, no fabrications)\n- **Tips:** 1–3 honest suggestions to strengthen the application`,
    // user: the material. A "# Job posting" section with company and title ('unknown' if blank), the location
    // line only if we have one, and the posting text cut to its first 14,000 characters (.slice) so the
    // prompt doesn't get too long. Then "# Candidate profile" (from profileBlock, or "(none)") and
    // "# Candidate's default resume" (also cut to 14,000 characters, or "(none provided)").
    user: `# Job posting\nCompany: ${job.company || 'unknown'}\nTitle: ${job.title || 'unknown'}\n${job.location ? 'Location: ' + job.location + '\n' : ''}\n${job.text.slice(0, 14000)}\n\n# Candidate profile\n${profileBlock() || '(none)'}\n\n# Candidate's default resume\n${car().resume.slice(0, 14000) || '(none provided)'}`,
  };
}

// Offline: keyword gap report so the tab still does something useful without AI.
/*
 * localKeywordReport(jobTextStr) — without AI, compare the posting's most common words with your resume.
 * Input: the job description text.
 * Returns: { have: words from the posting your resume/skills include,
 *            missing: up to 15 frequent posting words your resume doesn't mention }.
 */
function localKeywordReport(jobTextStr) {
  // All words of 3+ characters (a letter, then 2+ letters or + # .), minus stop-words. `|| []` handles "no matches".
  const words = (jobTextStr.toLowerCase().match(/[a-z][a-z+#.]{2,}/g) || []).filter((w) => !STOP.has(w));
  // freq will count how many times each word appears: { python: 4, data: 7, ... }.
  const freq = {};
  // For each word, add 1 to its count (`freq[w] || 0` starts unseen words at 0).
  words.forEach((w) => (freq[w] = (freq[w] || 0) + 1));
  // Your resume plus your skills list, lowercased, as one big string to search in.
  const resume = car().resume.toLowerCase() + ' ' + car().profile.skills.toLowerCase();
  // The 40 most frequent words longer than 3 letters: turn freq into [word, count] pairs, keep long words,
  // sort by count (b[1] - a[1] = highest count first), take the first 40, keep only the word.
  const top = Object.entries(freq).filter(([w]) => w.length > 3).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w]) => w);
  // Top words that your resume already contains.
  const have = top.filter((w) => resume.includes(w));
  // Top words your resume doesn't contain (at most 15).
  const missing = top.filter((w) => !resume.includes(w)).slice(0, 15);
  // Return both lists.
  return { have, missing };
}

// ============ Printing (Save as PDF) ============
/*
 * printDoc(body, title) — opens a print-ready page so you can "Save as PDF" from the print dialog.
 * (Browsers can't make PDFs directly from JS without a library; printing to PDF is the zero-dependency trick.)
 * Inputs: body = Markdown text of the document; title = the window/PDF file title.
 * Returns: nothing (or the toast result if pop-ups are blocked). Also used by notes.js to print notes.
 */
export function printDoc(body, title) {
  // Open a new, empty browser tab/window ('' = no address, '_blank' = new window).
  const w = window.open('', '_blank');
  // If the browser blocked the pop-up, w is null: tell the user and stop. (return toast(...) both shows and exits.)
  if (!w) return toast('allow pop-ups to download the PDF');
  // Write a whole HTML page into the new window. The template contains:
  //   - <title> = the escaped title (becomes the suggested PDF file name),
  //   - a link loading the "DM Serif Display" and "DM Sans" fonts from Google Fonts,
  //   - a <style> block: @page sets US-letter paper and margins; body sets the font, size, line height, colour;
  //     h2 (the "# Name" line) is big and serif, the paragraph right after it (the contact line) is small and grey;
  //     h3 (section headings) are small uppercase with a line underneath; h4 (job titles) are bold;
  //     lists and paragraphs get tight spacing; <mark> highlighting is turned off for print;
  //     .cover paragraphs (cover letters) are a bit larger with more space between them,
  //   - <body> gets class "cover" if the title mentions "cover" (/cover/i = the word cover, any capitalisation),
  //   - and the document itself, converted from Markdown to HTML by md().
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:opsz,wght@9..40,400;9..40,600&display=swap" rel="stylesheet">
  <style>
    @page { size: letter; margin: .55in .6in; }
    body { font: 10.5pt/1.38 'DM Sans', Helvetica, Arial, sans-serif; color: #1d1712; margin: 0; }
    h2 { font: 400 25pt/1 'DM Serif Display', Georgia, serif; margin: 0 0 4px; letter-spacing: -.3px; }
    h2 + p { margin: 0 0 10px; color: #4a4038; font-size: 9.5pt; }
    h3 { font-size: 9pt; letter-spacing: .14em; text-transform: uppercase; border-bottom: 1px solid #1d1712; padding-bottom: 2px; margin: 12px 0 5px; font-weight: 600; }
    h4 { font-size: 10.5pt; margin: 7px 0 1px; font-weight: 600; }
    ul { margin: 2px 0 4px; padding-left: 16px; } li { margin: 1px 0; }
    p { margin: 4px 0; } mark { background: none; }
    .cover p { margin: 0 0 10px; font-size: 11pt; line-height: 1.5; }
  </style></head><body class="${/cover/i.test(title) ? 'cover' : ''}">${md(body)}</body></html>`);
  // Tell the new window we're done writing, so it finishes loading.
  w.document.close();
  // Wait 0.7 seconds (700 ms) so the fonts can load, then bring the window to the front and open the print dialog.
  setTimeout(() => { w.focus(); w.print(); }, 700);
}

// ============ View ============
// `ui` holds temporary screen state (NOT saved): which tab is open, the latest search results, total
// matches, which sources answered, whether we're loading, how many results to show, the AI ranking,
// which saved document is open, and the job being tailored.
const ui = { tab: 'find', results: null, total: 0, sources: null, loading: false, shown: 40, aiRank: null, selectedDoc: null, jobDraft: null };
// The tracker's columns, in order.
const STATUSES = ['saved', 'applied', 'interview', 'offer', 'rejected'];

/*
 * defaultFilters() — the starting filters before you've searched: internships, in Canada,
 * hiding roles your work authorization doesn't allow.
 * Input: none. Returns: a filters object.
 */
function defaultFilters() {
  // Reads the profile, though this variable isn't actually used below.
  const p = car().profile;
  // The default filter values.
  return { types: ['internship'], terms: [], locations: [], categories: [], remote: false, remoteOk: false, postedWithinDays: 0, keywords: '', region: 'CA', applyAuth: true };
}

/*
 * render(el) — draws the whole careers page. app.js calls this when you open "careers".
 * Input: el = the page's container element. Returns: nothing.
 */
export function render(el) {
  // First visit with no resume and no name? Start on the profile tab so you set yourself up first.
  if (!car().resume && ui.tab === 'find' && !car().profile.name) ui.tab = 'profile';

  // draw(): builds the page header + tab buttons, then draws the current tab underneath.
  // Tabs receive draw as `redraw`, so they can switch tabs and repaint the whole page.
  const draw = () => {
    // The careers data.
    const c = car();
    // The page header template: a small "kicker" line with how many jobs you track and documents you have,
    // the title and subtitle, and the tab buttons. The buttons come from a list of [key, label] pairs:
    // .map turns each into a <button data-tab="..."> (with class "on" for the open tab) and .join('') glues them.
    // Below the header is an empty <div id="tab"> that the current tab fills in.
    el.innerHTML = `
      <div class="page-head view-enter">
        <div>
          <div class="kicker">careers · ${c.saved.length} tracked · ${c.docs.length} documents</div>
          <h1>your <em>next move</em></h1>
          <p>find internships and jobs that actually fit you, then get a resume tailored to each one.</p>
        </div>
        <div class="seg" id="tabs">${[['find', 'find'], ['tailor', 'tailor'], ['tracker', 'tracker'], ['profile', 'profile']].map(([k, l]) => `<button data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>
      <div id="tab" class="view-enter"></div>`;
    // Clicking a tab button: remember the tab (read from its data-tab attribute via .dataset.tab) and redraw.
    el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tab; draw(); }));
    // The empty area where the tab's content goes.
    const tab = el.querySelector('#tab');
    // Pick the drawing function for the current tab from an object (tab name -> function) and call it
    // with the area and the redraw function. Wrapped in ( ) so JS doesn't mistake the { for a code block.
    ({ find: drawFind, tailor: drawTailor, tracker: drawTracker, profile: drawProfile })[ui.tab](tab, draw);
  };
  // Draw for the first time.
  draw();
}

// ---------- FIND ----------
/*
 * drawFind(el, redraw) — the "find" tab: search box, filter chips/inputs, and the results list.
 * Inputs: el = the tab area; redraw = repaints the whole page (used when switching tabs).
 * Returns: nothing.
 */
function drawFind(el, redraw) {
  // The careers data.
  const c = car();
  // Your last-used filters, or the defaults if you've never searched.
  const f = c.filters || defaultFilters();
  // Do we have anything to score fit against? Boolean(...) turns the result into a plain true/false.
  const hasProfile = Boolean(c.resume || c.profile.skills || c.profile.targetRoles);
  // chip(on, attr, label): small helper that returns the HTML for one clickable filter chip
  // (class "on" when selected, plus an attribute like data-type="internship" that identifies it).
  const chip = (on, attr, label) => `<span class="chip ${on ? 'on' : ''}" ${attr}>${label}</span>`;

  // The search area template:
  //   - a search box (#q) with an example placeholder and a "search" button (#go),
  //   - left column: "type" chips (internship / new grad / other jobs) and "field" chips (one per CATEGORY_LABELS entry),
  //   - right column: text inputs for term, city/province and keyword (pre-filled from f, escaped with esc),
  //     dropdowns for region and posting date (each option list built from [value, label] pairs, with the
  //     current one marked "selected"; `+f.postedWithinDays` turns it into a number for comparing),
  //     and checkboxes for "remote only", "include remote" and "hide roles I can't take" (its tooltip shows your work auth),
  //   - the web-sources box from webBox(),
  //   - a collapsible <details> with the company job boards (Greenhouse/Lever/Ashby) you can edit and save,
  //   - a nudge to set up your profile if there's nothing to score against,
  //   - and an empty <div id="results"> for the results.
  el.innerHTML = `
    <div class="card" style="margin-bottom:22px">
      <div class="quick-add"><input id="q" placeholder="try “summer 2027 co-op in toronto or remote” or “winter 2027 data internships in canada”"><button class="btn" id="go">search</button></div>
      <div class="row" style="margin-top:16px;gap:18px;align-items:flex-start">
        <div class="stack" style="gap:8px;flex:1;min-width:260px">
          <div class="label small muted">type</div>
          <div class="filters">${chip(f.types.includes('internship'), 'data-type="internship"', 'internship')}${chip(f.types.includes('newgrad'), 'data-type="newgrad"', 'new grad')}${chip(f.types.includes('job'), 'data-type="job"', 'other jobs')}</div>
          <div class="label small muted" style="margin-top:6px">field</div>
          <div class="filters">${Object.entries(CATEGORY_LABELS).map(([k, l]) => chip(f.categories.includes(k), `data-cat="${k}"`, l)).join('')}</div>
        </div>
        <div class="stack" style="gap:10px;flex:1;min-width:260px">
          <div class="row"><label class="field">term<input id="f-term" value="${esc(f.terms.join(', '))}" placeholder="Summer 2027, Winter 2027"></label><label class="field">city / province<input id="f-loc" value="${esc(f.locations.join(', '))}" placeholder="Toronto, Waterloo, BC"></label></div>
          <div class="row">
            <label class="field">where<select id="f-region">${[['CA', 'canada'], ['CA_US', 'canada + us'], ['US', 'us only'], ['any', 'anywhere']].map(([v, l]) => `<option value="${v}" ${(f.region || 'CA') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="field">posted<select id="f-posted">${[[0, 'any time'], [1, 'past day'], [7, 'past week'], [30, 'past month']].map(([v, l]) => `<option value="${v}" ${+f.postedWithinDays === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          </div>
          <div class="row"><label class="field">keyword<input id="f-kw" value="${esc(f.keywords)}" placeholder="python, figma, co-op…"></label></div>
          <div class="row" style="gap:18px">
            <label class="check small"><input type="checkbox" id="f-remote" ${f.remote ? 'checked' : ''}> remote only</label>
            <label class="check small"><input type="checkbox" id="f-remoteok" ${f.remoteOk ? 'checked' : ''}> include remote</label>
            <label class="check small" title="${esc(WORK_AUTH[workAuthOf(c.profile)])}"><input type="checkbox" id="f-auth" ${f.applyAuth !== false ? 'checked' : ''}> hide roles I can’t take (work auth)</label>
          </div>
        </div>
      </div>
      ${webBox()}
      <details style="margin-top:14px"><summary class="small muted" style="cursor:pointer">also searched: Canadian 2027 internship & co-op lists, Simplify’s 2027 + new-grad lists (filtered to your region), plus these company boards</summary>
        <div class="row" style="margin-top:10px"><input id="boards" value="${esc(c.boards)}" placeholder="greenhouse:figma, lever:palantir, ashby:ramp" style="flex:1"><button class="btn ghost sm" id="save-boards">save</button></div>
        <p class="small muted" style="margin:6px 0 0">add any company that uses Greenhouse, Lever or Ashby: the part after <code>boards.greenhouse.io/</code>, <code>jobs.lever.co/</code> or <code>jobs.ashbyhq.com/</code> in their careers link.</p>
      </details>
    </div>
    ${hasProfile ? '' : '<div class="card" style="margin-bottom:22px"><div class="row spread"><span>add your resume in <b>profile</b> so results get a fit score and ranking.</span><button class="btn sm" id="to-profile">set up profile</button></div></div>'}
    <div id="results"></div>`;

  // $(q): tiny shortcut to find an element inside this tab by CSS selector, e.g. $('#q').
  const $ = (q) => el.querySelector(q);
  // readFilters(): read the current values of all the filter inputs into a filters object.
  // `...f` is the spread syntax: copy every property of f first (types, categories…), then override the ones below.
  const readFilters = () => ({
    ...f,
    // "Summer 2027, Winter 2027" -> ['Summer 2027', 'Winter 2027'] (split on commas, trim, drop empties).
    terms: $('#f-term').value.split(',').map((s) => s.trim()).filter(Boolean),
    // Same for locations.
    locations: $('#f-loc').value.split(',').map((s) => s.trim()).filter(Boolean),
    // Dropdown values are strings; the + in front turns "7" into the number 7.
    postedWithinDays: +$('#f-posted').value,
    // The keyword box, without extra spaces.
    keywords: $('#f-kw').value.trim(),
    // Checkboxes: .checked is true/false.
    remote: $('#f-remote').checked,
    remoteOk: $('#f-remoteok').checked,
    // The region dropdown ('CA', 'CA_US', 'US' or 'any').
    region: $('#f-region').value,
    // Whether to hide jobs your work authorization rules out.
    applyAuth: $('#f-auth').checked,
  });
  // saveFilters(nf): store new filters in the saved data so they're remembered next time.
  const saveFilters = (nf) => updCar((cc) => (cc.filters = nf));

  // Type chips: clicking one toggles that type on/off.
  el.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => {
    // Read the current filters and which type was clicked (from data-type).
    const nf = readFilters(); const t = b.dataset.type;
    // Already on? Remove it (filter out). Off? Add it ([...list, t] makes a new array with t on the end).
    nf.types = nf.types.includes(t) ? nf.types.filter((x) => x !== t) : [...nf.types, t];
    // Save and redraw this tab so the chip shows its new state.
    saveFilters(nf); drawFind(el, redraw);
  }));
  // Field chips: same toggle idea for categories.
  el.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => {
    // Current filters and the clicked category (from data-cat).
    const nf = readFilters(); const k = b.dataset.cat;
    // Toggle it in the categories list.
    nf.categories = nf.categories.includes(k) ? nf.categories.filter((x) => x !== k) : [...nf.categories, k];
    // Save and redraw.
    saveFilters(nf); drawFind(el, redraw);
  }));
  // "set up profile" button (only exists if you have no profile). `?.` = optional chaining: if $('#to-profile')
  // is null, skip the call instead of crashing.
  $('#to-profile')?.addEventListener('click', () => { ui.tab = 'profile'; redraw(); });
  // "test my sources" button (only shown when web sources are on). `async (e) => {...}` is an async arrow
  // function, so we can use `await` to wait for the network without freezing the page.
  $('#test-src')?.addEventListener('click', async (e) => {
    // Show that it's working (e.target = the button that was clicked).
    e.target.textContent = 'testing… (can take up to a minute)';
    // try/catch: if anything inside `try` fails, jump to `catch` instead of crashing.
    try {
      // Test the sources: the free browser sources on the hosted website, or the server's sources locally.
      const r = isBrowserMode() ? await webjobs.testSources() : await (await fetch('/api/jobs/test')).json();
      // Show one bullet per source: its name in bold and its message (in the accent colour if it failed).
      // Object.values(r) gives the result objects; .map makes an <li> for each; .join('') glues them.
      $('#test-out').innerHTML = `<ul style="margin:8px 0 0;padding-left:18px;line-height:1.7">${Object.values(r).map((x) => `<li><b>${esc(x.label)}:</b> <span style="color:${x.ok ? 'inherit' : 'var(--accent)'}">${esc(x.message)}</span></li>`).join('')}</ul>`;
    // If the test request failed, show the error message as plain text.
    } catch (err) { $('#test-out').textContent = err.message; }
    // Let the button be pressed again.
    e.target.textContent = 'test again';
  });
  // "save" for the company boards (local-server mode only): store the text box value and confirm.
  $('#save-boards')?.addEventListener('click', () => { updCar((cc) => (cc.boards = $('#boards').value)); toast('sources saved'); });
  // "save proxy" (hosted website mode): save an optional CORS proxy prefix for the free job sources.
  $('#save-proxy')?.addEventListener('click', () => { webjobs.setProxy($('#job-proxy').value); toast('proxy saved'); });

  /*
   * run() — do a search. Combines the filter controls with whatever was typed in the search box,
   * asks the server for matching jobs, scores each one, sorts them, and shows the results.
   * Input: none. Returns: a Promise (it's async), with nothing in it.
   */
  const run = async () => {
    // Start from the filter controls. `let` because we may replace nf below.
    let nf = readFilters();
    // The typed sentence, without extra spaces.
    const q = $('#q').value.trim();
    // If something was typed, turn it into filters and merge.
    if (q) {
      // Parse the sentence into filters.
      const p = parseJobQuery(q);
      // Merge: the typed sentence's filters override the controls (later spread wins), but keep the
      // "hide roles I can't take" setting, and keep the chosen types if the sentence didn't mention any.
      nf = { ...nf, ...p, applyAuth: nf.applyAuth, types: p.types.length ? p.types : nf.types };
    }
    // Remember these filters.
    saveFilters(nf);
    // Company boards to search: split the saved text on commas/spaces, trim, and keep only entries that look like
    // "greenhouse:name", "lever:name" or "ashby:name" (^...$ = the whole entry; \S+ = one or more non-space characters).
    const companies = car().boards.split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^(greenhouse|lever|ashby):\S+$/.test(s));
    // Switch to "loading" mode, clear any old AI ranking, and reset to showing 40 results.
    ui.loading = true; ui.aiRank = null; ui.shown = 40;
    // Redraw the tab (so the controls show the merged filters and the loading spinner appears).
    drawFind(el, redraw);
    // Redrawing cleared the search box, so put the typed text back.
    el.querySelector('#q').value = q;
    try {
      // The search filters, plus (if hiding roles you can't take) the work-auth flags and the boards list.
      const payload = { ...nf, ...(nf.applyAuth !== false ? authFlags(car().profile) : {}), companies };
      // `data` = { results, total, sources }. Where it comes from depends on the mode:
      let data;
      if (isBrowserMode()) {
        // Hosted website (no server): search the free, no-key sources straight from the browser.
        data = await webjobs.search(payload);
      } else {
        // Local server: POST to our server, which searches the full set of sources.
        const r = await fetch('/api/jobs/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        data = await r.json();
        // r.ok is false for server errors; turn that into an Error so we land in `catch`.
        if (!r.ok) throw new Error(data.error || 'search failed');
      }
      // Compute your profile words ONCE (instead of once per job) to keep scoring fast.
      const tok = profileTokens();
      // Copy each job ({ ...j }) and add a `fit` property with its fit score.
      ui.results = data.results.map((j) => ({ ...j, fit: fitScore(j, tok) }));
      // If we can score fit, sort best fit first; when scores tie, newest first. (`||` uses the second
      // comparison only when the first gives 0, i.e. a tie.)
      if (hasProfile) ui.results.sort((a, b) => b.fit.score - a.fit.score || b.posted - a.posted);
      // Remember the total number of matches and which sources answered (or failed).
      ui.total = data.total; ui.sources = data.sources;
    } catch (e) {
      // The search failed: show no results and record the error so it's displayed.
      ui.results = []; ui.total = 0; ui.sources = { error: { error: e.message, count: 0 } };
    }
    // Done loading.
    ui.loading = false;
    // Show the results.
    drawResults();
  };
  // Clicking "search" runs the search.
  $('#go').onclick = run;
  // Pressing Enter in the search box also runs it.
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') run(); };

  /*
   * drawResults() — fills the results area: loading spinner, empty message, or the list of job cards.
   * Input: none (reads `ui`). Returns: nothing.
   * It's a function declaration inside drawFind, so it can use el, hasProfile, etc. (a closure),
   * and it can be called above this line because function declarations are "hoisted".
   */
  function drawResults() {
    // The results area.
    const box = el.querySelector('#results');
    // If the tab was replaced in the meantime, there's nowhere to draw.
    if (!box) return;
    // Still loading: show a spinner and stop.
    if (ui.loading) { box.innerHTML = `<div class="card">${spinner('scanning listings…')}</div>`; return; }
    // Never searched yet: show a friendly placeholder and stop.
    if (!ui.results) { box.innerHTML = '<div class="empty"><span class="big">search the galaxy.</span>results show up here, ranked by how well they fit you</div>'; return; }
    // Sources that reported an error: keep [name, info] pairs whose info has an .error.
    const errs = Object.entries(ui.sources || {}).filter(([, v]) => v.error);
    // The ids of jobs you've already saved, in a Set for quick lookups.
    const savedIds = new Set(car().saved.map((s) => s.id));
    // If the AI ranked jobs, show them in AI-score order (a sorted copy, [...ui.results], so the original stays).
    // `ui.aiRank[b.id]?.score ?? -1`: the AI score, or -1 if that job wasn't ranked (`?.` = skip if missing,
    // `??` = "use the right side only if the left is null/undefined"). Otherwise keep the normal order.
    const list = ui.aiRank ? [...ui.results].sort((a, b) => (ui.aiRank[b.id]?.score ?? -1) - (ui.aiRank[a.id]?.score ?? -1)) : ui.results;
    // The results template:
    //   - a top row: "N match/matches" (adds "es" unless exactly 1) and how they're sorted, plus an AI-rank button
    //     (only if AI is on, there are results and a profile; its label changes once ranked),
    //   - a list of sources that couldn't be reached, if any,
    //   - the job cards for the first ui.shown jobs (jobCard builds each; savedIds.has tells it if it's saved),
    //     or a "no matches" message with tips,
    //   - a "show more" button if there are more jobs than shown.
    box.innerHTML = `
      <div class="row spread" style="margin-bottom:12px">
        <span class="label small muted">${ui.total} match${ui.total === 1 ? '' : 'es'}${hasProfile ? ' · sorted by fit' : ' · newest first'}</span>
        ${aiEnabled() && ui.results.length && hasProfile ? `<button class="btn ghost sm" id="ai-rank">${ui.aiRank ? 're-rank with ai' : 'rank top 30 with ai'}</button>` : ''}
      </div>
      ${errs.length ? `<div class="small muted" style="margin-bottom:14px">couldn’t reach: ${errs.map(([k, v]) => `<b>${esc(k)}</b> (${esc(v.error)})`).join(', ')}</div>` : ''}
      ${list.length ? `<div class="stack" style="gap:12px">${list.slice(0, ui.shown).map((j) => jobCard(j, savedIds.has(j.id))).join('')}</div>` : '<div class="card empty"><span class="big">no matches.</span>try fewer filters, “canada + us”, or a different term like “Winter 2027”</div>'}
      ${list.length > ui.shown ? '<div class="row" style="justify-content:center;margin-top:16px"><button class="btn ghost" id="more">show more</button></div>' : ''}`;
    // "show more": show 40 more and redraw the list.
    box.querySelector('#more')?.addEventListener('click', () => { ui.shown += 40; drawResults(); });
    // AI rank button runs aiRank (defined below).
    box.querySelector('#ai-rank')?.addEventListener('click', aiRank);
    // Each "save" button: find that job by id (from data-save), save it to the tracker, and redraw.
    box.querySelectorAll('[data-save]').forEach((b) => (b.onclick = () => { saveJob(ui.results.find((j) => j.id === b.dataset.save)); drawResults(); }));
    // Each "tailor resume" button: copy that job's details into the tailor tab's draft and switch tabs.
    box.querySelectorAll('[data-tailor]').forEach((b) => (b.onclick = () => {
      // Find the job that was clicked.
      const j = ui.results.find((x) => x.id === b.dataset.tailor);
      // Pre-fill the tailor form: link, company, title, locations joined with "; ", and the description if we have one.
      ui.jobDraft = { url: j.url, company: j.company, title: j.title, location: j.locations.join('; '), text: j.desc || '' };
      // Open the tailor tab.
      ui.tab = 'tailor'; redraw();
    }));
  }

  /*
   * aiRank() — asks the AI to rank the top 30 results for you, with a short reason for each.
   * Input: none. Returns: a Promise (async). Saves the ranking in ui.aiRank and redraws.
   */
  async function aiRank() {
    // Disable the button so it can't be clicked twice, and show progress.
    const btn = el.querySelector('#ai-rank');
    btn.disabled = true; btn.textContent = 'ranking…';
    // Only send the first 30 jobs (keeps the prompt small and fast).
    const top = ui.results.slice(0, 30);
    try {
      // Ask the AI. `await` waits for the reply text.
      const reply = await ask({
        // The instructions: act as a career advisor, rank by fit using roles, skills, level, year, location and
        // work authorization, and reply with ONLY a JSON list of { id, score 0–100, why (max 14 words) }.
        system: 'You are a career advisor. Rank job postings by fit for this student. Consider their target roles, skills, experience level, class year, location preferences and work authorization. Return ONLY JSON: [{"id":"...","score":0-100,"why":"max 14 words, specific"}].',
        // The material: your profile, your resume (first 6,000 characters), and one line per posting:
        // "id | company | title | up to 3 locations | terms | category | sponsorship" (joined with new lines).
        messages: [{ role: 'user', content: `# Student\n${profileBlock()}\n\n# Resume\n${car().resume.slice(0, 6000)}\n\n# Postings\n${top.map((j) => `${j.id} | ${j.company} | ${j.title} | ${j.locations.slice(0, 3).join('; ')} | ${j.terms.join(', ')} | ${j.category} | ${j.sponsorship || ''}`).join('\n')}` }],
        // Limit the length of the reply.
        maxTokens: 3000,
      });
      // Pull the JSON array out of the reply (the AI sometimes wraps it in extra text).
      const arr = extractJSON(reply);
      // Turn the array into an object keyed by job id: { id1: {id, score, why}, ... }.
      // Object.fromEntries builds an object from [key, value] pairs; we skip items with no id.
      ui.aiRank = Object.fromEntries(arr.filter((x) => x.id).map((x) => [x.id, x]));
      // Let the user know.
      toast('ranked by ai');
    } catch (e) {
      // AI or JSON failed: show why.
      toast(`ai ranking failed: ${e.message}`);
    }
    // Redraw the list (in the new order, with the AI's reasons).
    drawResults();
  }
  // Draw the results area right away (shows old results, a spinner, or the placeholder).
  drawResults();
}

// Which whole-web sources are connected (keys live in .env)
/*
 * webBox() — the small box under the filters that says whether "whole-web search" is on
 * (Google Jobs, Adzuna, Jooble) and explains how to connect the sources that aren't.
 * Input: none (reads the server status). Returns: an HTML string.
 */
function webBox() {
  // Hosted website (no server): we search the free, no-key sources straight from the browser.
  // Show those as "on", offer a test button, and let the user add an optional CORS proxy.
  if (isBrowserMode()) {
    const cfg = webjobs.readCfg();
    return `<div class="web-box small">
      <div class="row spread"><span><b>free job search:</b> <span style="color:var(--accent)">on</span> · Arbeitnow, Remotive <span class="muted">(remote & worldwide roles)</span></span>
      <button class="link-btn" id="test-src">test my sources</button></div>
      <div id="test-out"></div>
      <details style="margin-top:6px"><summary class="muted" style="cursor:pointer">more results & Canadian listings</summary>
        <p class="faint" style="margin:6px 0 0">The hosted site searches free sources that work from a browser. For the full Google Jobs / Adzuna / Jooble search (lots of Canadian postings), run orbit locally with <code>node server.js</code> and add those keys to <code>.env</code>.</p>
        <label class="field" style="margin-top:8px">optional CORS proxy (if a source is blocked in your browser)<input id="job-proxy" value="${esc(cfg.proxy || '')}" placeholder="https://my-proxy/?url=" autocomplete="off"></label>
        <div class="row" style="margin-top:6px"><button class="btn ghost sm" id="save-proxy">save proxy</button></div>
      </details>
    </div>`;
  }
  // The server's report about each web source, e.g. { google: { ready: true, label: 'Google Jobs' }, ... }, or {} if none.
  const w = getStatus().webJobs || {};
  // Names of the sources that are ready (connected).
  const on = Object.values(w).filter((x) => x.ready).map((x) => x.label);
  // Setup info for each source: [key, name, which .env variable(s) to set, sign-up link, why it's useful].
  // Then keep only the sources that are NOT ready yet (`w[k]?.ready` is undefined if the server didn't mention k).
  const setup = [
    ['google', 'Google Jobs', 'SERPAPI_KEY', 'https://serpapi.com/users/sign_up', 'searches all of Google’s job listings (LinkedIn, Indeed, Glassdoor, company sites, startups). free: 250 searches/month'],
    ['adzuna', 'Adzuna', 'ADZUNA_APP_ID + ADZUNA_APP_KEY', 'https://developer.adzuna.com/signup', 'big job aggregator with lots of Canadian postings. free'],
    ['jooble', 'Jooble', 'JOOBLE_API_KEY', 'https://ca.jooble.org/api/about', 'another large aggregator (ca.jooble.org). free'],
  ].filter(([k]) => !w[k]?.ready);
  // The box's template:
  //   - "whole-web search: on · <names>" or "off…" with a hint,
  //   - a "test my sources" button if any source is on, and an empty #test-out area for its results,
  //   - if some sources aren't set up: a collapsible list (open by default when nothing is on) with, for each,
  //     a sign-up link, why it's useful, and which key to put in the .env file (`[, n, key, url, why]` skips
  //     the first item while destructuring), followed by a note to restart the app.
  return `<div class="web-box small">
    <div class="row spread"><span><b>whole-web search:</b> ${on.length ? `<span style="color:var(--accent)">on</span> · ${esc(on.join(', '))}` : '<span class="muted">off. connect a source below to search every company, big or small</span>'}</span>
    ${on.length ? '<button class="link-btn" id="test-src">test my sources</button>' : ''}</div>
    <div id="test-out"></div>
    ${setup.length ? `<details style="margin-top:6px" ${on.length ? '' : 'open'}><summary class="muted" style="cursor:pointer">${on.length ? 'add more sources' : 'how to turn it on'}</summary>
      <ul style="margin:6px 0 0;padding-left:18px;line-height:1.7">${setup.map(([, n, key, url, why]) => `<li><a href="${url}" target="_blank" rel="noopener">${n}</a>: ${why}. put <code>${key}</code> in <code>.env</code></li>`).join('')}</ul>
      <p class="faint" style="margin:6px 0 0">then restart the app. results from every source are merged and de-duplicated.</p></details>` : ''}
  </div>`;
}

/*
 * jobCard(j, saved) — the HTML for one search result card.
 * Inputs: j = a job object (with its fit score); saved = true if it's already in your tracker.
 * Returns: an HTML string.
 */
function jobCard(j, saved) {
  // The AI's ranking for this job, if there is one (`?.` = undefined instead of an error when aiRank is null).
  const ai = ui.aiRank?.[j.id];
  // Score to show: the AI's score if it has one, otherwise our fit score (`??` = fall back only if null/undefined).
  const score = ai?.score ?? j.fit?.score;
  // How many days ago it was posted (rounded), or null if we don't know.
  const posted = j.posted ? Math.round((Date.now() - j.posted) / 86400000) : null;
  // The card template:
  //   Left side (job-main):
  //   - company · first category (category may be "a,b,c", so split on commas and take the first),
  //   - the job title,
  //   - up to 3 locations joined with " · " (or "location n/a"), plus "+N" if there are more,
  //   - chips: up to 3 terms; "term not stated" if the job has no term but you filtered by term;
  //     "remote"; the sponsorship note; "posted today"/"Nd ago"; and which sources found it ("via …"),
  //   - the AI's one-line reason, or else which of your skills it matches (up to 5).
  //   Right side (job-side):
  //   - a round "fit" badge (the CSS variable --p = the score, used to draw the ring) if there's a score,
  //   - buttons: "open" (the posting in a new tab), "save"/"saved" (disabled once saved), "tailor resume".
  //   data-save / data-tailor hold the job id so drawResults knows which job was clicked.
  return `<div class="card job-card">
    <div class="job-main">
      <div class="label small muted">${esc(j.company)}${j.category ? ' · ' + esc(j.category.split(',')[0]) : ''}</div>
      <div class="job-title">${esc(j.title)}</div>
      <div class="small muted">${esc(j.locations.slice(0, 3).join(' · ') || 'location n/a')}${j.locations.length > 3 ? ` +${j.locations.length - 3}` : ''}</div>
      <div class="row" style="margin-top:8px;gap:6px">
        ${j.terms.slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
        ${!j.terms.length && (car().filters?.terms || []).length ? '<span class="chip" title="the posting doesn’t say which term, so check it">term not stated</span>' : ''}
        ${j.remote ? '<span class="chip">remote</span>' : ''}
        ${j.sponsorship ? `<span class="chip" title="sponsorship">${esc(j.sponsorship.toLowerCase())}</span>` : ''}
        ${posted != null ? `<span class="small faint">${posted === 0 ? 'posted today' : `${posted}d ago`}</span>` : ''}
        ${j.foundOn?.length ? `<span class="small faint">via ${esc(j.foundOn.slice(0, 3).join(', '))}</span>` : ''}
      </div>
      ${ai?.why ? `<div class="hand" style="margin-top:8px;font-size:19px">${esc(ai.why)}</div>` : j.fit?.matched?.length ? `<div class="small muted" style="margin-top:8px">matches your: ${esc(j.fit.matched.slice(0, 5).join(', '))}</div>` : ''}
    </div>
    <div class="job-side">
      ${score ? `<div class="fit" style="--p:${score}"><span>${score}</span><small>fit</small></div>` : ''}
      <div class="row" style="justify-content:flex-end">
        <a class="btn ghost sm" href="${esc(j.url)}" target="_blank" rel="noopener">open</a>
        <button class="btn ghost sm" data-save="${esc(j.id)}" ${saved ? 'disabled' : ''}>${saved ? 'saved' : 'save'}</button>
        <button class="btn sm" data-tailor="${esc(j.id)}">tailor resume</button>
      </div>
    </div>
  </div>`;
}

/*
 * saveJob(j) — adds a job to your tracker (in the "saved" column).
 * Input: a job object. Returns: nothing.
 */
function saveJob(j) {
  // Stop if there's no job, or it's already saved (.some = "is there at least one with the same id?").
  if (!j || car().saved.some((s) => s.id === j.id)) return;
  // Add a trimmed-down copy to the START of the saved list (unshift), with status 'saved', an empty deadline
  // and notes, and the time it was saved (Date.now() = milliseconds since 1970).
  updCar((c) => c.saved.unshift({ id: j.id, company: j.company, title: j.title, url: j.url, locations: j.locations, terms: j.terms, type: j.type, status: 'saved', deadline: '', notes: '', savedAt: Date.now() }));
  // Confirm.
  toast(`saved ${j.company} to your tracker`);
}

// ---------- TAILOR ----------
/*
 * drawTailor(el, redraw) — the "tailor" tab: paste/fetch a job posting, pick resume/CV/cover letter,
 * generate it with AI (or a keyword check offline), and view/save/print saved documents.
 * Inputs: el = the tab area; redraw = repaints the whole page. Returns: nothing.
 */
function drawTailor(el, redraw) {
  // The careers data.
  const c = car();
  // The job currently being tailored (from a "tailor resume" button or what you typed), or an empty one.
  const d = ui.jobDraft || { url: '', company: '', title: '', location: '', text: '' };
  // The saved document currently selected for viewing (undefined if none).
  const doc = c.docs.find((x) => x.id === ui.selectedDoc);
  // The tab template, in two columns:
  //   Left card "the job": a link box + "fetch" button, company and role inputs, a big job-description textarea
  //   (all pre-filled from d), the document-kind buttons built from DOC_KINDS (the first, resume, starts "on";
  //   `([k, v], i)` destructures each entry and also gets its index i), and the generate button
  //   ("generate" with AI, "check keywords" without). Then notes: a warning if you have no resume, an
  //   honesty/offline explanation, and an empty #j-status area for progress and errors.
  //   Right column: the selected document (docView) or a placeholder, and, if you have any, a list of saved
  //   documents (company, kind, title, and the creation date formatted like "jan 5"; .toISOString().slice(0, 10)
  //   turns the timestamp into "YYYY-MM-DD", which fmtDate expects).
  el.innerHTML = `
    <div class="grid dash">
      <div class="card stack" style="gap:14px">
        <h3>the job</h3>
        <div class="quick-add"><input id="j-url" value="${esc(d.url)}" placeholder="paste a job link (greenhouse, lever, workday…)"><button class="btn ghost" id="j-fetch">fetch</button></div>
        <div class="row"><label class="field">company<input id="j-company" value="${esc(d.company)}"></label><label class="field">role<input id="j-title" value="${esc(d.title)}"></label></div>
        <label class="field">job description<textarea id="j-text" style="min-height:230px" placeholder="paste the full job description here (or fetch it from the link above)">${esc(d.text)}</textarea></label>
        <div class="row spread">
          <div class="seg" id="kind">${Object.entries(DOC_KINDS).map(([k, v], i) => `<button data-kind="${k}" class="${i === 0 ? 'on' : ''}" title="${v.desc}">${v.label}</button>`).join('')}</div>
          <button class="btn" id="j-go">${aiEnabled() ? 'generate' : 'check keywords'}</button>
        </div>
        ${c.resume ? '' : '<p class="small" style="margin:0;color:var(--accent)">add your default resume in <b>profile</b> first, since everything is built from it.</p>'}
        ${aiEnabled() ? '<p class="small muted" style="margin:0">it only uses what’s in your resume and profile and never makes up experience.</p>' : '<p class="small muted" style="margin:0">offline mode: shows which keywords from the posting your resume covers. connect kiro or an ai key to generate tailored documents.</p>'}
        <div id="j-status"></div>
      </div>
      <div class="stack">
        <div class="card" id="doc-pane">${doc ? docView(doc) : '<div class="empty"><span class="big">nothing yet.</span>your tailored resume shows up here, ready to save as a pdf</div>'}</div>
        ${c.docs.length ? `<div class="card"><h3>saved documents</h3><div class="ev-list">${c.docs.map((x) => `<div class="ev" data-doc="${x.id}" style="--c:var(--accent);grid-template-columns:8px 1fr auto"><span class="bar"></span><div><div class="t">${esc(x.company || 'untitled')} <span class="kind">${esc(DOC_KINDS[x.kind]?.label || x.kind)}</span></div><div class="s">${esc(x.title || '')}</div></div><span class="when">${fmtDate(new Date(x.createdAt).toISOString().slice(0, 10), { month: 'short', day: 'numeric' }).toLowerCase()}</span></div>`).join('')}</div></div>` : ''}
      </div>
    </div>`;

  // Shortcut to find elements inside this tab.
  const $ = (q) => el.querySelector(q);
  // Which document kind is chosen (starts as resume). `let` because clicking a kind button changes it.
  let kind = 'resume';
  // Kind buttons: remember the clicked kind and highlight only that button (classList.toggle('on', cond)
  // adds the class when cond is true and removes it when false).
  el.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { kind = b.dataset.kind; el.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b)); }));
  // readDraft(): copy the form's current values into ui.jobDraft (so they survive redraws) and return it.
  // An assignment like (a = b) also gives back b, so the arrow function returns the new draft.
  const readDraft = () => (ui.jobDraft = { url: $('#j-url').value.trim(), company: $('#j-company').value.trim(), title: $('#j-title').value.trim(), location: d.location, text: $('#j-text').value.trim() });
  // Save the draft every time you type in any of the four fields.
  ['#j-url', '#j-company', '#j-title', '#j-text'].forEach((s) => ($(s).oninput = readDraft));

  // "fetch": ask our server to download the job posting from the link and fill in the form.
  $('#j-fetch').onclick = async () => {
    // The pasted link.
    const url = $('#j-url').value.trim();
    // No link? Tell the user and stop.
    if (!url) return toast('paste a job link first');
    // Hosted website (no server): the browser can't read other sites (CORS), so reading a posting
    // from a link isn't available. Ask the user to paste the description instead.
    if (isBrowserMode()) {
      $('#j-status').innerHTML = '<p class="small" style="color:var(--accent);margin:0">On the hosted site, paste the job description below instead — reading it from a link needs the local app (<code>node server.js</code>).</p>';
      return;
    }
    // Show a spinner while we wait.
    $('#j-status').innerHTML = spinner('reading the posting…');
    try {
      // Call the server. encodeURIComponent makes the link safe to put inside another URL (escapes ?, &, etc.).
      const r = await fetch('/api/job-text?url=' + encodeURIComponent(url));
      // The reply: { company, title, location, text } or { error }.
      const data = await r.json();
      // If the server reported an error, jump to catch.
      if (!r.ok) throw new Error(data.error);
      // Fill in company and title only if you haven't typed your own.
      if (data.company && !$('#j-company').value) $('#j-company').value = data.company;
      if (data.title && !$('#j-title').value) $('#j-title').value = data.title;
      // Put the job description in the big text box.
      $('#j-text').value = data.text;
      // Remember the location (there's no visible field for it).
      d.location = data.location;
      // Save everything into the draft.
      readDraft();
      // Clear the spinner and confirm.
      $('#j-status').innerHTML = '';
      toast('got the job description');
    } catch (e) {
      // Show the error message in red-ish accent colour.
      $('#j-status').innerHTML = `<p class="small" style="color:var(--accent);margin:0">${esc(e.message)}</p>`;
    }
  };

  // "generate" / "check keywords": make the document (with AI) or show a keyword check (without AI).
  $('#j-go').onclick = async () => {
    // Grab the latest form values.
    const job = readDraft();
    // Under 150 characters is too short to be a real job description.
    if (job.text.length < 150) return toast('paste the job description (or fetch it from the link)');
    // Offline mode: show which frequent posting words your resume covers/misses, then stop.
    if (!aiEnabled()) {
      // Run the keyword comparison.
      const rep = localKeywordReport(job.text);
      // Show a small card with two lines: words you cover, and words in the posting missing from your resume
      // (or "none yet" / "nothing major" when a list is empty).
      $('#j-status').innerHTML = `<div class="card" style="box-shadow:none"><h3>keyword check</h3>
        <p class="small" style="margin:0 0 8px"><b>you cover:</b> ${esc(rep.have.join(', ') || 'none yet')}</p>
        <p class="small" style="margin:0"><b>in the posting, not in your resume:</b> ${esc(rep.missing.join(', ') || 'nothing major')}</p></div>`;
      return;
    }
    // No resume and no name: there's nothing honest to build from.
    if (!car().resume && !car().profile.name) return toast('add your resume in profile first');
    // Disable the button while generating, and show progress ("writing your resume…").
    $('#j-go').disabled = true;
    $('#j-status').innerHTML = spinner(`writing your ${DOC_KINDS[kind].label}…`);
    try {
      // Build the prompt for this kind of document and job.
      const pr = docPrompt(kind, job);
      // Send it to the AI. CVs are longer, so they get a bigger length limit.
      const reply = await ask({ system: pr.system, messages: [{ role: 'user', content: pr.user }], maxTokens: kind === 'cv' ? 5000 : 3000 });
      // Split the reply into the document and the notes, at a line that is exactly "===NOTES===" (allowing spaces
      // around it). ^ and $ with the m flag mean start/end of a LINE. Array destructuring: the first piece is
      // `body`, the second is `notes` (= '' default if the AI didn't include notes).
      const [body, notes = ''] = reply.split(/^\s*===NOTES===\s*$/m);
      // A new random id for this document.
      const id = uid();
      // Save the document at the top of your documents list. (`id, kind` is shorthand for `id: id, kind: kind`.)
      updCar((c) => c.docs.unshift({ id, kind, company: job.company, title: job.title, jobUrl: job.url, body: body.trim(), notes: notes.trim(), createdAt: Date.now() }));
      // Select it so it's shown, confirm, and redraw the page.
      ui.selectedDoc = id;
      toast(`${DOC_KINDS[kind].label} ready`);
      redraw();
    } catch (e) {
      // Show the error and re-enable the button so you can try again.
      $('#j-status').innerHTML = `<p class="small" style="color:var(--accent);margin:0">${esc(e.message)}</p>`;
      $('#j-go').disabled = false;
    }
  };

  // Clicking a saved document in the list selects it and redraws this tab.
  el.querySelectorAll('[data-doc]').forEach((r) => (r.onclick = () => { ui.selectedDoc = r.dataset.doc; drawTailor(el, redraw); }));
  // Attach the edit/copy/pdf/delete buttons of the shown document.
  wireDoc(el, redraw);
}

/*
 * docView(doc) — the HTML for showing one saved document.
 * Input: a document object { kind, company, body, notes, ... }. Returns: an HTML string.
 */
function docView(doc) {
  // Template: a top row with "kind · company" and the edit / copy / save as pdf / delete buttons
  // (data-doc-* attributes let wireDoc find them), the document rendered from Markdown by md() on a
  // "resume sheet", and the AI's notes (what it tailored, missing keywords, tips) underneath if there are any.
  return `
    <div class="row spread" style="margin-bottom:12px">
      <span class="label small muted">${esc(DOC_KINDS[doc.kind]?.label || doc.kind)} · ${esc(doc.company || '')}</span>
      <div class="row">
        <button class="btn ghost sm" data-doc-edit>edit</button>
        <button class="btn ghost sm" data-doc-copy>copy</button>
        <button class="btn sm" data-doc-pdf>save as pdf</button>
        <button class="icon-btn" data-doc-del>delete</button>
      </div>
    </div>
    <div class="resume-sheet prose-resume">${md(doc.body)}</div>
    ${doc.notes ? `<div class="doc-notes prose">${md(doc.notes)}</div>` : ''}`;
}

/*
 * wireDoc(el, redraw) — makes the selected document's buttons work.
 * Inputs: el = the tab area; redraw = repaints the page. Returns: nothing.
 */
function wireDoc(el, redraw) {
  // The selected document; if none, there are no buttons to wire.
  const doc = car().docs.find((x) => x.id === ui.selectedDoc);
  if (!doc) return;
  // "save as pdf": print it, titled e.g. "Ada Lovelace - Shopify resume" (`|| 'Resume'` if you have no name;
  // .trim() removes a trailing space if the label is missing).
  el.querySelector('[data-doc-pdf]').onclick = () => printDoc(doc.body, `${car().profile.name || 'Resume'} - ${doc.company} ${DOC_KINDS[doc.kind]?.label || ''}`.trim());
  // "copy": put the Markdown text on the clipboard; writeText returns a Promise, so .then shows the toast after.
  el.querySelector('[data-doc-copy]').onclick = () => navigator.clipboard.writeText(doc.body).then(() => toast('copied as text'));
  // "delete": remove it from the list (keep every doc whose id is different), deselect, and redraw.
  el.querySelector('[data-doc-del]').onclick = () => { updCar((c) => (c.docs = c.docs.filter((x) => x.id !== doc.id))); ui.selectedDoc = null; redraw(); };
  // "edit": open a wide pop-up with a big textarea holding the document's Markdown and a save button.
  el.querySelector('[data-doc-edit]').onclick = () => modal('edit document', `<textarea class="editor" id="d-body" style="min-height:460px">${esc(doc.body)}</textarea><div class="row" style="justify-content:flex-end"><button class="btn" id="d-save">save</button></div>`, {
    // Make the pop-up wider than normal.
    wide: true,
    // onMount runs once the pop-up is on screen. `body` = the pop-up's content element, `close` = closes it.
    // (Writing `onMount(body, close) {...}` inside an object is shorthand for `onMount: function (body, close) {...}`.)
    onMount(body, close) {
      // Save: find this document in the saved data, replace its body with the edited text, close, and redraw.
      body.querySelector('#d-save').onclick = () => { updCar((c) => (c.docs.find((x) => x.id === doc.id).body = body.querySelector('#d-body').value)); close(); redraw(); };
    },
  });
}

// ---------- TRACKER ----------
/*
 * drawTracker(el, redraw) — the "tracker" tab: a board with one column per status
 * (saved, applied, interview, offer, rejected) and a card per saved job.
 * Inputs: el = the tab area; redraw = repaints the whole page. Returns: nothing.
 */
function drawTracker(el, redraw) {
  // The careers data.
  const c = car();
  // Nothing saved yet: show a hint and stop.
  if (!c.saved.length) {
    el.innerHTML = '<div class="card empty"><span class="big">nothing tracked yet.</span>save roles from <b>find</b> and they’ll land here</div>';
    return;
  }
  // Build one column per status. For each status `st`, this arrow function has a real body ({ ... }) so it can
  // first compute `items` (the jobs with that status) and then return the column's HTML.
  el.innerHTML = `<div class="tracker">${STATUSES.map((st) => {
    // The saved jobs whose status matches this column.
    const items = c.saved.filter((s) => s.status === st);
    // The column template: a heading "status · count", then one card per job with the company, the title,
    // the deadline in accent colour if set ("due jan 5"), a status dropdown (current status pre-selected;
    // each <option>'s text is also its value), and a "•••" button for more options.
    // If the column is empty, `'' || '...'` falls back to a faint "nothing here" (an empty string counts as false).
    return `<div class="track-col"><div class="label small muted" style="margin-bottom:10px">${st} · ${items.length}</div>
      ${items.map((s) => `<div class="card track-card" data-id="${esc(s.id)}">
        <div class="label small muted">${esc(s.company)}</div>
        <div style="font-family:var(--serif);font-size:18px;line-height:1.2;margin:2px 0 6px">${esc(s.title)}</div>
        ${s.deadline ? `<div class="small" style="color:var(--accent)">due ${fmtDate(s.deadline, { month: 'short', day: 'numeric' }).toLowerCase()}</div>` : ''}
        <div class="row" style="margin-top:10px;gap:6px">
          <select data-status style="padding:5px 8px;font-size:12.5px;width:auto">${STATUSES.map((x) => `<option ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select>
          <button class="btn ghost sm" data-more>•••</button>
        </div>
      </div>`).join('') || '<div class="small faint">nothing here</div>'}
    </div>`;
  }).join('')}</div>`;

  // Wire up every card.
  el.querySelectorAll('.track-card').forEach((card) => {
    // This card's job id (from data-id) and the saved job object.
    const id = card.dataset.id;
    const s = c.saved.find((x) => x.id === id);
    // Changing the status dropdown moves the job to another column.
    card.querySelector('[data-status]').onchange = (e) => {
      // The newly chosen status.
      const status = e.target.value;
      // Save it on the matching job.
      updCar((cc) => (cc.saved.find((x) => x.id === id).status = status));
      // A little encouragement + tip when you mark it applied.
      if (status === 'applied') toast('applied, nice. add a follow-up reminder from •••');
      // Redraw the board.
      drawTracker(el, redraw);
    };
    // "•••" opens a pop-up titled with the company. The pop-up's template: the job title, a deadline date picker,
    // a notes box, a "put the deadline on my calendar" checkbox (ticked by default), and buttons: open posting,
    // tailor resume, add a follow-up in 7 days, remove, save. Values are pre-filled from the saved job.
    card.querySelector('[data-more]').onclick = () => modal(`${s.company}`, `
      <div class="small muted">${esc(s.title)}</div>
      <div class="row"><label class="field">application deadline<input type="date" id="t-dl" value="${esc(s.deadline)}"></label></div>
      <label class="field">notes<textarea id="t-notes" style="min-height:90px" placeholder="referral, recruiter name, interview dates…">${esc(s.notes)}</textarea></label>
      <label class="check small"><input type="checkbox" id="t-cal" checked> put the deadline on my calendar</label>
      <div class="row spread">
        <div class="row"><a class="btn ghost sm" href="${esc(s.url)}" target="_blank" rel="noopener">open posting</a><button class="btn ghost sm" id="t-tailor">tailor resume</button><button class="btn ghost sm" id="t-follow">+ follow-up in 7 days</button></div>
        <div class="row"><button class="btn danger sm" id="t-del">remove</button><button class="btn sm" id="t-save">save</button></div>
      </div>`, {
      // Runs when the pop-up appears: body = the pop-up's content, close = function that closes it.
      onMount(body, close) {
        // A $ shortcut that searches inside the pop-up (this inner $ "shadows", i.e. hides, any outer one).
        const $ = (q) => body.querySelector(q);
        // "save": store the deadline and notes; optionally add the deadline to the calendar.
        $('#t-save').onclick = () => {
          // The chosen date as "YYYY-MM-DD" ('' if empty).
          const deadline = $('#t-dl').value;
          // Remember the old deadline now, because the update below changes this very same object.
          const prevDeadline = s.deadline; // read before the update mutates the same object
          // Object.assign copies { deadline, notes } onto the saved job (shorthand `deadline` = `deadline: deadline`).
          updCar((cc) => Object.assign(cc.saved.find((x) => x.id === id), { deadline, notes: $('#t-notes').value }));
          // Only add a calendar event if there's a date, the box is ticked, and the date actually changed
          // (so saving twice doesn't create duplicate events).
          if (deadline && $('#t-cal').checked && deadline !== prevDeadline) {
            // Add an "Apply: Company" event on that date, counted as an assignment.
            addEvents([{ title: `Apply: ${s.company}`, type: 'assignment', date: deadline, notes: s.title, source: 'careers' }]);
            toast('deadline added to your calendar');
          }
          // Close the pop-up and redraw the board.
          close(); drawTracker(el, redraw);
        };
        // "+ follow-up in 7 days": add a reminder a week from today.
        $('#t-follow').onclick = () => {
          // Today, then move it forward 7 days (setDate handles rolling into the next month).
          const date = new Date(); date.setDate(date.getDate() + 7);
          // Format as "YYYY-MM-DD": months start at 0 so add 1; padStart(2, '0') turns "5" into "05".
          const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          // Put a "Follow up: Company" event on the calendar.
          addEvents([{ title: `Follow up: ${s.company}`, type: 'other', date: iso, notes: s.title, source: 'careers' }]);
          toast('follow-up added to your calendar');
        };
        // "tailor resume": fill the tailor tab with this job (no description yet; you can fetch it from the link),
        // switch to the tailor tab, close the pop-up and redraw. `(s.locations || [])` guards against a missing list.
        $('#t-tailor').onclick = () => { ui.jobDraft = { url: s.url, company: s.company, title: s.title, location: (s.locations || []).join('; '), text: '' }; ui.tab = 'tailor'; close(); redraw(); };
        // "remove": drop this job from the saved list, close, and redraw.
        $('#t-del').onclick = () => { updCar((cc) => (cc.saved = cc.saved.filter((x) => x.id !== id))); close(); drawTracker(el, redraw); };
      },
    });
  });
}

// ---------- PROFILE ----------
/*
 * drawProfile(el, redraw) — the "profile" tab: your default resume (upload, paste or screenshot)
 * and the "about you" form used for fit scoring, filters and document writing.
 * Inputs: el = the tab area; redraw = repaints the whole page. Returns: nothing.
 */
function drawProfile(el, redraw) {
  // The careers data and your profile.
  const c = car();
  const p = c.profile;
  // field(k, label, ph): HTML for one labelled text input bound to profile key k (stored in data-p),
  // pre-filled with your current value. `ph = ''` is a default value for the placeholder.
  const field = (k, label, ph = '') => `<label class="field">${label}<input data-p="${k}" value="${esc(p[k])}" placeholder="${esc(ph)}"></label>`;
  // The tab template, in two cards:
  //   Left "default resume": a word count (split the resume on whitespace and count pieces) or "empty";
  //   a drop zone that is also a hidden file picker (accept = allowed file types); the resume textarea;
  //   a privacy note; and buttons ("fill profile from resume" only if AI is on, plus "save resume").
  //   Right "about you": inputs made with field() for name, email, phone, location, links, school, degree,
  //   graduation, GPA; a work-authorization dropdown built from WORK_AUTH (your current one selected);
  //   an explanation of how work auth is used; target roles, skills, preferred locations; an "anything else"
  //   textarea; and "save profile". Every profile input has data-p="<key>" so saving can loop over them.
  el.innerHTML = `
    <div class="grid dash">
      <div class="card stack" style="gap:14px">
        <h3>default resume <span>${c.resume ? `${c.resume.split(/\s+/).length} words` : 'empty'}</span></h3>
        <label class="drop" id="r-drop" style="padding:22px"><input type="file" id="r-file" accept="${ACCEPT}" hidden><div class="big" style="font-size:30px">your resume.</div><span class="muted small">drop a pdf, word doc, pages file or even a photo · or paste below</span></label>
        <textarea id="r-text" style="min-height:340px" placeholder="paste your current resume here">${esc(c.resume)}</textarea>
        <div class="row spread"><span class="small muted">everything stays in this browser.</span><div class="row">${aiEnabled() ? '<button class="btn ghost sm" id="r-fill">fill profile from resume</button>' : ''}<button class="btn sm" id="r-save">save resume</button></div></div>
      </div>
      <div class="card stack" style="gap:12px">
        <h3>about you</h3>
        <div class="row">${field('name', 'name')}${field('email', 'email')}</div>
        <div class="row">${field('phone', 'phone')}${field('location', 'where you live', 'Toronto, ON')}</div>
        ${field('links', 'links', 'linkedin.com/in/…, portfolio')}
        <div class="row">${field('school', 'school')}${field('degree', 'degree / program', 'Honours B.Sc. Psychology, co-op')}</div>
        <div class="row">${field('gradDate', 'expected graduation', 'April 2028')}${field('gpa', 'gpa / average (optional)', '3.7/4.0 or 85%')}</div>
        <label class="field">work authorization<select data-p="workAuth">${Object.entries(WORK_AUTH).map(([v, l]) => `<option value="${v}" ${workAuthOf(p) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <p class="small muted" style="margin:-4px 0 0">used to hide roles you can’t take. for us roles, canadians usually need a visa (j-1 for internships, tn for full-time), so us roles that don’t sponsor are hidden unless you’re also a us citizen or green card holder.</p>
        ${field('targetRoles', 'roles you want', 'software engineering, product, ux research')}
        ${field('skills', 'skills', 'python, react, figma, spss')}
        ${field('locations', 'preferred locations', 'Toronto, Waterloo, remote')}
        <label class="field">anything else (used for cover letters)<textarea data-p="extra" style="min-height:80px" placeholder="why you’re into this field, clubs, things you’re proud of…">${esc(p.extra)}</textarea></label>
        <div class="row" style="justify-content:flex-end"><button class="btn" id="p-save">save profile</button></div>
      </div>
    </div>`;

  // Shortcut to find elements inside this tab.
  const $ = (q) => el.querySelector(q);
  // The drop zone.
  const drop = $('#r-drop');
  /*
   * load(file) — read a chosen/dropped file (PDF, Word, photo…) into the resume textarea.
   * Input: a File object (or undefined). Returns: a Promise (async).
   */
  const load = async (file) => {
    // Nothing chosen? Do nothing.
    if (!file) return;
    // The resume textarea.
    const ta = $('#r-text');
    try {
      // Empty it and show "reading…" as a placeholder while we work.
      ta.value = ''; ta.placeholder = 'reading…';
      // Read the file as text (fileread.js); progress messages (e.g. for photo text recognition) go into the placeholder.
      ta.value = await readFileText(file, { onProgress: (m) => (ta.placeholder = m) });
      // Remind the user that it isn't saved until they press save.
      toast(`loaded ${file.name}. hit save`);
    // If reading failed, show the error for 8 seconds.
    } catch (e) { toast(e.message, { timeout: 8000 }); }
    // Put the normal placeholder back.
    ta.placeholder = 'paste your current resume here';
  };
  // Picking a file with the file picker loads the first chosen file.
  $('#r-file').onchange = (e) => load(e.target.files[0]);
  // Allow pasting a screenshot into the resume box: it's turned into text, with progress shown in the placeholder.
  enableImagePaste($('#r-text'), { onProgress: (m) => ($('#r-text').placeholder = m), onDone: () => toast('read your screenshot'), onError: (e) => toast(e.message) });
  // While a file is dragged over the zone: preventDefault stops the browser from opening the file itself,
  // and the "over" class highlights the zone.
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  // When the drag leaves or the file is dropped: remove the highlight.
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  // On drop, load the first dropped file.
  drop.addEventListener('drop', (e) => load(e.dataTransfer.files[0]));

  /*
   * saveResume() — saves the resume text, and fills in obvious empty profile fields
   * (email, phone, links, name) by spotting them in the text, without AI.
   * Input: none. Returns: nothing.
   */
  const saveResume = () => {
    // The resume text without extra spaces at the ends.
    const text = $('#r-text').value.trim();
    // Save it.
    updCar((cc) => (cc.resume = text));
    // Offline autofill of obvious fields
    // Email: letters/digits/._+- (\w = letter, digit or underscore), "@", a domain name, a dot, and the ending.
    // `?.[0]` takes the matched text, or undefined if there was no match.
    const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
    // Phone (North American): optional "+1" with an optional separator, an area code of 3 digits (optionally in
    // brackets), then 3 digits and 4 digits, with optional spaces/dots/dashes between. E.g. "(416) 555-0199".
    const phone = text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0];
    // Links: "linkedin.com/in/name", "github.com/name", or any "name.com/.io/.me/.dev" with an optional path.
    // The g flag finds all, i ignores capital letters. We drop anything containing "@" (part of an email),
    // keep at most 3, and join them with commas.
    const links = (text.match(/(linkedin\.com\/in\/[\w-]+|github\.com\/[\w-]+|[\w-]+\.(?:com|io|me|dev)\/?[\w-/]*)/gi) || []).filter((l) => !/@/.test(l)).slice(0, 3).join(', ');
    // Fill in only the fields that are still empty, so we never overwrite what you typed.
    updCar((cc) => {
      // Your profile.
      const pr = cc.profile;
      // Use the found email/phone/links if the field is blank.
      if (!pr.email && email) pr.email = email;
      if (!pr.phone && phone) pr.phone = phone;
      if (!pr.links && links) pr.links = links;
      // Name: the first line that looks like a name — 2 to 4 capitalised words, e.g. "Ada Lovelace"
      // ([A-Z] capital letter, then letters/apostrophes/hyphens; (\s[A-Z]...){1,3} = 1 to 3 more such words).
      // If no line looks like that, use ''.
      if (!pr.name) pr.name = text.split('\n').map((l) => l.trim()).find((l) => /^[A-Z][a-zA-Z'-]+(\s[A-Z][a-zA-Z'.-]+){1,3}$/.test(l)) || '';
    });
  };
  // "save resume": save, confirm, and redraw this tab (so the word count and autofilled fields show).
  $('#r-save').onclick = () => { saveResume(); toast('resume saved'); drawProfile(el, redraw); };
  // "save profile": copy every input/select/textarea with data-p into the profile under its key (i.dataset.p).
  $('#p-save').onclick = () => {
    updCar((cc) => el.querySelectorAll('[data-p]').forEach((i) => (cc.profile[i.dataset.p] = i.value.trim())));
    toast('profile saved');
  };
  // "fill profile from resume" (only exists when AI is on): ask the AI to pull your details out of the resume.
  $('#r-fill')?.addEventListener('click', async () => {
    // Save the resume first so the AI reads the latest text.
    saveResume();
    // Disable the button and show progress.
    const btn = $('#r-fill'); btn.disabled = true; btn.textContent = 'reading…';
    try {
      // Ask the AI.
      const reply = await ask({
        // Instructions: extract these fields and return ONLY JSON with string values (empty if unknown);
        // targetRoles = 2–4 role types; skills = a comma list of concrete skills/tools.
        system: 'Extract profile fields from this resume. Return ONLY JSON with string values (empty string if unknown): {"name","email","phone","location","links","school","degree","gradDate","gpa","targetRoles","skills"}. targetRoles: 2-4 role types this person is clearly aiming for. skills: comma list of concrete skills/tools.',
        // The resume (first 12,000 characters).
        messages: [{ role: 'user', content: car().resume.slice(0, 12000) }],
        // A short answer is enough.
        maxTokens: 800,
      });
      // Pull the JSON object out of the reply.
      const data = extractJSON(reply);
      // For each [key, value] the AI returned: only use it if it's a real profile field (`k in cc.profile`),
      // the value isn't empty, and you haven't filled that field yourself. String(v) makes sure it's text.
      updCar((cc) => { for (const [k, v] of Object.entries(data)) if (k in cc.profile && v && !cc.profile[k]) cc.profile[k] = String(v); });
      // Ask the user to check the AI's work.
      toast('profile filled in. double-check it');
    } catch (e) {
      // AI or JSON failed.
      toast(`couldn’t read it: ${e.message}`);
    }
    // Redraw the tab with the new values.
    drawProfile(el, redraw);
  });
}
