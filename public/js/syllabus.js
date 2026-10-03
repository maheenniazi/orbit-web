/*
 * syllabus.js — the Syllabus import page ("#/import") and the date-reading "parsers" behind it.
 *
 * How it fits in: app.js (the router) calls render(el) for "#/import". Other pages also import
 * parseQuick() from here (the dashboard and calendar quick-add boxes), plus classify(), etc.
 *
 * The flow: you drop a file (or paste text) -> the text is read (fileread.js handles PDF, Word,
 * images…) -> importSyllabus() turns it into events, either with AI (if an AI key/Kiro is
 * connected) or with the offline "local parser" below -> the events are saved to the calendar
 * and study sessions are auto-scheduled before each exam.
 *
 * The local parser works line by line using regular expressions ("regex"): patterns that
 * describe text, e.g. /\d{1,2}/ = "one or two digits". Quick regex vocabulary used here:
 *   \b word boundary · \d a digit · \s a space/tab · {1,2} "1 to 2 times" · ? "optional" ·
 *   (a|b) "a or b" · (?:...) a group that isn't captured · (...) a captured group we read later
 *   as m[1], m[2]… · ^ start · $ end · flags: i = ignore upper/lower case, g = find all matches.
 * Drag and drop: the drop zone listens for dragenter/dragover/dragleave/drop events.
 */
// Syllabus import: file/paste -> events (AI when available, local parser otherwise) -> calendar, automatically.
// Store helpers: add/remove events, create-or-find a course, course colour/details.
import { store, addEvents, ensureCourse, removeEvents, courseColor, getCourse } from './store.js';
// aiEnabled() = is an AI provider set up?; ask() sends a prompt to the server's AI endpoint and returns the reply text.
import { aiEnabled, ask } from './ai.js';
// Helpers: esc (HTML-safe text), date conversions, TYPE_META (event type labels), extractJSON
// (pulls JSON out of an AI reply), MONTHS (month names).
import { esc, toISO, todayISO, addDays, fmtDate, TYPE_META, extractJSON, fromISO, MONTHS } from './util.js';
// UI helpers: toast message, read uploaded files as text, OCR pasted screenshots, the list of
// accepted file types, and a "thinking…" spinner.
import { toast, readFilesText, enableImagePaste, ACCEPT, spinner } from './ui.js';
// Adds study sessions before exams.
import { syncStudyPlans } from './focus.js';

// ---------- Local (offline) parser ----------
// Month abbreviation -> month number as JavaScript counts them (January = 0 … December = 11).
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// RE_MONTH matches "Month Day[, Year]", e.g. "Oct 21", "October 21st", "Sept. 5, 2026":
//  group 1 = the month name, full or short (jan/january … sep/sept/september … dec/december),
//  then an optional "." and some space; group 2 = a 1–2 digit day, optionally followed by
//  st/nd/rd/th; group 3 (optional) = a 4-digit year, after an optional comma and space.
//  i flag = any capitalisation.
const RE_MONTH = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i;
// RE_DAY_MONTH matches the other order, "Day Month [Year]", e.g. "21 Oct", "3rd September 2026":
//  group 1 = day (with optional st/nd/rd/th), group 2 = month name, group 3 (optional) = year.
const RE_DAY_MONTH = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?(?:,?\s+(\d{4}))?/i;
// RE_ISO matches "2026-10-14" style dates: group 1 = a year starting with 20, group 2 = month, group 3 = day.
const RE_ISO = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/;
// RE_NUM matches slash dates in month/day order, e.g. "10/14", "10/14/26", "10/14/2026":
//  group 1 = month, group 2 = day, group 3 (optional) = a 2–4 digit year.
const RE_NUM = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
// RE_TIME matches a time with am/pm, e.g. "2pm", "10:30 am", "9 a.m.":
//  group 1 = hour, group 2 (optional) = minutes after a ":", then optional space, group 3 =
//  "am"/"pm" with optional dots; (?=\W|$) checks (without consuming) that what follows is not a
//  letter/digit, or is the end of the line — so "2 pmx" wouldn't count.
const RE_TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)/i;
// RE_WEEKDAY matches weekday names/abbreviations ("mon", "tue", "tues", "wed", "wednesday",
// "thu", "thur", "thurs", "fri", "sat", "saturday", "sun"…, each optionally followed by "day"),
// plus an optional "." and ",". g flag = every match (used to remove them all from titles).
const RE_WEEKDAY = /\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\b\.?,?/gi;
// RE_CODE matches a course code like "PSYC 210", "CS-1010" or "MAT135H": group 1 = 2–5 CAPITAL
// letters, an optional space or dash, group 2 = 3–4 digits plus an optional capital letter.
// (No i flag, so the letters must be uppercase.)
const RE_CODE = /\b([A-Z]{2,5})[\s-]?(\d{3,4}[A-Z]?)\b/;

/*
 * inferYear(month, day, explicitYear) — decides which year a date belongs to.
 * Inputs: month (0–11), day (1–31), explicitYear (a number if the text had a year, else undefined).
 * Returns: a 4-digit year number.
 */
function inferYear(month, day, explicitYear) {
  // If the text gave a year, use it; a 2-digit year like 26 becomes 2026.
  if (explicitYear) return explicitYear < 100 ? 2000 + explicitYear : explicitYear;
  // Otherwise start with the current year.
  const now = new Date();
  let y = now.getFullYear();
  // A syllabus usually spans ~4 months back to ~8 months ahead of today.
  // So if the date this year would be earlier than the 1st of the month 4 months ago, it must
  // mean next year (e.g. reading "Jan 10" in September -> next January).
  if (new Date(y, month, day) < new Date(now.getFullYear(), now.getMonth() - 4, 1)) y += 1;
  return y;
}

/*
 * findDate(line) — looks for a date anywhere in one line of text.
 * Input: line = a string. Returns: { iso: "YYYY-MM-DD", match: the exact text that matched }
 * (match is used later to cut the date out of the title), or null if no date was found.
 * The formats are tried in order: ISO, "Oct 21", "21 Oct", then "10/21".
 */
function findDate(line) {
  // m will hold the regex match result: an array where m[0] = the whole match, m[1] = group 1, …
  let m;
  // ISO date. `if ((m = ...))` assigns AND tests in one go (the extra brackets show it's on purpose).
  // +m[1] — the unary plus turns the text "2026" into the number 2026. Month - 1 because JS months start at 0.
  if ((m = line.match(RE_ISO))) return { iso: toISO(new Date(+m[1], +m[2] - 1, +m[3])), match: m[0] };
  // "Month Day [Year]".
  if ((m = line.match(RE_MONTH))) {
    // First 3 letters of the month name, lowercased, looked up in MON ("September" -> "sep" -> 8).
    const mo = MON[m[1].slice(0, 3).toLowerCase()];
    // The day as a number.
    const d = +m[2];
    // Sanity check the day, then build the date. `m[3] && +m[3]` = the year as a number if
    // there was one, otherwise undefined (so inferYear guesses).
    if (d >= 1 && d <= 31) return { iso: toISO(new Date(inferYear(mo, d, m[3] && +m[3]), mo, d)), match: m[0] };
  }
  // "Day Month [Year]" — same idea, but the day is group 1 and the month is group 2.
  if ((m = line.match(RE_DAY_MONTH))) {
    const mo = MON[m[2].slice(0, 3).toLowerCase()];
    const d = +m[1];
    if (d >= 1 && d <= 31) return { iso: toISO(new Date(inferYear(mo, d, m[3] && +m[3]), mo, d)), match: m[0] };
  }
  // "Month/Day[/Year]".
  if ((m = line.match(RE_NUM))) {
    // Month number minus 1 (JS months start at 0).
    const mo = +m[1] - 1;
    const d = +m[2];
    // Only accept real-looking months and days (so "3/4 of the grade" style text with a big number is skipped).
    if (mo >= 0 && mo < 12 && d >= 1 && d <= 31) return { iso: toISO(new Date(inferYear(mo, d, m[3] && +m[3]), mo, d)), match: m[0] };
  }
  // No date on this line.
  return null;
}

/*
 * findTime(line) — looks for an am/pm time in a line.
 * Input: line = a string. Returns: { time: "HH:MM" (24-hour), match: the matched text }, or null.
 */
function findTime(line) {
  // Try the time pattern.
  const m = line.match(RE_TIME);
  // None found.
  if (!m) return null;
  // Hour modulo 12, so "12am" becomes 0 and "12pm" becomes 0 before the next step.
  let h = +m[1] % 12;
  // If the am/pm part contains a "p" (pm), add 12: 2pm -> 14, 12pm -> 12.
  if (/p/i.test(m[3])) h += 12;
  // Build "HH:MM": pad the hour to 2 digits ("9" -> "09"); minutes default to "00".
  return { time: `${String(h).padStart(2, '0')}:${m[2] || '00'}`, match: m[0] };
}

/*
 * classify(text) — guesses the event type from keywords.
 * Input: text = an event line or title. Returns: a type key such as 'final', 'midterm', 'quiz',
 * 'assignment', 'reading', … (defaults to 'class'). The checks go from most to least important,
 * so "Midterm Exam" becomes 'midterm', not 'exam'.
 */
export function classify(text) {
  // Lowercase once so the patterns don't need to care about capitals.
  const t = text.toLowerCase();
  // The word "final" when it is NOT followed by project/paper/presentation/report/essay/draft
  // ((?!...) means "not followed by"), or the phrase "final exam" -> a final exam.
  if (/\bfinal\b(?!\s+(project|paper|presentation|report|essay|draft))|final exam/.test(t)) return 'final';
  // "midterm" or "mid-term" (the -? makes the dash optional).
  if (/mid-?term/.test(t)) return 'midterm';
  // The whole word "exam" or "test".
  if (/\bexam\b|\btest\b/.test(t)) return 'exam';
  // A word starting with "quiz" (quiz, quizzes).
  if (/\bquiz/.test(t)) return 'quiz';
  // Any of these words anywhere -> a project.
  if (/project|presentation|paper|essay|report|proposal/.test(t)) return 'project';
  // The whole word "lab".
  if (/\blab\b/.test(t)) return 'lab';
  // Homework words as whole words: hw, homework, assignment, problem set, pset, "ps 3"/"ps3",
  // due, submit, deliverable.
  if (/\b(hw|homework|assignment|problem set|pset|ps ?\d+|due|submit|deliverable)\b/.test(t)) return 'assignment';
  // "read" or "reading" as a word, "chapter", or "ch" + optional "." + optional space + a digit ("ch. 5", "ch5").
  if (/\bread(ing)?\b|chapter|\bch\.?\s?\d/.test(t)) return 'reading';
  // Days off: "no class", holiday, break, recess, cancel(led).
  if (/no class|holiday|break|recess|cancel/.test(t)) return 'other';
  // Anything else on a dated line is probably a normal lecture.
  return 'class';
}

/*
 * cleanTitle(line, strip) — turns a raw syllabus line into a tidy event title.
 * Inputs: line = the text; strip = a list of exact bits to remove first (the matched date and
 * time text; entries may be undefined). Returns: the cleaned, capitalised title (may be '').
 */
function cleanTitle(line, strip) {
  // Work on a copy we can keep replacing.
  let t = line;
  // Replace each strip text (if present) with a space, e.g. remove "Oct 21" and "10:30am".
  for (const s of strip) if (s) t = t.replace(s, ' ');
  // A chain of .replace() calls, each cleaning one thing:
  t = t
    // remove every weekday name ("Tue", "Thursday,"…);
    .replace(RE_WEEKDAY, ' ')
    // remove the first "week 3" / "week3";
    .replace(/\bweek\s*\d+\b/i, ' ')
    // at the very start, remove a schedule label: "final week"/"finals week", "finals",
    // "wk 3"/"wk.3", "session 4" or "day 2";
    .replace(/^\s*(finals?\s+week|finals|wk\.?\s*\d+|session\s*\d+|day\s*\d+)\b/i, ' ')
    // turn runs of table separators (pipes |, tabs, bullets •, middle dots ·) into a space;
    .replace(/[|\t•·]+/g, ' ')
    // squash 2+ spaces into one;
    .replace(/\s{2,}/g, ' ')
    // remove spaces before punctuation: "Quiz 1 :" -> "Quiz 1:" ($1 puts the punctuation back);
    .replace(/\s+([,.;:)])/g, '$1')
    // remove a dangling "at", "by", "on" or "@" left at the end once the date/time was cut out
    // (e.g. "Essay due by" -> "Essay due");
    .replace(/[\s,]*\b(at|by|on|@)\s*$/i, '')
    // strip leftover spaces, colons, commas, dashes (- – —) and brackets from the start, and the
    // same (except a closing ")") from the end;
    .replace(/^[\s:,\-–—()]+|[\s:,\-–—(]+$/g, '')
    // and trim spaces off both ends.
    .trim();
  // Very long titles get cut to 87 characters plus "…".
  if (t.length > 90) t = t.slice(0, 87).trimEnd() + '…';
  // Capitalise the first letter.
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Table rows from Word/Excel/PDF look like "5 | Oct 21 | Midterm Exam | 25%".
// Drop cells that are just a week number, lecture number or grade weight so they don't end up in the title.
/*
 * tableAware(line) — Input: one line. Returns: the line with "junk" table cells removed (cells
 * joined by two spaces), or the line unchanged if it has no "|".
 */
function tableAware(line) {
  // Not a table row? Leave it alone.
  if (!line.includes('|')) return line;
  return line
    // Split into cells at each "|"…
    .split('|')
    // …trim each cell…
    .map((c) => c.trim())
    // …keep only non-empty cells that are NOT just a number. The regex matches a whole cell that
    // is: an optional label word (week/wk/lecture/lec/class/session/unit/module), optional
    // space, an optional "#", a 1–3 digit number with an optional decimal part, and an optional
    // "%" — e.g. "5", "Week 3", "#2", "25%", "12.5%".
    .filter((c) => c && !/^(week|wk|lecture|lec|class|session|unit|module)?\s*#?\d{1,3}(\.\d+)?\s*%?$/i.test(c))
    // …and glue the rest back together.
    .join('  ');
}

/*
 * detectCourse(text) — guesses the course code and name from the top of a syllabus.
 * Input: the full syllabus text. Returns: { code: 'PSYC 210' or '', name: '...' }.
 */
export function detectCourse(text) {
  // Only look at the first 25 lines (the course title is near the top).
  const head = text.split('\n').slice(0, 25);
  for (const line of head) {
    // Look for a course code like "PSYC 210".
    const m = line.match(RE_CODE);
    // Ignore look-alikes such as "ROOM 101", "PAGE 2…" or "UNIT 300".
    if (m && !/^(ROOM|PAGE|UNIT)$/.test(m[1])) {
      // Normalise to "LETTERS NUMBER" with one space.
      const code = `${m[1]} ${m[2]}`;
      // The rest of the line is probably the course name: remove the code, then strip spaces,
      // colons, dashes and pipes from both ends ("PSYC 210 – Cognitive Psychology" -> "Cognitive Psychology").
      const name = line.replace(m[0], '').replace(/^[\s:–—\-|]+|[\s:–—\-|]+$/g, '').trim();
      // Use that name if it's a sensible length; otherwise just use the code as the name.
      return { code, name: name && name.length < 70 ? name : code };
    }
  }
  // No code found: use the first line with more than 3 characters (cut to 60) as the name.
  const first = head.find((l) => l.trim().length > 3);
  return { code: '', name: first ? first.trim().slice(0, 60) : '' };
}

/*
 * parseLocal(text) — the offline parser: turns every line that contains a date into an event.
 * Input: the syllabus text. Returns: { course: {code, name}, events: [{title, type, date, time, notes}] }.
 */
export function parseLocal(text) {
  // The events found so far.
  const events = [];
  // A Set of "date|title" keys we've already added, so duplicates are skipped.
  const seen = new Set();
  // Split into lines; /\r?\n/ matches a line break, with or without a Windows "\r" before it.
  for (const raw of text.split(/\r?\n/)) {
    // Trim spaces.
    const line = raw.trim();
    // Skip blank lines and very long ones (paragraphs of policy text, not schedule rows).
    if (!line || line.length > 300) continue;
    // Find a date; lines without one are skipped (`continue` jumps to the next line).
    const d = findDate(line);
    if (!d) continue;
    // Find a time (may be null).
    const tm = findTime(line);
    // Guess the type from keywords.
    const type = classify(line);
    // Skip generic metadata lines (office hours, "last updated", etc.)
    if (/office hours|updated|revised|copyright|printed/i.test(line)) continue;
    // Build the title: drop junk table cells, remove the date and time text, tidy up. If nothing
    // is left, use the type's label (e.g. "Quiz"). tm?.match = undefined when there's no time.
    const title = cleanTitle(tableAware(line), [d.match, tm?.match]) || TYPE_META[type].label;
    // A key like "2026-10-21|midterm exam" for duplicate checking.
    const key = `${d.iso}|${title.toLowerCase()}`;
    // Already have it? Skip. Otherwise remember it.
    if (seen.has(key)) continue;
    seen.add(key);
    // Add the event (time '' = all day).
    events.push({ title, type, date: d.iso, time: tm?.time || '', notes: '' });
  }
  // Return the guessed course together with the events.
  return { course: detectCourse(text), events };
}

// Quick-add parser: "chem quiz fri 3pm", "essay due tomorrow", "bio midterm oct 14"
/*
 * parseQuick(input) — turns one short typed phrase into an event.
 * Input: the typed text. Returns: { title, date, time, type, courseId } (date defaults to today,
 * courseId is null if no course name/code was mentioned).
 */
export function parseQuick(input) {
  // The text we'll keep cutting pieces out of until only the title is left.
  let text = input.trim();
  // The date we find (null until found).
  let iso = null;
  // Weekday abbreviation -> JS weekday number (Sunday = 0).
  const dayIdx = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  // A lowercase copy for matching.
  const lower = text.toLowerCase();
  // Holds regex match results.
  let m;
  // "today" as a whole word -> today's date; remove the word from the title.
  if (/\btoday\b/.test(lower)) { iso = todayISO(); text = text.replace(/\btoday\b/i, ''); }
  // "tomorrow" or "tmr" -> tomorrow; remove it.
  else if (/\btomorrow\b|\btmr\b/.test(lower)) { iso = addDays(todayISO(), 1); text = text.replace(/\btomorrow\b|\btmr\b/i, ''); }
  // A weekday: optional "next " (group 1) then a weekday name, short or long (group 2):
  // sun/sunday, mon/monday, tue/tues/tuesday, wed/wednesday, thu/thurs/thursday, fri/friday, sat/saturday.
  else if ((m = lower.match(/\b(next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/))) {
    // The target weekday number, from the first 3 letters ("friday" -> "fri" -> 5).
    const target = dayIdx[m[2].slice(0, 3)];
    // Today's weekday number.
    const now = fromISO(todayISO()).getDay();
    // Days until the next such weekday: (target - now + 7) % 7 gives 0–6 (the +7 avoids
    // negatives); if that's 0 (it's that weekday today), `|| 7` means "a week from today".
    let diff = (target - now + 7) % 7 || 7;
    // "next fri": push it one more week, unless it's already a full week away.
    if (m[1]) diff += diff < 7 ? 7 : 0;
    // The resulting date.
    iso = addDays(todayISO(), diff);
    // Remove the matched words from the title. new RegExp(text, 'i') builds a regex from the
    // matched text, case-insensitive, because `text` keeps the user's original capitals.
    text = text.replace(new RegExp(m[0], 'i'), '');
  } else {
    // Otherwise try the full date formats ("oct 14", "10/14"…); remove the date if found.
    const d = findDate(text);
    if (d) { iso = d.iso; text = text.replace(d.match, ''); }
  }
  // Look for a time ("3pm") and cut it out too.
  const tm = findTime(text);
  if (tm) text = text.replace(tm.match, '');
  // Remove a dangling "at", "on" or "due by" at the end, squash double spaces, trim.
  text = text.replace(/\b(at|on|due by)\b\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
  // Match a course by code or name mention
  // .find returns the first course for which the test is true:
  //  - [c.code, c.name].filter(Boolean) = the course's code and name, skipping empty ones;
  //  - .some(k => …) = true if either one matches;
  //  - match if the typed text contains the full code/name, OR if the first word of it (at least
  //    3 characters, e.g. "chem" from "Chemistry 101"… or "psyc" from "PSYC 210") appears as a
  //    whole word. The regex is built from a template literal: "\\b" in the string becomes \b
  //    (word boundary) in the pattern, and first.replace(/[^a-z0-9]/g, '') strips anything
  //    that isn't a letter or digit so it can't break the pattern.
  const course = store.get().courses.find((c) =>
    [c.code, c.name].filter(Boolean).some((k) => {
      const first = k.toLowerCase().split(' ')[0];
      return lower.includes(k.toLowerCase()) || (first.length >= 3 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, '')}\\b`).test(lower));
    })
  );
  // Build the event: the leftover text capitalised as the title (if nothing is left, the
  // expression is '' which is "falsy", so `|| 'Untitled'` kicks in); the found date or today;
  // the time or ''; the type guessed from the ORIGINAL input; the course id or null.
  return { title: text.charAt(0).toUpperCase() + text.slice(1) || 'Untitled', date: iso || todayISO(), time: tm?.time || '', type: classify(input), courseId: course?.id || null };
}

// ---------- AI parser ----------
/*
 * parseAI(text) — asks the AI to read the syllabus and return events as JSON.
 * Input: the syllabus text. Returns (as a Promise, since it's async): { course, events } in the
 * same shape as parseLocal. Throws an error if the AI call or JSON reading fails.
 */
async function parseAI(text) {
  // The "system" instructions for the AI (a multi-line template literal). It says: you extract
  // calendar events from syllabi; today's date; reply ONLY with JSON shaped like
  // {"course":{…},"events":[{title, type, date "YYYY-MM-DD", time "HH:MM" or empty, notes}]};
  // and rules: include every dated item, lecture rows are type "class", infer the year from
  // the term, keep titles short, never invent dates, skip weekly items with no dates.
  const system = `You extract calendar events from university course syllabi. Today is ${todayISO()}.
Return ONLY valid JSON (no prose) shaped like:
{"course":{"name":"","code":""},"events":[{"title":"","type":"final|midterm|exam|quiz|assignment|project|reading|lab|class|other","date":"YYYY-MM-DD","time":"HH:MM or empty","notes":"short detail e.g. weight, chapters, location"}]}
Rules:
- Include every dated exam, quiz, assignment, project milestone, reading, lab, and no-class/holiday day.
- For lecture schedule rows, use type "class" with the topic as the title.
- Infer the year from the term (e.g. "Fall 2026"); if absent, pick the year that places the date within the upcoming academic term.
- Titles should be concise (e.g. "Problem Set 3", "Midterm 1"). Never invent dates that aren't in the text.
- Weekly recurring items without explicit dates should be omitted.`;
  // Send it (only the first 60,000 characters of the syllabus, to stay within limits; allow a
  // reply of up to 8000 tokens). `await` waits for the AI's answer.
  const reply = await ask({ system, messages: [{ role: 'user', content: text.slice(0, 60000) }], maxTokens: 8000 });
  // Pull the JSON object out of the reply (AIs sometimes wrap it in ``` fences or extra words).
  const data = extractJSON(reply);
  // Clean up the AI's events (never trust its output blindly):
  const events = (data.events || [])
    // keep only events whose date is exactly "YYYY-MM-DD" (4 digits, dash, 2 digits, dash, 2 digits, nothing else);
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    // and rebuild each one: title as text (max 120 chars, 'Untitled' if missing); type only if
    // it's one we know (TYPE_META has it), otherwise our own classify() guess; the date; the
    // time only if it's exactly "HH:MM"; notes or ''.
    .map((e) => ({ title: String(e.title || 'Untitled').slice(0, 120), type: TYPE_META[e.type] ? e.type : classify(e.title || ''), date: e.date, time: /^\d{2}:\d{2}$/.test(e.time || '') ? e.time : '', notes: e.notes || '' }));
  // The AI's course guess, or our own if it didn't give one.
  return { course: data.course || detectCourse(text), events };
}

// ---------- Import pipeline ----------
/*
 * importSyllabus(text, options) — parses a syllabus and saves its events to the calendar.
 * Inputs: text = syllabus text; options = { courseName, courseCode, useAI } (destructured right
 *         in the parameter list, so they become plain variables).
 * Returns (Promise): { ids: new event ids, courseId, method: 'ai' | 'local',
 *          planned: number of study sessions added, events: the saved new events }.
 */
export async function importSyllabus(text, { courseName, courseCode, useAI }) {
  // Will hold { course, events }.
  let parsed;
  // Which parser was used (for the results message).
  let method = 'local';
  // Use AI only if the box was ticked AND AI is actually available.
  if (useAI && aiEnabled()) {
    // try/catch: if anything inside `try` throws an error, jump to `catch` instead of crashing.
    try {
      parsed = await parseAI(text);
      method = 'ai';
    } catch (e) {
      // Tell the user, then fall through to the offline parser below.
      toast(`AI parsing failed (${e.message}), used the offline parser instead`);
    }
  }
  // No AI result (not used, or failed)? Use the local parser.
  if (!parsed) parsed = parseLocal(text);
  // Find or create the course. Priority: what you typed in the form, then what was detected,
  // then a generic 'My course'. parsed.course?.name uses optional chaining in case course is missing.
  const courseId = ensureCourse(courseName || parsed.course?.name || 'My course', courseCode || parsed.course?.code || '');
  // Keys ("courseId|date|title") of events already in the calendar, so re-importing the same
  // syllabus doesn't create duplicates.
  const existing = new Set(store.get().events.map((e) => `${e.courseId}|${e.date}|${e.title.toLowerCase()}`));
  // The new events: add the course id and source to each (spread copies the rest), then drop any already in the calendar.
  const fresh = parsed.events
    .map((e) => ({ ...e, courseId, source: 'syllabus' }))
    .filter((e) => !existing.has(`${courseId}|${e.date}|${e.title.toLowerCase()}`));
  // Save them; addEvents returns their new ids.
  const ids = addEvents(fresh);
  // Schedule study sessions before any new exams (quietly); returns how many were added.
  const planned = syncStudyPlans({ silent: true });
  // Report back, including the saved event objects (looked up by id).
  return { ids, courseId, method, planned, events: store.get().events.filter((e) => ids.includes(e.id)) };
}

/*
 * sampleSyllabus() — makes a fake syllabus to try the importer with.
 * Inputs: none. Returns: a multi-line string whose dates are relative to today, so the demo
 * always shows upcoming deadlines.
 */
export function sampleSyllabus() {
  // Today's date.
  const t = todayISO();
  // f(n) — the date n days from today written like "Oct 17" (first 3 letters of the month + day number).
  const f = (n) => { const d = fromISO(addDays(t, n)); return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`; };
  // The sample text: a PSYC 210 heading, the current year's term, a grading line, then a
  // schedule of weekly rows — lectures, problem sets, quizzes, a midterm, a break, a project and
  // a final exam — each dated with f(days from today). The spacing inside is part of the sample.
  return `PSYC 210 – Cognitive Psychology
Fall ${fromISO(t).getFullYear()} · Prof. Rivera · Tue/Thu 10:30am

Grading: Quizzes 15%, Problem sets 25%, Midterm 25%, Final 35%

Schedule
Week 1  ${f(-3)}  Intro: what is cognition?
Week 1  ${f(1)}   Perception & attention (read Ch. 2)
Week 2  ${f(2)}   Problem Set 1 due 11:59pm
Week 2  ${f(4)}   Quiz 1: Perception
Week 3  ${f(6)}   Memory systems (read Ch. 5-6)
Week 3  ${f(9)}   Midterm Exam 10:30am (Ch. 1-6)
Week 4  ${f(13)}  No class - Fall break
Week 5  ${f(16)}  Problem Set 2 due
Week 6  ${f(20)}  Final project proposal due
Week 7  ${f(24)}  Quiz 2: Language
Week 9  ${f(32)}  Final project presentations
Finals  ${f(38)}  Final Exam 9:00am, Hall B`;
}

// ---------- View ----------
/*
 * render(el) — draws the Syllabus import page. Called by the router in app.js.
 * Input: el = the element to draw into. Returns: nothing (this page needs no cleanup).
 */
export function render(el) {
  // Is AI available? Decides whether the "Smart AI parsing" box can be ticked.
  const ai = aiEnabled();
  // The page HTML:
  //  1. a header: "syllabus import", the big title and a one-line explanation;
  //  2. the left card: a drop zone (#drop) — it's a <label> wrapping a hidden file input (#file,
  //     accepting the ACCEPT file types, several files allowed), so clicking it opens the file
  //     picker; a "try a sample syllabus" button (#sample); a big textarea (#text) to paste into;
  //     optional Course name (#cname) and Code (#ccode) boxes; the "Smart AI parsing" tick box
  //     (#useai: ticked if AI is available, otherwise disabled and faded with a hint how to
  //     enable it); and the "import to calendar" button (#go);
  //  3. the right card (#result): where imported events will be listed (a "waiting…" placeholder for now).
  el.innerHTML = `
    <div class="page-head view-enter">
      <div><div class="kicker">syllabus import</div><h1>drop in your <em>syllabus</em></h1><p>every exam, deadline and reading lands on your calendar automatically, plus study sessions before each exam.</p></div>
    </div>
    <div class="grid dash view-enter">
      <div class="stack">
        <div class="card">
          <label class="drop" id="drop">
            <input type="file" id="file" accept="${ACCEPT}" multiple hidden>
            <div class="big">drop it here.</div><b>your syllabus, in any format</b><span class="muted small">pdf, word, powerpoint, excel, photos or screenshots · several pages at once is fine</span>
          </label>
          <div class="row" style="margin:14px 0 8px"><span class="hand">…or paste it (screenshots too)</span><span style="flex:1"></span><button class="btn ghost sm" id="sample">try a sample syllabus</button></div>
          <textarea id="text" placeholder="Paste syllabus text here" style="min-height:200px"></textarea>
          <div class="row" style="margin-top:12px">
            <label class="field">Course name (optional)<input id="cname" placeholder="Auto-detected"></label>
            <label class="field" style="max-width:160px">Code<input id="ccode" placeholder="e.g. CHEM 101"></label>
          </div>
          <div class="row spread" style="margin-top:14px">
            <label class="check small ${ai ? '' : 'faint'}"><input type="checkbox" id="useai" ${ai ? 'checked' : 'disabled'}> Smart AI parsing ${ai ? '' : '(connect Kiro or an AI key to enable)'}</label>
            <button class="btn" id="go">import to calendar</button>
          </div>
        </div>
      </div>
      <div class="card" id="result"><h3>imported</h3><div class="empty"><span class="big">waiting…</span>your deadlines will land here</div></div>
    </div>`;

  // Shortcut: $('#go') = el.querySelector('#go').
  const $ = (s) => el.querySelector(s);
  // The drop zone element.
  const drop = $('#drop');
  // status(m) — shows a progress message (like "reading…") as the textarea's grey placeholder, emptying the box first.
  const status = (m) => { $('#text').value = ''; $('#text').placeholder = m; };
  // loadFiles(files) — reads chosen/dropped files into the textarea. async because reading takes time.
  const loadFiles = async (files) => {
    // No files (e.g. picker cancelled)? Stop. files?.length is undefined if files is missing.
    if (!files?.length) return;
    // The textarea.
    const ta = $('#text');
    // Lock it while reading, and show "reading…".
    ta.disabled = true;
    status('reading…');
    try {
      // Read all files as one text; progress messages go to status().
      const text = await readFilesText(files, { onProgress: status });
      // Nothing readable? Throw an error so the catch below shows it.
      if (!text.trim()) throw new Error('No text found in that file.');
      // Put the text in the box for you to check before importing.
      ta.value = text;
      // Confirm: "read 3 files" or "loaded syllabus.pdf".
      toast(files.length > 1 ? `read ${files.length} files` : `loaded ${files[0].name}`);
    } catch (e) {
      // On failure: empty the box and show the error for 8 seconds.
      ta.value = '';
      toast(e.message, { timeout: 8000 });
    } finally {
      // `finally` always runs (success or error): unlock the box and restore its normal placeholder.
      ta.disabled = false;
      ta.placeholder = 'Paste syllabus text here';
    }
  };
  // Files picked with the file picker -> read them.
  $('#file').onchange = (e) => loadFiles(e.target.files);
  // Let you paste a screenshot into the textarea: it gets read with OCR (text recognition).
  // Progress shows in the placeholder; success/failure show as toasts.
  enableImagePaste($('#text'), { onProgress: (m) => ($('#text').placeholder = m), onDone: () => toast('read your screenshot'), onError: (e) => toast(e.message) });
  // Drag and drop. While a file is dragged into/over the zone: preventDefault() allows dropping
  // (and stops the browser from opening the file), and the "over" class highlights the zone.
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  // When it leaves or is dropped: remove the highlight.
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  // On drop: read the dropped files (e.dataTransfer.files).
  drop.addEventListener('drop', (e) => loadFiles(e.dataTransfer.files));
  // "try a sample syllabus" fills the box with the fake syllabus.
  $('#sample').onclick = () => ($('#text').value = sampleSyllabus());

  // "import to calendar" button.
  $('#go').onclick = async () => {
    // The syllabus text.
    const text = $('#text').value.trim();
    // Empty? Ask for one and stop.
    if (!text) return toast('Add a syllabus first');
    // Disable the button so it can't be clicked twice while working.
    const btn = $('#go');
    btn.disabled = true;
    // Show a spinner in the results card, with a message depending on whether AI is being used.
    $('#result').innerHTML = `<h3>Imported</h3>${spinner($('#useai').checked ? 'Reading your syllabus with AI…' : 'Parsing dates…')}`;
    try {
      // Run the import with the form's options.
      const res = await importSyllabus(text, { courseName: $('#cname').value.trim(), courseCode: $('#ccode').value.trim(), useAI: $('#useai').checked });
      // List what was imported.
      showResult(res);
      // Toast "added N events + M study sessions" with an "undo" button (shown for 9 seconds)
      // that deletes the new events and says "Import undone.".
      toast(`added ${res.ids.length} events${res.planned ? ` + ${res.planned} study sessions` : ''}`, {
        action: 'undo',
        onAction: () => { removeEvents(res.ids); $('#result').innerHTML = '<h3>Imported</h3><div class="empty">Import undone.</div>'; },
        timeout: 9000,
      });
    } catch (e) {
      // Show the error in the results card (escaped so it's safe HTML).
      $('#result').innerHTML = `<h3>Imported</h3><div class="empty">Something went wrong: ${esc(e.message)}</div>`;
    } finally {
      // Re-enable the button either way.
      btn.disabled = false;
    }
  };

  /*
   * showResult(res) — lists the imported events in the results card, each with a ✕ to remove it.
   * Input: res = the object returned by importSyllabus. Returns: nothing.
   * (A function declared inside render, so it can use el and $ — a closure.)
   */
  function showResult(res) {
    // The course and its colour.
    const course = getCourse(res.courseId);
    const color = courseColor(res.courseId);
    // A sorted copy of the events (spread copies the array so we don't reorder the original).
    const evs = [...res.events].sort((a, b) => a.date.localeCompare(b.date));
    // The results HTML: a heading with a coloured course tag; a line "N events via AI/offline
    // parser · M study sessions auto-scheduled. remove anything that looks off."; then either
    // the list of events (each row: coloured bar, title, a sub-line with type label, time and
    // notes, the date, and a ✕ button with data-rm = event id) followed by an "Open calendar →"
    // button — or, if nothing new was found, a hint about scanned PDFs.
    $('#result').innerHTML = `
      <h3>imported <span class="tag" style="--c:${color}">${esc(course?.code || course?.name || '')}</span></h3>
      <p class="small muted" style="margin-top:-6px">${evs.length} events via ${res.method === 'ai' ? 'AI' : 'offline parser'}${res.planned ? ` · ${res.planned} study sessions auto-scheduled` : ''}. remove anything that looks off.</p>
      ${evs.length ? `<div class="ev-list">${evs.map((e) => `
        <div class="ev result-item" style="--c:${color};grid-template-columns:4px 1fr auto auto" data-id="${e.id}">
          <span class="bar"></span>
          <div><div class="t">${esc(e.title)}</div><div class="s">${TYPE_META[e.type]?.label}${e.time ? ' · ' + e.time : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div>
          <span class="when">${fmtDate(e.date)}</span>
          <button class="icon-btn" data-rm="${e.id}" title="Remove">✕</button>
        </div>`).join('')}</div>
        <div class="row" style="margin-top:14px"><a class="btn" href="#/calendar">Open calendar →</a></div>`
      : '<div class="empty">No new dated items found. If this is a scanned PDF, paste the text instead.</div>'}`;
    // Each ✕ button: delete that event from the store and remove its row from the list.
    el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { removeEvents([b.dataset.rm]); b.closest('.ev').remove(); }));
  }
}
