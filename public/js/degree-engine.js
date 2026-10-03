/*
 * degree-engine.js: the "brain" of the degree planner.
 *
 * This file only does math and matching. It never touches the web page (no DOM, no
 * document.querySelector), so it could also run in Node for testing. The page code
 * lives in degree.js, which imports these functions, hands them your saved degree data,
 * and draws the results on screen.
 *
 * Main ideas you'll see below:
 *  - Course-code patterns: requirement lists can say "PSY3XX" (X = any digit, so any
 *    300-level PSY course), "PSY" (any PSY course), "*4XX" (any 400-level course in any
 *    subject) or "PSY201H1 | STA220H1" (either one). We turn each pattern into a regex.
 *  - Greedy allocation: requirements are checked from most specific to broadest, and each
 *    course is "used up" by the first requirement that takes it, so one course never
 *    double-counts (unless a requirement is marked overlap = true).
 *  - Weighted average / GPA: each grade counts in proportion to the course's credits.
 *  - Streams are handled in degree.js; this file just evaluates whichever requirement list
 *    is currently active.
 *  - AI requirement extraction (reading a university calendar page and turning it into
 *    requirement objects) also happens in degree.js; whatever it produces is checked here.
 *  - parseTranscript() is the offline fallback that reads pasted transcript text without AI.
 */

// Degree math: credits, averages, requirement matching. No DOM, so it can be tested in Node.

// Credit systems at Canadian universities (credit value of a typical one-term course, and a typical
// 4-year honours total). Totals vary by program, so the total is a starting guess the user confirms.
// Each entry is an object: name = official name, re = a regex that recognises what a user
// might type for that school, credit = credits for one one-term course, unit = what the
// school calls its credits, total = typical credits needed to graduate.
// The /i at the end of every regex means "ignore upper/lower case".
// `export` means other files can import this value.
export const SCHOOLS = [
  // "toronto" (but not if "metropolitan" appears later, that's TMU), or the whole words uoft / utsc / utm.
  // (?!...) is a "negative lookahead": "only match if what follows is NOT this". \b means a word boundary.
  { name: 'University of Toronto', re: /toronto(?!.*metropolitan)|\buoft\b|\butsc\b|\butm\b/i, credit: 0.5, unit: 'credits', total: 20 },
  // "waterloo" (but not "waterloo ... laurier", that's Wilfrid Laurier), or the word "uw", or "uwaterloo".
  { name: 'University of Waterloo', re: /waterloo(?!.*laurier)|\buw\b|uwaterloo/i, credit: 0.5, unit: 'units', total: 20 },
  // "western" anywhere, or the word "uwo".
  { name: 'Western University', re: /western|\buwo\b/i, credit: 0.5, unit: 'courses', total: 20 },
  // "laurier" anywhere, or the word "wlu".
  { name: 'Wilfrid Laurier University', re: /laurier|\bwlu\b/i, credit: 0.5, unit: 'credits', total: 20 },
  // "guelph" anywhere.
  { name: 'University of Guelph', re: /guelph/i, credit: 0.5, unit: 'credits', total: 20 },
  // "carleton" anywhere.
  { name: 'Carleton University', re: /carleton/i, credit: 0.5, unit: 'credits', total: 20 },
  // the whole word "york", or "yorku". (Schools from here down use 3 credits per course.)
  { name: 'York University', re: /\byork\b|yorku/i, credit: 3, unit: 'credits', total: 120 },
  // "mcmaster", or the whole word "mac".
  { name: 'McMaster University', re: /mcmaster|\bmac\b/i, credit: 3, unit: 'units', total: 120 },
  // "queens" or "queen's" (the '? makes the apostrophe optional).
  { name: "Queen's University", re: /queen'?s/i, credit: 3, unit: 'units', total: 120 },
  // "ottawa" or "uottawa".
  { name: 'University of Ottawa', re: /ottawa|uottawa/i, credit: 3, unit: 'units', total: 120 },
  // "metropolitan", the word "tmu", or its old name "ryerson".
  { name: 'Toronto Metropolitan University', re: /metropolitan|\btmu\b|ryerson/i, credit: 1, unit: 'courses', total: 40 },
  // "british columbia" or the word "ubc".
  { name: 'University of British Columbia', re: /british columbia|\bubc\b/i, credit: 3, unit: 'credits', total: 120 },
  // "simon fraser" or the word "sfu".
  { name: 'Simon Fraser University', re: /simon fraser|\bsfu\b/i, credit: 3, unit: 'units', total: 120 },
  // "victoria" or the word "uvic".
  { name: 'University of Victoria', re: /victoria|\buvic\b/i, credit: 1.5, unit: 'units', total: 60 },
  // "mcgill" anywhere.
  { name: 'McGill University', re: /mcgill/i, credit: 3, unit: 'credits', total: 120 },
  // "concordia" anywhere.
  { name: 'Concordia University', re: /concordia/i, credit: 3, unit: 'credits', total: 120 },
  // "alberta" or "ualberta".
  { name: 'University of Alberta', re: /alberta|ualberta/i, credit: 3, unit: 'units', total: 120 },
  // "calgary" or "ucalgary".
  { name: 'University of Calgary', re: /calgary|ucalgary/i, credit: 3, unit: 'units', total: 120 },
  // "manitoba" anywhere.
  { name: 'University of Manitoba', re: /manitoba/i, credit: 3, unit: 'credit hours', total: 120 },
  // "saskatchewan" or "usask".
  { name: 'University of Saskatchewan', re: /saskatchewan|usask/i, credit: 3, unit: 'credit units', total: 120 },
  // "dalhousie" or the whole word "dal".
  { name: 'Dalhousie University', re: /dalhousie|\bdal\b/i, credit: 3, unit: 'credit hours', total: 120 },
];

/*
 * schoolPreset(name): find the SCHOOLS entry for whatever the user typed.
 * Input: a school name/nickname string (defaults to '' if nothing is passed).
 * Returns: the matching SCHOOLS object, or null if none match.
 * Example: schoolPreset('uoft') → the University of Toronto entry; schoolPreset('xyz') → null.
 *
 * JS concept, arrow functions: `(name = '') => ...` is a short way to write a function.
 * The `= ''` is a default value used when no argument is given.
 */
// .find() returns the first school where either its regex matches the text (re.test),
// or its official name equals the text ignoring case and outer spaces. `|| null` turns
// "nothing found" (undefined) into null.
export const schoolPreset = (name = '') => SCHOOLS.find((s) => s.re.test(name) || s.name.toLowerCase() === name.trim().toLowerCase()) || null;

// ---------- course codes ----------
/*
 * normCode(c): "normalise" a course code so different spellings compare equal.
 * Input: any value (turned into a string). Returns: upper-case code with no spaces,
 * hyphens, underscores or dots.
 * Example: normCode('psy 100-h1') → 'PSY100H1'.
 */
// String(c) makes sure we have text; .toUpperCase() capitalises it; the regex
// /[\s\-_.]/g means "any whitespace, hyphen, underscore or dot, everywhere (g = global)",
// and .replace(..., '') deletes all of them.
export const normCode = (c = '') => String(c).toUpperCase().replace(/[\s\-_.]/g, '');

/*
 * codeMatches(pattern, code): does a course code satisfy a requirement pattern?
 * Inputs: pattern (e.g. 'PSY3XX', 'PSY', '*4XX', 'PSY201H1 | STA220H1'), code (the student's course).
 * Returns: true or false.
 * Examples: codeMatches('PSY3XX', 'PSY312H1') → true; codeMatches('PSY100', 'PSY100H1') → true;
 *           codeMatches('PSY201 | STA220', 'STA220H1') → true; codeMatches('PSY3XX', 'PSY201H1') → false.
 */
// "PSY100" matches "PSY100H1"; "PSY3XX" matches any 300-level PSY; "*4XX" any 400-level; alternatives use "|"
export function codeMatches(pattern, code) {
  // Clean up the student's code once so we can compare against each alternative.
  const target = normCode(code);
  // Split the pattern into alternatives. The regex /\s*\|\s*|\s+or\s+/i splits on either
  // a "|" (with any spaces around it) or the word "or" surrounded by spaces (any case).
  // .some() returns true as soon as ANY alternative matches.
  return String(pattern).split(/\s*\|\s*|\s+or\s+/i).some((alt) => {
    // Normalise this one alternative (e.g. ' sta 220 ' → 'STA220').
    const p = normCode(alt);
    // If the alternative is empty, it can't match. Otherwise build/reuse its regex and test the code.
    // `a ? b : c` is the ternary operator: "if a then b else c".
    return p ? patternRegex(p).test(target) : false;
  });
}
// A Map is a key → value lookup table. Here: pattern text → its compiled regex, so we
// only build each regex once even though matching runs many times (this is "caching").
const reCache = new Map();
/*
 * patternRegex(p): turn a normalised pattern into a RegExp that tests course codes.
 * Input: p, an already-normalised pattern like 'PSY3XX', 'PSY', '*4XX', 'PSY100H1'.
 * Returns: a RegExp. Examples of what gets built:
 *   'PSY'      → /^PSY(?=\d)/          any PSY course (PSY followed by a digit)
 *   'PSY3XX'   → /^PSY3\d\d(?!\d)/     PSY + 3 + two digits, and no extra digit after
 *   'PSY100'   → /^PSY100(?!\d)/       so it matches PSY100H1 but not PSY1001
 *   '*4XX'     → /^[A-Z]+4\d\d(?!\d)/  any letters + a 400-level number
 */
function patternRegex(p) {
  // Already built this one before? Return the saved copy.
  if (reCache.has(p)) return reCache.get(p);
  // subj = the subject part as regex text (e.g. 'PSY'); rest = everything after it (e.g. '3XX').
  let subj;
  let rest;
  // A leading * means "any subject": [A-Z]+ is one or more capital letters. Drop the * from rest.
  if (p.startsWith('*')) { subj = '[A-Z]+'; rest = p.slice(1); }
  else {
    // Subject = leading letters up to the first digit / X wildcard / *  ("PSYXXX" → PSY + XXX)
    // First regex: at the start (^), at least 2 capital letters, as FEW as possible ({2,}? is "lazy"),
    // stopping right before a digit, an X, a *, or the end of the text ((?=...) peeks ahead
    // without consuming). Being lazy is what stops "PSYXXX" from swallowing the X's as letters.
    // If that fails (e.g. a 1-letter subject), the fallback /^[A-Z]*/ grabs any leading letters (maybe none).
    const m = p.match(/^[A-Z]{2,}?(?=[\dX*]|$)/) || p.match(/^[A-Z]*/);
    // m[0] is the full text the regex matched, i.e. the subject letters.
    subj = m[0];
    // Everything after the subject, e.g. '3XX' or '100H1' (or '' for a bare subject).
    rest = p.slice(subj.length);
  }
  // Will hold the finished regex.
  let re;
  // Template literals: backtick strings like `^${subj}` let you drop variables in with ${...}.
  // In a string, '\\d' is how you write the regex \d (a digit), because \ must be escaped.
  // Bare subject: "starts with the subject, and the next character is a digit".
  if (!rest) re = new RegExp(`^${subj}(?=\\d)`); // bare subject ("PSY") = any PSY course
  else {
    // Build the regex text for the rest of the code:
    //  1) remove anything that isn't a capital letter, digit or * (safety: no stray regex symbols),
    //  2) every X becomes \d (any one digit),
    //  3) every * becomes .* (anything at all, any length).
    const body = rest.replace(/[^A-Z0-9*]/g, '').replace(/X/g, '\\d').replace(/\*/g, '.*');
    // Glue it together: start (^) + subject + body. Unless the pattern ended in *, add (?!\d)
    // ("not followed by another digit") so 'PSY10' doesn't accidentally match 'PSY100'.
    re = new RegExp(`^${subj}${body}${rest.endsWith('*') ? '' : '(?!\\d)'}`);
  }
  // Save it in the cache for next time, then return it.
  reCache.set(p, re);
  return re;
}

// ---------- grades ----------
// Letter grade → 4.0-scale grade points. Keys with + or - need quotes; plain letters don't.
// F and E (some schools use E for fail) are worth 0.
const LETTER = { 'A+': 4.0, A: 4.0, 'A-': 3.7, 'B+': 3.3, B: 3.0, 'B-': 2.7, 'C+': 2.3, C: 2.0, 'C-': 1.7, 'D+': 1.3, D: 1.0, 'D-': 0.7, F: 0, E: 0 };
/*
 * parseGrade(g): understand whatever the student typed in the grade box.
 * Input: a grade like '85', '85%', 'B+', 'CR', 'FAIL', or empty.
 * Returns one of:
 *   { pct, pass }  for a percentage, e.g. parseGrade('85') → { pct: 85, pass: true }
 *   { gpa, pass }  for a letter,     e.g. parseGrade('b+') → { gpa: 3.3, pass: true }
 *   { pass }       for pass/fail marks, e.g. parseGrade('CR') → { pass: true }
 *   null           if empty or not understood.
 */
export function parseGrade(g) {
  // `g ?? ''` (nullish coalescing): use g, but if it's null or undefined use '' instead.
  // Then make it a string, trim spaces, and upper-case it so 'b+' and 'B+' are the same.
  const s = String(g ?? '').trim().toUpperCase();
  // Nothing typed → no grade.
  if (!s) return null;
  // Percentage? The regex means: 1–3 digits, optionally a dot and more digits, optionally a %,
  // and nothing else (^ start, $ end). parseFloat reads the number (it ignores a trailing %).
  // Only 0–100 is valid; 50+ counts as a pass. Anything over 100 → null (not understood).
  if (/^\d{1,3}(\.\d+)?%?$/.test(s)) { const n = parseFloat(s); return n <= 100 ? { pct: n, pass: n >= 50 } : null; }
  // Letter grade? `key in object` checks whether the LETTER table has this key. Pass = worth more than 0.
  if (s in LETTER) return { gpa: LETTER[s], pass: LETTER[s] > 0 };
  // Pass-type marks: exactly CR (credit), P, PASS, S or SAT (satisfactory).
  if (/^(CR|P|PASS|S|SAT)$/.test(s)) return { pass: true };
  // Fail-type marks: exactly NCR (no credit), FAIL, NC, U (unsatisfactory) or WF (withdrew failing).
  if (/^(NCR|FAIL|NC|U|WF)$/.test(s)) return { pass: false };
  // Anything else we don't recognise.
  return null;
}

// How "far along" each status is: lower number = better (completed beats in-progress beats planned).
// Used to pick between duplicate attempts and to sort courses.
const STATUS_RANK = { completed: 0, 'in-progress': 1, planned: 2 };
/*
 * countable(years): build the list of courses that can count toward the degree.
 * Input: years, the array of year folders, each with a .courses array.
 * Returns: an array of course objects (copies) with extra fields added:
 *   status (defaulted), credits (as a number), yearId, yearLabel, key (normalised code).
 * Rules: failed/dropped courses are skipped; completed courses with a failing grade are skipped;
 * if the same code appears more than once (a retake), only one is kept: the one furthest
 * along (completed > in-progress > planned). On a tie, the first one found stays.
 */
// Courses that can count, one per course code (retakes keep the best attempt)
export function countable(years) {
  // Map of course key → best attempt seen so far.
  const best = new Map();
  // `years || []` means: if years is missing, loop over an empty list instead of crashing.
  for (const y of years || []) {
    for (const c of y.courses || []) {
      // Courses with no status saved are treated as completed.
      let status = c.status || 'completed';
      // `continue` skips to the next course: failed/dropped never count.
      if (status === 'failed' || status === 'dropped') continue;
      // Read the grade so we can catch failing marks.
      const g = parseGrade(c.grade);
      // A "completed" course whose grade is a fail (e.g. 40 or F) doesn't count either.
      // We check `g &&` first because g is null when there's no grade.
      if (status === 'completed' && g && g.pass === false) continue;
      // Number(...) converts text like '0.5' to 0.5; `|| 0` turns NaN/empty into 0.
      const credits = Number(c.credits) || 0;
      // The key identifies the course: its normalised code, or its id if it has no code.
      const key = normCode(c.code) || c.id;
      // Spread syntax `{ ...c, x }`: copy every property of c into a new object, then add/overwrite
      // the listed ones. This avoids changing the saved course itself.
      const item = { ...c, status, credits, yearId: y.id, yearLabel: y.label, key };
      // Have we already seen this course code?
      const prev = best.get(key);
      // Keep this attempt if it's the first one, or if its status ranks better than the earlier one.
      if (!prev || STATUS_RANK[status] < STATUS_RANK[prev.status]) best.set(key, item);
    }
  }
  // best.values() gives the kept courses; [...x] spreads them into a normal array.
  return [...best.values()];
}

/*
 * sumCredits(list, status): add up credits.
 * Inputs: list of countable courses; status (optional) to only count e.g. 'completed'.
 * Returns: the total, rounded to 2 decimals. Example: sumCredits(list, 'completed') → 7.5
 */
export function sumCredits(list, status) {
  // filter: keep every course if no status was given, otherwise only that status.
  // reduce: start at 0 and add each course's credits (a = running total, c = current course).
  return round(list.filter((c) => !status || c.status === status).reduce((a, c) => a + c.credits, 0));
}
// Round to 2 decimal places, avoiding floating-point noise like 0.1 + 0.2 = 0.30000000000000004.
// Example: round(1.23456) → 1.23.
export const round = (n) => Math.round(n * 100) / 100;

/*
 * averages(years): credit-weighted average percentage and GPA.
 * Input: the years array. Returns: { percent, gpa }, each null if there are no grades of that kind.
 * "Weighted" means a 1.0-credit course counts twice as much as a 0.5-credit one:
 *   average = sum(grade × credits) / sum(credits).
 * Example: 80% in a 0.5 course and 90% in a 1.0 course → (40 + 90) / 1.5 = 86.7.
 * Completed courses (or ones with no status) and failed courses are included; others are not.
 */
export function averages(years) {
  // pw/pSum = total credits and weighted sum for percentage grades; gw/gSum = same for letter (GPA) grades.
  let pw = 0, pSum = 0, gw = 0, gSum = 0;
  // Two loops on one line: every course in every year.
  for (const y of years || []) for (const c of y.courses || []) {
    // Skip anything that isn't completed (missing status = completed) and isn't failed.
    if ((c.status || 'completed') !== 'completed' && c.status !== 'failed') continue;
    // Understand the grade.
    const g = parseGrade(c.grade);
    // The weight is the course's credits.
    const w = Number(c.credits) || 0;
    // No usable grade or zero credits → it can't affect the average.
    if (!g || !w) continue;
    // Percentage grade: add grade × weight and the weight. (`!= null` catches both null and undefined.)
    if (g.pct != null) { pSum += g.pct * w; pw += w; }
    // Letter grade: same idea on the 4.0 scale.
    if (g.gpa != null) { gSum += g.gpa * w; gw += w; }
  }
  // Divide to get the averages. Percent is rounded to 1 decimal, GPA to 2. If there was no weight, return null.
  return { percent: pw ? Math.round((pSum / pw) * 10) / 10 : null, gpa: gw ? Math.round((gSum / gw) * 100) / 100 : null };
}

// ---------- requirements ----------
// Specific course lists first, then narrow "choose" lists, then broad ones, so a course
// isn't used up by a broad requirement when a specific one needed it.
/*
 * breadth(pattern): a score for how broad one pattern is (bigger = matches more courses).
 * Input: a pattern string. Returns a number:
 *   '*...' (any subject) → 20, bare subject 'PSY' → 10,
 *   otherwise the number of X wildcards, plus 6 if it contains a *.
 * Examples: breadth('PSY100H1') → 0, breadth('PSY3XX') → 2, breadth('PSY') → 10, breadth('*4XX') → 20.
 */
function breadth(pattern) {
  // Normalise first (upper-case, no spaces etc.).
  const p = normCode(pattern);
  // Any-subject patterns are the broadest.
  if (p.startsWith('*')) return 20;
  // Find the subject letters, same lazy regex as in patternRegex (see there). If no match,
  // `|| ['']` gives a fake match whose [0] is '' so the code doesn't crash.
  const subj = (p.match(/^[A-Z]{2,}?(?=[\dX*]|$)/) || [''])[0];
  // What's left after the subject.
  const rest = p.slice(subj.length);
  // Nothing left → a whole subject like 'PSY'.
  if (!rest) return 10; // whole subject
  // Count the X's (/X/g finds them all; `|| []` handles "none found"), and add 6 if there's a *.
  return (rest.match(/X/g) || []).length + (rest.includes('*') ? 6 : 0);
}
/*
 * specificity(r): sort score for a whole requirement (lower = checked first).
 * Input: a requirement object. Returns a number:
 *   'courses' type (specific required courses) → 0, always first.
 *   empty course list → 100, last.
 *   otherwise 1 + the breadth of its broadest pattern + a tiny bit for list length
 *   (length / 1000 only breaks ties: shorter lists go first).
 */
function specificity(r) {
  if (r.type === 'courses') return 0;
  // filter(Boolean) removes empty entries like '' or null.
  const list = (r.courses || []).filter(Boolean);
  if (!list.length) return 100;
  // list.map(breadth) scores every pattern; Math.max(...array) spreads the array into
  // separate arguments so Math.max can find the largest.
  return 1 + Math.max(...list.map(breadth)) + list.length / 1000;
}

/*
 * evaluate(degree): check every requirement against the student's courses.
 * Input: the whole degree object (years, requirements, totalCredits…).
 * Returns: an object keyed by requirement id, e.g.
 *   { abc123: { state: 'met', done: 2, inProgress: 0, planned: 0, need: 2, unit: 'courses', matched: [...], missing: [] } }
 * state is one of 'met', 'in-progress', 'planned', 'missing', or 'manual' (check it yourself).
 * How it works (greedy allocation): requirements are processed from most to least specific.
 * Each one takes the courses it needs from the pool, and (unless overlap is on) those courses
 * are marked as used so later requirements can't count them again.
 */
export function evaluate(degree) {
  // All courses that can count (deduplicated, failed/dropped removed).
  const courses = countable(degree.years);
  // The requirement list (or empty).
  const reqs = degree.requirements || [];
  // A Set is a collection of unique values. It holds the keys of courses already used up.
  const used = new Set();
  // Will be filled with one result per requirement id.
  const results = {};
  // Sort comparator: completed first, then in-progress, then planned; if the status is the same
  // (difference 0, which is "falsy"), `||` moves on to: more credits first.
  const byStatus = (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.credits - a.credits;
  // How much a list of courses is worth: a count of courses, or a sum of credits, depending on unit.
  const amount = (list, unit) => round(unit === 'courses' ? list.length : list.reduce((a, c) => a + c.credits, 0));

  // [...reqs] makes a copy so sorting doesn't reorder the saved list. Sort by specificity (lowest first).
  for (const r of [...reqs].sort((a, b) => specificity(a) - specificity(b))) {
    // Courses available to this requirement: all of them if it allows overlap, otherwise only unused ones.
    const pool = courses.filter((c) => r.overlap || !used.has(c.key));
    // Manual requirement (e.g. "minimum GPA"): the student ticks it off themselves.
    if (r.type === 'manual') {
      results[r.id] = { state: r.done ? 'met' : 'manual', done: r.done ? 1 : 0, need: 1, matched: [], missing: [] };
      // Go to the next requirement.
      continue;
    }
    // Total credits needed to graduate. It uses ALL courses (not the pool), since everything counts toward the total.
    if (r.type === 'total') {
      // Amount needed: the requirement's own min, or the degree's totalCredits, or 0.
      const need = Number(r.min) || Number(degree.totalCredits) || 0;
      // Credits already earned.
      const done = sumCredits(courses, 'completed');
      // Earned + currently taking.
      const withIp = round(done + sumCredits(courses, 'in-progress'));
      // Earned + taking + planned.
      const withPlan = round(withIp + sumCredits(courses, 'planned'));
      // Store the result. inProgress and planned are recovered by subtracting the running totals.
      results[r.id] = { state: stateOf(done, withIp, withPlan, need), done, inProgress: round(withIp - done), planned: round(withPlan - withIp), need, unit: 'credits', matched: [], missing: [] };
      continue;
    }
    // Specific courses: each entry (like 'PSY100H1' or 'PSY201H1 | STA220H1') needs one matching course.
    if (r.type === 'courses') {
      // The entries, with blanks removed.
      const entries = (r.courses || []).filter(Boolean);
      // How many entries are required: r.min if set (e.g. "2 of these 4"), otherwise all of them,
      // but never more than the number of entries.
      const need = Math.min(Number(r.min) || entries.length, entries.length);
      // Courses that matched an entry, and entries nobody matched.
      const matched = [];
      const missing = [];
      // Courses already matched to an earlier entry in THIS requirement (so one course can't fill two entries).
      const taken = new Set();
      for (const entry of entries) {
        // Candidates: pool courses not yet taken here that match this entry; sort best-first and take [0].
        const hit = pool.filter((c) => !taken.has(c.key) && codeMatches(entry, c.code)).sort(byStatus)[0];
        // Found one → remember it (with which entry it filled) and mark it taken; otherwise the entry is missing.
        if (hit) { matched.push({ ...hit, entry }); taken.add(hit.key); } else missing.push(entry);
      }
      // Keep only the best `need` matches (completed first). slice(0, need) takes the first `need` items.
      const chosen = matched.sort(byStatus).slice(0, need);
      // Unless overlap is allowed, these courses are now used up for later requirements.
      if (!r.overlap) chosen.forEach((c) => used.add(c.key));
      // Count how many of the chosen courses are done / in progress / planned.
      const done = chosen.filter((c) => c.status === 'completed').length;
      const ip = chosen.filter((c) => c.status === 'in-progress').length;
      const pl = chosen.filter((c) => c.status === 'planned').length;
      // Save the result. Missing entries are only listed if we still don't have enough (counting plans).
      results[r.id] = { state: stateOf(done, done + ip, done + ip + pl, need), done, inProgress: ip, planned: pl, need, unit: 'courses', matched: chosen, missing: done + ip + pl >= need ? [] : missing };
      continue;
    }
    // choose: X credits (or courses) from a list / pattern
    // Measure in courses only if explicitly asked; otherwise credits.
    const unit = r.unit === 'courses' ? 'courses' : 'credits';
    // The amount needed.
    const need = Number(r.min) || 0;
    // Every pool course that matches at least one pattern in the list, sorted best-first.
    const candidates = pool.filter((c) => (r.courses || []).some((p) => codeMatches(p, c.code))).sort(byStatus);
    // Greedy: take candidates one by one until we have enough.
    const chosen = [];
    for (const c of candidates) {
      // Stop as soon as the chosen courses reach the needed amount (`break` exits the loop).
      if (amount(chosen, unit) >= need) break;
      chosen.push(c);
    }
    // Mark them as used (unless overlap is allowed).
    if (!r.overlap) chosen.forEach((c) => used.add(c.key));
    // Amount done / in progress / planned among the chosen courses.
    const done = amount(chosen.filter((c) => c.status === 'completed'), unit);
    const ip = amount(chosen.filter((c) => c.status === 'in-progress'), unit);
    const pl = amount(chosen.filter((c) => c.status === 'planned'), unit);
    // Save the result (choose lists don't have a fixed "missing" list).
    results[r.id] = { state: stateOf(done, done + ip, done + ip + pl, need), done, inProgress: ip, planned: pl, need, unit, matched: chosen, missing: [] };
  }
  return results;
}

/*
 * stateOf(done, withIp, withPlan, need): turn amounts into a status word.
 * Inputs: amount done, done + in progress, done + in progress + planned, and amount needed.
 * Returns: 'met' | 'in-progress' | 'planned' | 'missing'.
 * Example: stateOf(1, 2, 2, 2) → 'in-progress' (you'll have enough once current courses finish).
 * The `- 1e-9` (0.000000001) is a tiny tolerance so floating-point rounding (1.9999999 vs 2) doesn't break comparisons.
 */
function stateOf(done, withIp, withPlan, need) {
  // Needing nothing counts as met.
  if (!need) return 'met';
  if (done >= need - 1e-9) return 'met';
  if (withIp >= need - 1e-9) return 'in-progress';
  if (withPlan >= need - 1e-9) return 'planned';
  return 'missing';
}

/*
 * summary(degree): everything the top "progress" card needs, in one object.
 * Input: the degree object. Returns an object with:
 *   earned / inProgress / planned credits, total needed, left (and left after current / after plan),
 *   pct / pctIp / pctPlan (0–100, for the progress ring), pace (credits per finished year),
 *   yearsLeft (estimate, rounded up to the nearest half year, or null), reqMet / reqCount,
 *   percent / gpa (from averages), and results (from evaluate).
 */
export function summary(degree) {
  // Countable courses and their credit totals by status.
  const courses = countable(degree.years);
  const earned = sumCredits(courses, 'completed');
  const inProgress = sumCredits(courses, 'in-progress');
  const planned = sumCredits(courses, 'planned');
  // The "total needed to graduate" requirement, if there is one.
  const totalReq = (degree.requirements || []).find((r) => r.type === 'total');
  // Credits needed: the saved setting, else the total requirement's min, else 0.
  // Optional chaining `totalReq?.min`: if totalReq is undefined, give undefined instead of crashing.
  const total = Number(degree.totalCredits) || Number(totalReq?.min) || 0;
  // Check all requirements.
  const results = evaluate(degree);
  // Requirements to count in "X of Y met" (the total one is shown separately, so leave it out).
  const reqs = (degree.requirements || []).filter((r) => r.type !== 'total');
  // How many are met. `results[r.id]?.state` safely reads state even if there's no result.
  const met = reqs.filter((r) => results[r.id]?.state === 'met').length;
  // Pace = average credits earned in years that are finished (nothing in progress or planned),
  // so a half-done current year doesn't drag the estimate down
  // A year is "finished" if it has courses and every course is completed, failed, dropped, or has no status.
  const finished = (degree.years || []).filter((y) => (y.courses || []).length && y.courses.every((c) => ['completed', 'failed', 'dropped', undefined].includes(c.status)));
  // The ids of those years, in a Set for quick lookups.
  const finishedKeys = new Set(finished.map((y) => y.id));
  // Credits completed in finished years only.
  const finishedEarned = courses.filter((c) => c.status === 'completed' && finishedKeys.has(c.yearId)).reduce((a, c) => a + c.credits, 0);
  // Average per finished year (0 if no year is finished yet).
  const pace = finished.length ? finishedEarned / finished.length : 0;
  // What's left now / after this term's courses / after everything planned. Math.max(0, …) stops negatives.
  const left = round(Math.max(0, total - earned));
  const leftAfterCurrent = round(Math.max(0, total - earned - inProgress));
  const leftAfterPlan = round(Math.max(0, total - earned - inProgress - planned));
  return {
    // Shorthand properties: `earned` here means `earned: earned`.
    earned, inProgress, planned, total, left, leftAfterCurrent, leftAfterPlan,
    // Percent of the total that's earned (capped at 100; 0 if no total is set).
    pct: total ? Math.min(100, (earned / total) * 100) : 0,
    // Same, counting in-progress courses too.
    pctIp: total ? Math.min(100, ((earned + inProgress) / total) * 100) : 0,
    // Same, counting planned courses too.
    pctPlan: total ? Math.min(100, ((earned + inProgress + planned) / total) * 100) : 0,
    // Years left = what's left after this term ÷ pace, rounded UP to the nearest half (×2, ceil, ÷2).
    // e.g. 1.2 → 1.5. null if we don't know the pace yet.
    yearsLeft: pace > 0 ? Math.ceil((leftAfterCurrent / pace) * 2) / 2 : null,
    pace: round(pace),
    reqMet: met, reqCount: reqs.length,
    // Spread the { percent, gpa } object from averages() into this object.
    ...averages(degree.years),
    results,
  };
}

// ---------- transcript text → years (offline, used when AI isn't connected) ----------
// A course code: a word boundary, then 2–5 capital letters (group 1, the subject, e.g. PSY),
// then an optional space or hyphen, then 3–4 digits, an optional letter and an optional digit
// (group 2, e.g. 100H1 or 1010), then a word boundary. Matches "PSY100H1", "PSY 100", "MATH-1010".
const CODE_RE = /\b([A-Z]{2,5})[\s-]?(\d{3,4}[A-Z]?\d?)\b/;
// A term heading, in either order (case-insensitive because of /i):
//   season first: (fall|autumn|winter|spring|summer|intersession or just f/w/s) as group 1,
//                 then any spaces / slashes / hyphens, then a 20xx year as group 2. e.g. "Fall 2024", "W/2025"
//   OR year first: a 20xx year as group 3, separators, then the season as group 4. e.g. "2024 Fall"
const TERM_RE = /\b(fall|autumn|winter|spring|summer|intersession|f|w|s)\b[\s/-]*(20\d{2})|\b(20\d{2})[\s/-]*(fall|autumn|winter|spring|summer|f|w|s)\b/i;
/*
 * parseTranscript(text): a simple, offline transcript reader (used when AI isn't available).
 * Input: transcript text (e.g. copied from a PDF). It goes line by line:
 *   - a line that's a term heading ("Fall 2024") sets the current term,
 *   - a line with a course code becomes a course in that term, and we try to pull out
 *     its credits, grade and title from the rest of the line.
 * Returns: an array of years sorted oldest first, like
 *   [{ start: 2024, courses: [{ code: 'PSY 100H1', title: 'Intro Psych', credits: 0.5, term: 'Fall', grade: '85', status: 'completed' }] }]
 * "start" is the calendar year the academic year began (Fall 2024 and Winter 2025 both → 2024).
 */
export function parseTranscript(text) {
  // Map of academic start year → { start, courses }.
  const years = new Map();
  // The term we're currently inside (null until we see the first heading).
  let term = null;
  // Go through the text one line at a time ('\n' is a line break).
  for (const raw of String(text).split('\n')) {
    // Remove spaces at both ends.
    const line = raw.trim();
    // Does the line contain a term? t is the match array (or null).
    const t = line.match(TERM_RE);
    // It's a heading only if it has a term AND, after removing the term text, no course code is left
    // (so a course line that happens to mention "Fall 2024" is still treated as a course).
    if (t && !CODE_RE.test(line.replace(TERM_RE, ''))) {
      // The season is in group 1 (season-first form) or group 4 (year-first form).
      const season = (t[1] || t[4]).toLowerCase();
      // The year is in group 2 or group 3. The `+` in front turns the text into a number.
      const year = +(t[2] || t[3]);
      // Translate any season spelling to Fall / Winter / Summer using a lookup object; [season] picks the entry.
      // Spring and intersession are treated as Summer.
      const name = { f: 'Fall', autumn: 'Fall', fall: 'Fall', w: 'Winter', winter: 'Winter', s: 'Summer', summer: 'Summer', spring: 'Summer', intersession: 'Summer' }[season];
      // Fall starts the academic year; Winter/Summer belong to the year that started the previous fall.
      const start = name === 'Fall' ? year : year - 1;
      // Remember the current term and move to the next line.
      term = { name, start };
      continue;
    }
    // Look for a course code. m[1] = subject, m[2] = number, m.index = where it starts.
    const m = line.match(CODE_RE);
    // No code, or no term seen yet → ignore this line.
    if (!m || !term) continue;
    // The text after the course code (title, credits, grade…).
    const rest = line.slice(m.index + m[0].length);
    // Every standalone number in the rest: 1–3 digits with optionally a dot and 1–2 decimals,
    // not touching a letter/digit/underscore/dot on either side ((?<!...) looks behind, (?!...) looks ahead).
    // matchAll gives every match; [...x] makes an array; .map(x => x[1]) keeps just the number text.
    const nums = [...rest.matchAll(/(?<![\w.])(\d{1,3}(?:\.\d{1,2})?)(?![\w.])/g)].map((x) => x[1]);
    // A letter grade as its own word: at the start or after a space, one of A+ A- A B+ … F, CR, NCR, P,
    // or IP (in progress), followed by a space or the end of the line. Group 1 holds which one.
    const letter = rest.match(/(?:^|\s)(A\+|A-|A|B\+|B-|B|C\+|C-|C|D\+|D-|D|F|CR|NCR|P|IP)(?=\s|$)/);
    // credits look like 0.50 / 1.00 / 3.00 / 3; grades look like 85 or letters
    // Credits = the first number that has a decimal point, or is between 0 (exclusive) and 6.
    const credit = nums.find((n) => /\.\d/.test(n) || (+n > 0 && +n <= 6));
    // Percentage grade = the first number above 6 and up to 100 that isn't the credit value.
    const pct = nums.find((n) => +n > 6 && +n <= 100 && n !== credit);
    // The title = the rest of the line with the clutter removed, step by step:
    //  1) delete the standalone numbers (same pattern as above),
    //  2) replace standalone letter grades with a space (same pattern as `letter`, but g = all of them),
    //  3) replace runs of | or : with a space,
    //  4) squeeze 2+ spaces into one, 5) trim the ends.
    const title = rest.replace(/(?<![\w.])\d{1,3}(?:\.\d{1,2})?(?![\w.])/g, '').replace(/(?:^|\s)(A\+|A-|A|B\+|B-|B|C\+|C-|C|D\+|D-|D|F|CR|NCR|P|IP)(?=\s|$)/g, ' ').replace(/[|:]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    // Grade = the letter (unless it was IP, which isn't a grade), otherwise the percentage, otherwise ''.
    const grade = letter && letter[1] !== 'IP' ? letter[1] : pct || '';
    // Status: in-progress if marked IP, or if there's no grade and the line says "in progress" / "ip";
    // otherwise completed if there's a grade, else in-progress. `letter?.[1]` safely reads group 1 even if letter is null.
    const status = letter?.[1] === 'IP' || (!grade && /in progress|ip\b/i.test(line)) ? 'in-progress' : grade ? 'completed' : 'in-progress';
    // Group courses by academic start year.
    const key = term.start;
    // First course for this year? Create its entry.
    if (!years.has(key)) years.set(key, { start: key, courses: [] });
    // Add the course. Code is rebuilt as "SUBJECT NUMBER"; title capped at 80 characters;
    // credits as a number (or null if none found); grade always a string.
    years.get(key).courses.push({ code: `${m[1]} ${m[2]}`, title: title.slice(0, 80), credits: credit ? +credit : null, term: term.name, grade: String(grade), status });
  }
  // Turn the Map into an array and sort by start year (oldest first).
  return [...years.values()].sort((a, b) => a.start - b.start);
}

/*
 * yearLabel(n, start): the name shown on a year folder.
 * Inputs: n = year number (1, 2, …), start = academic start year (optional).
 * Returns e.g. yearLabel(2, 2025) → 'Year 2 · 2025–26'; yearLabel(1) → 'Year 1'.
 * There's a template literal nested inside another: the inner one only appears if start is set.
 * (start + 1) % 100 keeps the last two digits of the next year; padStart(2, '0') makes 5 → '05'.
 */
export const yearLabel = (n, start) => `Year ${n}${start ? ` · ${start}–${String((start + 1) % 100).padStart(2, '0')}` : ''}`;
/*
 * currentTerm(d): which term a date falls in.
 * Input: a Date (defaults to now). Returns 'Fall' (Sep–Dec), 'Winter' (Jan–Apr) or 'Summer' (May–Aug).
 * Note: getMonth() counts from 0, so 0 = January, 3 = April, 8 = September.
 */
export function currentTerm(d = new Date()) {
  const m = d.getMonth();
  // Chained ternary: Sep or later → Fall; else April or earlier → Winter; else Summer.
  return m >= 8 ? 'Fall' : m <= 3 ? 'Winter' : 'Summer';
}
/*
 * academicStart(d): the calendar year the current academic year began.
 * Input: a Date (defaults to now). From August (month 7) onward it's this year; before that, last year.
 * Example: March 2026 → 2025; September 2025 → 2025.
 */
export function academicStart(d = new Date()) {
  return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
}

// ---------- auto-detect required courses you've already done ----------
/*
 * isConcreteCode(p): is pattern `p` one specific course code (not a wildcard)?
 * Input: one requirement entry (already a single alternative, no " | "). Returns true/false.
 * True for 'PSY100H1' or 'MAT137'; false for wildcard/subject patterns like 'PSY3XX', 'PSY' or '*4XX'.
 * How: normalise it, then require it to be letters followed by at least one digit, with no
 * wildcard characters (X or *) anywhere. The /^[A-Z]+\d/ check means "letters then a digit".
 */
export function isConcreteCode(p) {
  // Normalise first (upper-case, strip spaces/punctuation).
  const c = normCode(p);
  // Reject anything containing an X or * wildcard, and require letters-then-digit (a real code).
  return !!c && !/[X*]/.test(c) && /^[A-Z]+\d/.test(c);
}

/*
 * requiredCodes(degree): every SPECIFIC course the requirements name, with where it comes from.
 * Input: the degree object. Returns an array of objects, one per concrete required code:
 *   { code, key, reqId, reqName, alt }  where
 *     code  = the code as written (e.g. 'PSY201H1'),
 *     key   = its normalised form (e.g. 'PSY201H1'), used for matching,
 *     reqId / reqName = which requirement it belongs to,
 *     alt   = true if it was one of several " | " alternatives (so it's required OR another is).
 * Wildcard patterns ('PSY3XX', 'PSY', '*4XX') are skipped — they don't name one course, so there's
 * nothing specific to tick off. Duplicates (same code in the same requirement) are removed.
 */
export function requiredCodes(degree) {
  // Collected results.
  const out = [];
  // Remember code+requirement pairs we've already added, so we don't list the same one twice.
  const seen = new Set();
  // Walk every requirement that lists courses ('courses' and 'choose' types).
  for (const r of degree.requirements || []) {
    if (r.type !== 'courses' && r.type !== 'choose') continue;
    // Each entry may be a single code or alternatives like 'PSY201H1 | STA220H1'.
    for (const entry of (r.courses || []).filter(Boolean)) {
      // Split on " | " / " or " (same splitter codeMatches uses). alts.length > 1 means it was a choice.
      const alts = String(entry).split(/\s*\|\s*|\s+or\s+/i).map((s) => s.trim()).filter(Boolean);
      for (const a of alts) {
        // Skip wildcard/subject patterns — only keep real single codes.
        if (!isConcreteCode(a)) continue;
        const key = normCode(a);
        // Unique per requirement so one requirement doesn't list the same code twice.
        const id = r.id + '|' + key;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ code: a, key, reqId: r.id, reqName: r.name || 'requirement', alt: alts.length > 1 });
      }
    }
  }
  return out;
}

/*
 * detectCompleted(degree, extraCourses): find required courses you've ALREADY taken.
 * Inputs:
 *   degree       = the degree object (its year folders and requirements),
 *   extraCourses = other courses the app knows about (e.g. store.get().courses, the classes
 *                  you're taking now), each roughly { code, name, grade, status }. Optional.
 * Returns an array, one entry per specific required code that appears in your records:
 *   { code, key, reqName, alt, status, grade, inFolder, source }  where
 *     status   = 'completed' | 'in-progress' | 'planned' (best attempt found),
 *     grade    = the grade on record (may be ''),
 *     inFolder = true if that course is already in a year folder (so it's already counted),
 *     source   = 'folder' or 'app' (where we found it).
 * Why this exists: the planner can only count a required course once it's in a year folder.
 * This spots required courses sitting in your transcript import or your current-courses list and
 * lets the page offer to add them, so "what have I done?" is answered automatically.
 */
export function detectCompleted(degree, extraCourses = []) {
  // The specific codes the requirements ask for.
  const required = requiredCodes(degree);
  // Nothing specific is required → nothing to detect.
  if (!required.length) return [];
  // Build a lookup of every course the student has, keyed by normalised code, keeping the best
  // attempt (completed beats in-progress beats planned). Value: { status, grade, inFolder, source }.
  const have = new Map();
  // consider(code, status, grade, inFolder, source): record this course if it's better than what we have.
  const consider = (code, status, grade, inFolder, source) => {
    const key = normCode(code);
    if (!key) return;
    // Skip failed/dropped — those aren't "done".
    if (status === 'failed' || status === 'dropped') return;
    // Treat a missing status as completed (same rule the rest of the engine uses).
    const st = status || 'completed';
    const prev = have.get(key);
    // Keep this one if it's new or ranks better (lower STATUS_RANK = further along).
    if (!prev || STATUS_RANK[st] < STATUS_RANK[prev.status]) {
      have.set(key, { status: st, grade: grade || '', inFolder, source });
    } else if (prev && inFolder && !prev.inFolder) {
      // Same status but this copy is in a folder: prefer it, so we don't offer to add a duplicate.
      prev.inFolder = true;
    }
  };
  // First, everything already in the year folders (these are already counted by evaluate()).
  for (const y of degree.years || []) for (const c of y.courses || []) consider(c.code, c.status, c.grade, true, 'folder');
  // Then the extra app courses (current classes etc.), marked as NOT in a folder.
  for (const c of extraCourses || []) if (c && c.code) consider(c.code, c.status, c.grade, false, 'app');
  // Now match each required code against what the student has.
  const out = [];
  // Avoid listing the same code twice if two requirements both ask for it.
  const seen = new Set();
  for (const req of required) {
    const found = have.get(req.key);
    // The student hasn't taken this one → skip (it stays in "still need").
    if (!found) continue;
    if (seen.has(req.key)) continue;
    seen.add(req.key);
    out.push({ code: req.code, key: req.key, reqName: req.reqName, alt: req.alt, status: found.status, grade: found.grade, inFolder: found.inFolder, source: found.source });
  }
  return out;
}
