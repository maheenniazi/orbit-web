/*
 * util.js — small shared helper functions used everywhere in the browser code.
 *
 * Contents:
 *   - Date helpers. The app stores dates as "ISO date strings" like "2025-09-14" (year-month-day).
 *     These are easy to sort and compare, and avoid time-zone surprises. Helpers convert between
 *     those strings and JavaScript Date objects, add days, count days between dates, and format them.
 *   - esc(): makes text safe to put inside HTML.
 *   - uid(): makes short random ids for courses, events, notes, etc.
 *   - Event type lists/labels (exam, quiz, assignment…).
 *   - md(): a tiny Markdown-to-HTML converter (for showing AI answers and notes nicely).
 *   - extractJSON(): digs a JSON object out of an AI reply.
 *
 * Beginner terms:
 *   - `export const name = (x) => ...` creates an arrow function (a short function) and exports it
 *     so other files can `import` it.
 *   - Template literal: a backtick string where ${...} inserts a value.
 *   - Regex (regular expression): a pattern for matching text, written between slashes like /abc/g.
 *     The letters after the last slash are flags: g = find all matches, i = ignore upper/lower case.
 */
// Shared helpers: dates, escaping, markdown.
// The app's display name, used in titles etc.
export const APP_NAME = 'orbit'; // rename here

// pad(n): turn a number into a 2-character string with a leading zero if needed (5 -> "05", 12 -> "12").
export const pad = (n) => String(n).padStart(2, '0');
// toISO(d): turn a Date into "YYYY-MM-DD" using local time.
// getMonth() counts from 0 (January = 0), so we add 1.
export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// todayISO(): today's date as "YYYY-MM-DD".
export const todayISO = () => toISO(new Date());
// fromISO(s): turn "YYYY-MM-DD" back into a Date (at local midnight).
export const fromISO = (s) => {
  // Split "2025-09-14" into ["2025","09","14"], convert each to a number,
  // and destructure into y, m, d (array destructuring assigns items in order).
  const [y, m, d] = s.split('-').map(Number);
  // new Date(year, monthIndex, day) — month index is 0-based, so subtract 1.
  return new Date(y, m - 1, d);
};
// addDays(iso, n): the date n days after iso (n can be negative), as "YYYY-MM-DD".
export const addDays = (iso, n) => {
  // Convert to a Date we can do math on.
  const d = fromISO(iso);
  // setDate handles rolling over months/years automatically (e.g. Jan 31 + 1 -> Feb 1).
  d.setDate(d.getDate() + n);
  // Convert back to a string.
  return toISO(d);
};
// daysBetween(a, b): whole days from date a to date b (positive if b is later).
// Subtracting two Dates gives milliseconds; 86400000 ms = 1 day. Math.round smooths daylight-saving hour shifts.
export const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);
// daysUntil(iso): days from today to iso (0 = today, 1 = tomorrow, -1 = yesterday).
export const daysUntil = (iso) => daysBetween(todayISO(), iso);

// Month names, index 0 = January (matches Date.getMonth()).
export const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
// Short weekday names, index 0 = Sunday (matches Date.getDay()).
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/*
 * fmtDate(iso, opts) — format a date for people to read, e.g. "Sun, Sep 14".
 * Inputs: iso date string; opts = formatting options (default: short weekday, short month, day number).
 * Returns: the formatted string.
 */
export function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  // toLocaleDateString formats using the browser's language; `undefined` means "use the user's default locale".
  return fromISO(iso).toLocaleDateString(undefined, opts);
}
/*
 * fmtTime(t) — turn a 24-hour "HH:MM" string into a friendly 12-hour time.
 * Input: e.g. "14:05", "09:00" or empty. Returns: e.g. "2:05pm", "9am", or '' if no time.
 */
export function fmtTime(t) {
  // No time given -> nothing to show.
  if (!t) return '';
  // Split "14:05" into hours and minutes as numbers.
  const [h, m] = t.split(':').map(Number);
  // 12:00 and later is pm, before that am.
  const ampm = h >= 12 ? 'pm' : 'am';
  // ((h + 11) % 12) + 1 converts 0..23 into 1..12 (0 -> 12, 13 -> 1, 12 -> 12).
  // `%` is the remainder operator. Minutes are only shown if not zero (":05"); then am/pm is added.
  return `${((h + 11) % 12) + 1}${m ? ':' + pad(m) : ''}${ampm}`;
}
/*
 * relDay(iso) — describe a date relative to today.
 * Input: iso date string. Returns: "Today", "Tomorrow", "Yesterday", "In 3 days", "4 days ago",
 * or a normal formatted date if it's a week or more away.
 */
export function relDay(iso) {
  // How many days away the date is.
  const n = daysUntil(iso);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  // 2–6 days in the future.
  if (n > 1 && n < 7) return `In ${n} days`;
  // Any past date (more than 1 day ago); -n makes it positive.
  if (n < 0) return `${-n} days ago`;
  // 7+ days away: show the actual date.
  return fmtDate(iso);
}

/*
 * esc(s) — HTML-escape text so it displays as text and can't inject HTML/scripts (XSS protection).
 * Input: any value (default ''). Returns: a string with & < > " ' replaced by HTML entities.
 * The regex /[&<>"']/g matches any one of those five characters, everywhere (g).
 * For each match c, the arrow function looks up its replacement in a small object, e.g. '<' -> '&lt;'.
 */
export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// uid(): a short, practically-unique id.
// Math.random().toString(36) gives something like "0.k3j9x2a..." in base 36 (digits + letters);
// .slice(2, 9) skips "0." and keeps 7 random characters. Then we add the last 4 characters of the
// current time in base 36, so ids made at different moments differ even more.
export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

// Event types that count as exams (used e.g. to trigger exam prep).
export const EXAM_TYPES = ['exam', 'midterm', 'final'];
// Display labels for each event type. Keys are the stored type names; `other` shows as "Event".
export const TYPE_META = {
  final: { label: 'Final' },
  midterm: { label: 'Midterm' },
  exam: { label: 'Exam' },
  quiz: { label: 'Quiz' },
  assignment: { label: 'Assignment' },
  project: { label: 'Project' },
  reading: { label: 'Reading' },
  lab: { label: 'Lab' },
  study: { label: 'Study' },
  class: { label: 'Class' },
  other: { label: 'Event' },
};

// Minimal, safe markdown renderer (escape first, then format).
/*
 * md(src) — convert a small subset of Markdown into HTML.
 * Input: Markdown text. Returns: an HTML string.
 * Supported: headings (#), bullet lists, checkbox lists, numbered lists, > quotes, --- lines,
 * ``` code blocks ```, `inline code`, **bold**, *italic*, ==highlight==, and paragraphs.
 * Safety: all text is escaped FIRST, so any HTML the AI writes is shown as text, not run.
 * Because of that, a ">" in the input has already become "&gt;" by the time we look at lines.
 */
export function md(src = '') {
  // Escape the whole text, then split it into lines to process one by one.
  const lines = esc(src).split('\n');
  // The HTML we build up.
  let html = '';
  // Which list we're currently inside: 'ul' (bullets), 'ol' (numbers), or null (not in a list).
  let list = null;
  // Are we currently inside a ``` code block?
  let inCode = false;
  // inline(s): apply formatting that can appear inside a line. Each .replace() handles one style:
  //   1. /`([^`]+)`/g          — a backtick, then one or more non-backtick chars (captured as $1), then a backtick -> <code>
  //   2. /\*\*([^*]+)\*\*/g    — two asterisks, text without asterisks ($1), two asterisks -> <strong> (bold)
  //   3. /(^|[^*])\*([^*]+)\*/g — start of text or a non-asterisk char ($1, put back unchanged), then *text* ($2) -> <em> (italic).
  //                               Requiring a non-* before it avoids grabbing pieces of ** bold markers.
  //   4. /==([^=]+)==/g        — ==text== -> <mark> (highlighted)
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  // closeList(): if a list is open, add its closing tag (</ul> or </ol>) and mark that we're out of it.
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  // Go through every line.
  for (const raw of lines) {
    // Remove trailing whitespace. /\s+$/ = one or more whitespace characters at the very end.
    const line = raw.replace(/\s+$/, '');
    // A line starting with ``` opens or closes a code block.
    if (line.startsWith('```')) {
      // Code blocks can't be inside lists, so end any list first.
      closeList();
      // If we were in code, close it; otherwise open <pre><code>.
      html += inCode ? '</code></pre>' : '<pre><code>';
      // Flip the in-code flag (true <-> false).
      inCode = !inCode;
      // Skip the rest of the checks for this line.
      continue;
    }
    // Inside a code block: copy the line as-is (no formatting) and move on.
    if (inCode) { html += line + '\n'; continue; }
    // m will hold the result of whichever regex matches below.
    let m;
    // Heading: /^(#{1,4})\s+(.*)/ = at line start, 1 to 4 '#' characters ($1), spaces, then the heading text ($2).
    // Number of #'s + 1 gives the tag: # -> <h2>, ## -> <h3>, … (h1 is kept for page titles).
    // `(m = ...)` assigns and tests in one go; the extra parentheses show it's on purpose.
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { closeList(); html += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`; }
    // Checkbox item: optional spaces, '-' or '*', spaces, then "[ ]" or "[x]" ($1 is ' ' or 'x'), spaces, text ($2).
    // The i flag means "[X]" also works.
    else if ((m = line.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)/i))) {
      // Start a checklist <ul> if we aren't in a bullet list already.
      if (list !== 'ul') { closeList(); html += '<ul class="checks">'; list = 'ul'; }
      // Add a read-only checkbox, ticked if the box had an x.
      html += `<li><input type="checkbox" disabled ${m[1].toLowerCase() === 'x' ? 'checked' : ''}> ${inline(m[2])}</li>`;
    }
    // Bullet item: optional spaces, then '-', '*' or '•', spaces, then the text ($1).
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
      // Open a <ul> if needed.
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1])}</li>`;
    // Numbered item: optional spaces, one or more digits, then '.' or ')', spaces, then the text ($1). E.g. "1. " or "2) ".
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      // Open an <ol> (ordered list) if needed.
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
    // Quote: line starts with "&gt;" (an escaped ">"), an optional space, then the text ($1).
    } else if ((m = line.match(/^&gt;\s?(.*)/))) { closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`; }
    // Horizontal rule: the whole line is three or more dashes.
    else if (/^---+$/.test(line)) { closeList(); html += '<hr>'; }
    // Blank line: just ends any list (separates paragraphs).
    else if (!line.trim()) { closeList(); }
    // Anything else is a normal paragraph.
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  // End of text: close any list still open.
  closeList();
  // If a code block was never closed, close it so the HTML is valid.
  if (inCode) html += '</code></pre>';
  return html;
}

// Pull the first JSON object/array out of an LLM response.
/*
 * extractJSON(text) — AI replies often wrap JSON in prose or in ```json fences. This finds and parses it.
 * Input: the AI's reply text. Returns: the parsed JavaScript object/array. Throws if no JSON is found
 * (JSON.parse also throws if the JSON is broken).
 */
export function extractJSON(text) {
  // Look for a fenced code block: ``` optionally followed by "json", optional whitespace,
  // then capture everything ($1) up to the next ```. [\s\S]*? = any characters including newlines, as few as possible.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  // If there was a fence, only look inside it; otherwise search the whole text.
  const candidate = fenced ? fenced[1] : text;
  // Position of the first '[' or '{' (the start of an array or object). /[[{]/ = either character.
  const start = candidate.search(/[[{]/);
  // -1 means not found.
  if (start < 0) throw new Error('No JSON found');
  // Which bracket it started with…
  const open = candidate[start];
  // …decides which closing bracket to look for.
  const close = open === '{' ? '}' : ']';
  // Use the LAST matching closing bracket, so nested brackets inside are included.
  const end = candidate.lastIndexOf(close);
  // Cut out that slice (end + 1 so the closing bracket is included) and parse it.
  return JSON.parse(candidate.slice(start, end + 1));
}
