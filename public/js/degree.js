/*
 * degree.js: the "degree" page of orbit (the part you see and click).
 *
 * The app is split in two on purpose:
 *  - degree-engine.js does the pure math and matching (no web page code): course-code
 *    patterns like PSY3XX, greedy allocation of courses to requirements so one course
 *    never double-counts, credit-weighted average / GPA, and the offline transcript reader.
 *  - degree.js (this file) builds the HTML, reacts to clicks and typing, saves changes to the
 *    store, and calls the engine to work out what to display.
 *
 * Main things this page does:
 *  - Year "folders" with courses (code, credits, grade, status: done / in progress / planned…).
 *  - A summary card with a progress ring, credits left, average, GPA and a time estimate.
 *  - Requirements: you can add them by hand, or paste links to your university calendar pages.
 *    The server fetches those pages, and an AI turns the text into a JSON checklist.
 *  - Streams: some programs have several requirement sets (e.g. co-op vs regular). The AI
 *    returns one set per stream and you pick yours; questions fill in other choices.
 *  - Transcript import: AI reads your transcript, or the offline parser if AI isn't connected.
 *
 * The pattern used everywhere: read state → build an HTML string → put it on the page →
 * "wire" event handlers → when something changes, update the store and call draw() again.
 */
// Degree planner: a folder per year with courses, credit totals, what's left, and automatic requirement checks.
// `import { a, b } from './file.js'` pulls named exports from another file (ES modules).
// store = the app's saved data (kept in localStorage); get() reads it, update(fn) changes + saves it.
import { store } from './store.js';
// aiEnabled() = is an AI model connected? ask({...}) = send a prompt and get text back.
// isBrowserMode() = running on the hosted website (no server), so we can't fetch external pages.
import { aiEnabled, ask, isBrowserMode } from './ai.js';
// esc = escape text so it's safe inside HTML (turns < into &lt; etc.); uid = make a random id;
// extractJSON = pull the JSON out of an AI reply; fmtDate = format a date string nicely.
import { esc, uid, extractJSON, fmtDate } from './util.js';
// toast = small pop-up message; modal = dialog box; spinner = "thinking…" HTML;
// readFilesText = read text out of uploaded files (pdf, images…); ACCEPT = allowed file types.
import { toast, modal, spinner, readFilesText, ACCEPT } from './ui.js';
// askAbout(text) = jump to the chat page with this question pre-filled.
import { askAbout } from './chat.js';
// The math helpers from the engine (see degree-engine.js for each one).
import { SCHOOLS, schoolPreset, summary, evaluate, parseTranscript, yearLabel, currentTerm, academicStart, round, normCode, detectCompleted } from './degree-engine.js';

// Arrow function (a short way to write a function): deg() returns the saved degree object.
const deg = () => store.get().degree;
// upd(fn): change the degree data and save. It hands just the degree part (s.degree) to your function.
// Example: upd((d) => (d.school = 'UofT')).
const upd = (fn) => store.update((s) => fn(s.degree));
// The term choices shown in the dropdowns.
const TERMS = ['Fall', 'Winter', 'Summer', 'Full year'];
// Course statuses as [saved value, label shown to the user] pairs.
const STATUSES = [['completed', 'done'], ['in-progress', 'in progress'], ['planned', 'planned'], ['failed', 'failed'], ['dropped', 'dropped']];
// fmt(n): show whole numbers as-is ('3'), otherwise round to 2 decimals ('1.33'), as text.
// `cond ? a : b` is the ternary operator: "if cond then a else b".
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(round(n)));

// `let` (not const) because this changes. null = nothing running; otherwise a label like 'reading 2 pages…'.
let busy = null; // label while an AI/fetch job runs

/*
 * render(el): draw the whole degree page into the element `el`.
 * Input: el, the page container (from app.js). Returns nothing.
 * It defines draw(), which rebuilds the page from the saved data; draw() is passed around so
 * any handler can redraw after changing something. That's a closure: draw "remembers" el.
 */
export function render(el) {
  const draw = () => {
    // Current degree data.
    const d = deg();
    // All the computed numbers (credits left, GPA, requirement results…) from the engine.
    const s = summary(d);
    // What this school calls credits; default 'credits'.
    const unit = d.unit || 'credits';
    // Build the page as one big template literal (a backtick string where ${...} inserts values).
    // What's in it:
    //  - header: a "kicker" line "degree · school · program" (each part only if set, lower-cased and
    //    escaped), the title, and a sentence using the unit with a trailing "s" removed
    //    (/s$/ = an "s" at the very end), e.g. "every credit".
    //  - buttons: "import transcript" (a <label> wrapping a hidden file input, so clicking the label
    //    opens the file picker) and "+ add year".
    //  - the summary card (summaryCard).
    //  - a two-column grid: the year folders (or the empty-state card if there are no years;
    //    .map() turns each year into HTML and .join('') glues them into one string) and the
    //    requirements card.
    el.innerHTML = `
      <div class="page-head view-enter">
        <div>
          <div class="kicker">degree${d.school ? ' · ' + esc(d.school.toLowerCase()) : ''}${d.program ? ' · ' + esc(d.program.toLowerCase()) : ''}</div>
          <h1>the <em>long game</em></h1>
          <p>every course, every ${esc(unit.replace(/s$/, ''))}, and exactly what’s left before you graduate.</p>
        </div>
        <div class="row">
          <label class="btn ghost sm">import transcript<input type="file" id="tx-file" accept="${ACCEPT}" multiple hidden></label>
          <button class="btn sm" id="add-year">+ add year</button>
        </div>
      </div>

      ${summaryCard(d, s)}

      <div class="grid dash view-enter" style="margin-top:22px">
        <div class="stack" id="years">${d.years.length ? d.years.map((y, i) => yearFolder(d, y, i)).join('') : emptyYears()}</div>
        <div class="stack">${requirementsCard(d, s)}</div>
      </div>`;
    // The HTML is on the page now; attach click/typing handlers to it.
    wire(el, draw);
  };
  // Draw for the first time.
  draw();
}

// ---------------- pieces ----------------
/*
 * summaryCard(d, s): HTML for the big progress card at the top.
 * Inputs: d = degree data, s = summary(d). Returns an HTML string.
 * The ring is an SVG: three coloured circles on top of each other (planned, in progress, done).
 */
function summaryCard(d, s) {
  const unit = d.unit || 'credits';
  // Radius of the ring circle, in SVG units.
  const R = 70;
  // Circumference (distance around the circle) = 2πr.
  const C = 2 * Math.PI * R;
  // arc(pct, cls): one coloured circle that only shows pct% of its outline.
  // Trick: stroke-dasharray="dash gap" draws a dash of length C*pct/100 then a gap of C, so only
  // that fraction is drawn. rotate(-90 90 90) turns it so it starts at 12 o'clock, not 3 o'clock.
  const arc = (pct, cls) => `<circle class="${cls}" cx="90" cy="90" r="${R}" fill="none" stroke-dasharray="${(C * pct) / 100} ${C}" transform="rotate(-90 90 90)"/>`;
  // True if the "needed to graduate" number isn't set (0), so we can't say what's left.
  const noTotal = !s.total;
  // The card HTML. Piece by piece:
  //  - label: "progress", plus "· requirements checked <date>" if they've been checked.
  //    checkedAt is a timestamp; new Date(...).toISOString().slice(0, 10) gives 'YYYY-MM-DD' for fmtDate.
  //  - big line: three cases (nested ternaries): no total → "X credits earned";
  //    nothing left → "done."; otherwise → "X credits left".
  //  - sentence: no total → a hint to set it; otherwise "X of Y earned", then optional extras
  //    (in progress, planned, what's left after the plan, and the "about N more years" estimate,
  //    adding "s" unless it's exactly 1).
  //  - four small stats (average %, GPA with 2 decimals via toFixed(2), requirements met, course count);
  //    '–' is shown when there's no value. `!= null` means "not null and not undefined".
  //  - the SVG ring: a grey track, then the three arcs (planned drawn first, so done sits on top),
  //    and the percentage text in the middle.
  return `<div class="card cover degree-cover view-enter">
    <div>
      <div class="label small muted">progress${d.checkedAt ? ` · requirements checked ${fmtDate(new Date(d.checkedAt).toISOString().slice(0, 10), { month: 'short', day: 'numeric' }).toLowerCase()}` : ''}</div>
      <div class="mode">${noTotal ? `<em>${fmt(s.earned)}</em> ${esc(unit)} earned` : s.left === 0 ? '<em>done.</em> you have enough to graduate' : `<em>${fmt(s.left)}</em> ${esc(unit)} left`}</div>
      <p>${noTotal ? 'set how many you need to graduate in <b>requirements</b> to see what’s left.' : `${fmt(s.earned)} of ${fmt(s.total)} earned${s.inProgress ? `, ${fmt(s.inProgress)} in progress` : ''}${s.planned ? `, ${fmt(s.planned)} planned` : ''}.${s.leftAfterPlan && (s.inProgress || s.planned) ? ` after everything you’ve planned: <b>${fmt(s.leftAfterPlan)}</b> to go.` : ''}${s.yearsLeft && s.leftAfterCurrent ? ` at your pace (~${fmt(s.pace)} a year) that’s about <b>${fmt(s.yearsLeft)} more year${s.yearsLeft === 1 ? '' : 's'}</b>.` : ''}`}</p>
      <div class="row" style="gap:28px">
        ${stat(s.percent != null ? s.percent + '%' : '–', 'average')}
        ${stat(s.gpa != null ? s.gpa.toFixed(2) : '–', 'gpa (4.0)')}
        ${stat(s.reqCount ? `${s.reqMet}/${s.reqCount}` : '–', 'requirements met')}
        ${stat(countCourses(d), 'courses')}
      </div>
    </div>
    <svg class="deg-ring" viewBox="0 0 180 180" aria-label="${Math.round(s.pct)}% complete">
      <circle cx="90" cy="90" r="${R}" fill="none" class="r-track"/>
      ${arc(s.pctPlan, 'r-plan')}${arc(s.pctIp, 'r-ip')}${arc(s.pct, 'r-done')}
      <text x="90" y="88" text-anchor="middle" class="r-pct">${noTotal ? '–' : Math.round(s.pct) + '%'}</text>
      <text x="90" y="110" text-anchor="middle" class="r-lbl">to graduation</text>
    </svg>
  </div>`;
}
// stat(v, l): HTML for one small number with a label under it, e.g. stat('3.70', 'gpa (4.0)').
const stat = (v, l) => `<div><div class="stat" style="font-size:32px">${esc(String(v))}</div><div class="small muted">${l}</div></div>`;
// countCourses(d): how many courses across all years, not counting dropped or failed ones.
// reduce adds up, year by year (a = running total), the number of courses that pass the filter.
const countCourses = (d) => d.years.reduce((a, y) => a + y.courses.filter((c) => !['dropped', 'failed'].includes(c.status)).length, 0);

/*
 * emptyYears(): HTML for the "add your first year" card shown when there are no years yet.
 * Returns an HTML string with a second "+ add year" button and a second transcript import
 * (ids end in -2 so they don't clash with the ones in the page header).
 */
function emptyYears() {
  return `<div class="card cta">
    <div class="big">year one.</div>
    <h3>add your first year</h3>
    <p class="muted">make a folder for each school year and drop your courses in. or import your transcript and it’ll build the folders for you.</p>
    <div class="row" style="justify-content:center"><button class="btn" id="add-year-2">+ add year</button><label class="btn ghost">import transcript<input type="file" id="tx-file-2" accept="${ACCEPT}" multiple hidden></label></div>
  </div>`;
}

/*
 * yearFolder(d, y, i): HTML for one year folder.
 * Inputs: d = degree, y = this year ({ id, label, open, courses }), i = its position (0, 1, …).
 * Returns an HTML string: a tab with the number ("01"), a header (open/close button, editable
 * name, credit totals, delete), and (if open) the courses grouped by term plus an "add course" row.
 */
function yearFolder(d, y, i) {
  // Credits in this year, skipping dropped/failed. `Number(c.credits) || 0` treats blanks as 0.
  const credits = round(y.courses.filter((c) => !['dropped', 'failed'].includes(c.status)).reduce((a, c) => a + (Number(c.credits) || 0), 0));
  // Credits already completed this year.
  const done = round(y.courses.filter((c) => c.status === 'completed').reduce((a, c) => a + (Number(c.credits) || 0), 0));
  // Group courses by term: { Fall: [...], Winter: [...] }.
  const groups = {};
  // `x ||= []` means "if x is empty/missing, set it to []". So the first course in a term creates
  // the list, then .push adds the course. Courses with no term go under 'Fall'.
  for (const c of y.courses) (groups[c.term || 'Fall'] ||= []).push(c);
  // Order to show terms in: the standard TERMS first, then any unusual term names found
  // (Object.keys lists the group names), and finally keep only terms that actually have courses.
  // `[...a, ...b]` (spread) joins two arrays into one new array.
  const order = [...TERMS, ...Object.keys(groups).filter((t) => !TERMS.includes(t))].filter((t) => groups[t]);
  // Folders are open unless explicitly closed (open === false), so new ones start open.
  const open = y.open !== false;
  // The folder HTML:
  //  - data-year holds the id so wire() can find this folder; --tilt alternates a slight rotation
  //    (i % 2 is 1 for odd positions) so the folders look hand-placed.
  //  - the tab shows the number padded to 2 digits (padStart: 1 → '01').
  //  - the header: toggle button (chevron points down when open), the year name as an input
  //    (so you can rename it), "X credits · Y done · N courses" (the "done" part only when it
  //    differs from the total, and "course" vs "courses"), and a delete button.
  //  - if open: for each term, a label and its course rows; if no terms, "no courses yet"
  //    (`'' || 'fallback'` uses the fallback when the joined string is empty).
  //  - the add-course row: code, title, credits (pre-filled with the default credit; `??` uses 0.5
  //    only if defaultCredit is null/undefined), a term dropdown (pre-selects defaultTerm), and a
  //    status dropdown with only the first 3 statuses (slice(0, 3)). `([v, l])` is destructuring:
  //    it unpacks each [value, label] pair into v and l.
  //  - in the LAST folder only: a button to add your current courses from the rest of the app,
  //    listing their codes.
  return `<div class="folder ${open ? 'open' : ''}" data-year="${y.id}" style="--tilt:${i % 2 ? '0.4deg' : '-0.3deg'}">
    <div class="folder-tab"><span>${String(i + 1).padStart(2, '0')}</span></div>
    <div class="folder-body card">
      <div class="folder-head">
        <button class="icon-btn fold" data-toggle title="${open ? 'close' : 'open'} folder"><span class="chev ${open ? 'down' : ''}"></span></button>
        <input class="folder-title" data-label value="${esc(y.label)}" aria-label="year name">
        <span class="label small muted">${fmt(credits)} ${esc(d.unit || 'credits')}${done !== credits ? ` · ${fmt(done)} done` : ''} · ${y.courses.length} course${y.courses.length === 1 ? '' : 's'}</span>
        <button class="icon-btn" data-del-year title="delete year">delete</button>
      </div>
      ${open ? `
        ${order.map((t) => `<div class="term-label">${esc(t.toLowerCase())}</div>
          <div class="course-list">${groups[t].map((c) => courseRow(c)).join('')}</div>`).join('') || '<div class="small muted" style="padding:6px 2px 10px">no courses yet</div>'}
        <div class="add-course">
          <input data-f="code" placeholder="code, e.g. PSY100H1" style="max-width:150px">
          <input data-f="title" placeholder="course name (optional)">
          <input data-f="credits" type="number" step="0.25" min="0" value="${esc(String(d.defaultCredit ?? 0.5))}" title="${esc(d.unit || 'credits')}" style="max-width:78px">
          <select data-f="term">${TERMS.map((t) => `<option ${t === defaultTerm(y) ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <select data-f="status">${STATUSES.slice(0, 3).map(([v, l]) => `<option value="${v}" ${v === defaultStatus(y, d) ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="btn sm" data-add>add</button>
        </div>
        ${i === d.years.length - 1 && currentCoursesToAdd(d).length ? `<button class="btn ghost sm" data-add-current style="margin-top:10px">+ add my current courses (${currentCoursesToAdd(d).map((c) => esc(c.code)).join(', ')})</button>` : ''}` : ''}
    </div>
  </div>`;
}

/*
 * courseRow(c): HTML for one course line inside a folder.
 * Input: a course { id, code, title, credits, grade, status }. Returns an HTML string.
 * Every field is an input (data-c="field name") so you can edit it in place; the class s-<status>
 * colours the row. The status dropdown marks the current status as selected.
 * `c.credits ?? ''` shows blank when credits is null/undefined (but still shows 0).
 */
function courseRow(c) {
  return `<div class="course-row s-${c.status}" data-course="${c.id}">
    <span class="c-dot" title="${esc(c.status)}"></span>
    <input class="c-code" data-c="code" value="${esc(c.code)}" aria-label="course code">
    <input class="c-title" data-c="title" value="${esc(c.title || '')}" placeholder="—" aria-label="course name">
    <input class="c-num" data-c="credits" type="number" step="0.25" min="0" value="${esc(String(c.credits ?? ''))}" aria-label="credits">
    <input class="c-num" data-c="grade" value="${esc(c.grade || '')}" placeholder="grade" aria-label="grade">
    <select class="c-status" data-c="status">${STATUSES.map(([v, l]) => `<option value="${v}" ${v === c.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button class="icon-btn" data-del-course title="remove">×</button>
  </div>`;
}

/*
 * defaultTerm(y): which term to pre-select when adding a course to year y.
 * Returns the term of the last course in the year, or 'Fall' if the year is empty.
 * `?.` (optional chaining): if there is no last course (undefined), stop and give undefined
 * instead of crashing, and then `|| 'Fall'` kicks in.
 */
const defaultTerm = (y) => y.courses[y.courses.length - 1]?.term || 'Fall';
/*
 * defaultStatus(y, d): which status to pre-select when adding a course to year y.
 * Returns 'completed', 'in-progress' or 'planned'.
 * Rules: any year before the last is in the past → 'completed'. For the last year:
 * 'in-progress' if it already has an in-progress course or it's the only year; otherwise
 * 'planned' if every course in it is planned (and it has some); otherwise 'in-progress'.
 */
function defaultStatus(y, d) {
  // Position of this year in the list.
  const idx = d.years.indexOf(y);
  // Not the last year → it's a past year.
  if (idx < d.years.length - 1) return 'completed';
  // d.years.slice(0, idx) = the years before this one; `!….length` is true when there are none.
  return y.courses.some((c) => c.status === 'in-progress') || !d.years.slice(0, idx).length ? 'in-progress' : y.courses.every((c) => c.status === 'planned') && y.courses.length ? 'planned' : 'in-progress';
}
/*
 * currentCoursesToAdd(d): courses from the main app's course list (store.get().courses, the
 * classes you're taking now) that aren't in any year folder yet.
 * Returns an array of those course objects (only ones that have a code).
 */
function currentCoursesToAdd(d) {
  // A Set of every normalised code already in the folders. flatMap = map each year to its list
  // of codes, then flatten all those lists into one list.
  const have = new Set(d.years.flatMap((y) => y.courses.map((c) => normCode(c.code))));
  // Keep app courses that have a code and whose code isn't already in a folder.
  return store.get().courses.filter((c) => c.code && !have.has(normCode(c.code)));
}

/*
 * detected(d): required courses the planner has automatically spotted you've already done.
 * Input: d = degree. Returns the array from detectCompleted(), looking at both your year folders
 * and the courses the rest of the app knows about (store.get().courses, i.e. your current classes).
 * Each entry says which required course it is, your status/grade, and whether it's already in a
 * folder (inFolder) — the ones NOT in a folder are what we offer to add so they start counting.
 */
const detected = (d) => detectCompleted(d, store.get().courses);
/*
 * toAdd(d): the subset of detected() that still needs adding to a year folder.
 * These are required courses found in your current-courses list but not yet in the planner, so
 * they aren't being counted toward requirements until you add them. Returns an array (maybe empty).
 */
const toAdd = (d) => detected(d).filter((x) => !x.inFolder);

/*
 * detectBanner(d): HTML for the "we found required courses you've done" box.
 * Input: d = degree. Returns '' when there's nothing to show (no requirements, or none detected).
 * Shows every required course auto-detected as done (✓ with its grade), and, if any aren't in a
 * folder yet, a one-click button to add them so the checklist updates itself.
 */
function detectBanner(d) {
  // Need specific required courses before anything can be detected.
  if (!d.requirements?.length) return '';
  const found = detected(d);
  if (!found.length) return '';
  // The ones we can add for the student (found in current courses, not yet in a folder).
  const add = found.filter((x) => !x.inFolder);
  // A chip per detected course: ✓, the code, its grade if any, and an "or" hint for alternatives.
  const chip = (x) => `<span class="code-chip s-${x.status}" title="${esc(x.reqName)}${x.grade ? ' · ' + esc(x.grade) : ''}">✓ ${esc(x.code)}${x.grade ? ` <span class="faint">${esc(x.grade)}</span>` : ''}</span>`;
  return `<div class="ask-card ${add.length ? '' : 'answered'}" id="detect-card" style="margin-top:12px">
    <div class="ask-q">${add.length
      ? `found ${add.length} required course${add.length === 1 ? '' : 's'} in your current courses that ${add.length === 1 ? 'isn’t' : 'aren’t'} in the planner yet`
      : `required courses detected as done`}</div>
    <div class="small muted" style="margin:4px 0 8px">matched automatically to your requirements by course code.</div>
    <div style="line-height:2">${found.map(chip).join(' ')}</div>
    ${add.length ? `<button class="btn sm" id="detect-add" style="margin-top:10px">+ add ${add.length === 1 ? 'it' : `these ${add.length}`} to my latest year</button>` : ''}
  </div>`;
}

/*
 * requirementsCard(d, s): HTML for the whole requirements card (right column).
 * Inputs: d = degree, s = summary(d). Returns an HTML string with:
 *  - a fold-out setup section (university, program, stream, calendar links, paste/upload box,
 *    credits needed, credit value, unit name, save + "check my requirements" buttons),
 *  - the stream picker and follow-up questions (if the AI found any),
 *  - one row per requirement, and buttons to add one or ask the AI what to take next.
 */
function requirementsCard(d, s) {
  // Results from evaluate(), keyed by requirement id.
  const res = s.results;
  const reqs = d.requirements;
  // School preset (or null), used for grey placeholder hints like "20" credits.
  const presetHint = schoolPreset(d.school);
  // The words shown for each requirement state.
  const stateLabel = { met: 'met', 'in-progress': 'on track', planned: 'planned', missing: 'missing', manual: 'check yourself' };
  // The card HTML. Notes on the less obvious parts:
  //  - heading shows "X of Y met" or "not set up".
  //  - <details> is a built-in fold-out box; it starts open (`open` attribute) only if there are
  //    no requirements yet. <summary> is the clickable heading.
  //  - the university box is a custom "combobox" (text input + suggestion list, wired by mountCombo).
  //  - &#10; inside the placeholder is an HTML code for a line break.
  //  - the three number fields show the preset's values as placeholders if a school matched.
  //  - the check button is disabled while busy, and its text says "re-check" if requirements exist.
  //  - while busy, a spinner shows the busy label; #d-status is an empty box for messages later.
  //  - if AI isn't connected, a note explains; if we have sources, "read from: …" lists them
  //    (`d.sources?.length` is safe even if sources is missing).
  //  - below: stream picker, questions, the requirement rows, buttons, and a disclaimer.
  return `<div class="card taped" id="req-card">
    <h3>requirements <span>${reqs.length ? `${s.reqMet} of ${s.reqCount} met` : 'not set up'}</span></h3>

    <details class="req-setup" ${reqs.length ? '' : 'open'}>
      <summary>${reqs.length ? 'your program & sources' : 'set up your program'}</summary>
      <div class="stack" style="gap:10px;margin-top:12px">
        <label class="field">university<div class="combo"><input id="d-school" value="${esc(d.school)}" placeholder="University of Toronto" autocomplete="off" role="combobox" aria-expanded="false"><div class="combo-list" id="school-list" role="listbox" hidden></div></div></label>
        <label class="field">program / major<input id="d-program" value="${esc(d.program)}" placeholder="Honours BSc, Computer Science Major"></label>
        <label class="field">stream / option / concentration (if you know it)<input id="d-stream" value="${esc(d.stream || '')}" placeholder="e.g. CMP1, co-op, AI focus. leave blank and it’ll ask"></label>
        <label class="field">links to your program requirements (one per line)<textarea id="d-links" style="min-height:74px" placeholder="https://artsci.calendar.utoronto.ca/program/…&#10;add your minor’s page too">${esc(d.links)}</textarea></label>
        <details><summary class="small muted" style="cursor:pointer">or paste / upload the requirements</summary>
          <label class="drop" id="req-drop" style="padding:14px;margin-top:8px"><input type="file" id="req-file" accept="${ACCEPT}" multiple hidden><b style="font-size:18px">drop a pdf or screenshot</b><span class="muted small">e.g. the calendar page saved as pdf, or your degree audit</span></label>
          <textarea id="d-paste" style="min-height:90px;margin-top:8px" placeholder="paste requirement text here"></textarea>
        </details>
        <div class="row">
          <label class="field">needed to graduate<input id="d-total" type="number" step="0.5" min="0" value="${d.totalCredits || ''}" placeholder="${presetHint ? presetHint.total : '20'}"></label>
          <label class="field">one-term course =<input id="d-credit" type="number" step="0.25" min="0" value="${d.defaultCredit ?? ''}" placeholder="${presetHint ? presetHint.credit : '0.5'}"></label>
          <label class="field">called<input id="d-unit" value="${esc(d.unit || '')}" placeholder="${presetHint ? presetHint.unit : 'credits'}"></label>
        </div>
        <div class="row spread">
          <button class="btn ghost sm" id="d-save">save</button>
          <button class="btn sm" id="d-check" ${busy ? 'disabled' : ''}>${aiEnabled() ? (reqs.length ? 're-check requirements' : 'check my requirements') : 'check my requirements'}</button>
        </div>
        ${busy ? `<div>${spinner(busy)}</div>` : ''}
        <div id="d-status"></div>
        ${aiEnabled() ? '' : '<p class="small muted" style="margin:0">reading requirements automatically needs ai (connect kiro or a key in <code>.env</code>). you can still add requirements by hand below.</p>'}
        ${d.sources?.length ? `<p class="small muted" style="margin:0">read from: ${d.sources.map((x) => esc(x)).join(' · ')}</p>` : ''}
      </div>
    </details>

    ${detectBanner(d)}
    ${streamPicker(d)}
    ${questionsBox(d)}
    ${reqs.length ? `<div class="req-list">${reqs.map((r) => reqRow(r, res[r.id], d, stateLabel)).join('')}</div>` : ''}
    <div class="row spread" style="margin-top:14px">
      <button class="btn ghost sm" id="req-add">+ add requirement</button>
      ${aiEnabled() && reqs.length ? '<button class="btn ghost sm" id="req-plan">what should i take next?</button>' : ''}
    </div>
    <p class="small faint" style="margin:14px 0 0">a planning helper, not an official audit. double-check with your registrar or your school’s degree audit tool before you enrol.</p>
  </div>`;
}

/*
 * streamPicker(d): HTML for "which stream are you in?" buttons.
 * Input: degree. Returns '' if there are fewer than 2 streams (nothing to choose), otherwise a
 * card with one button per stream (data-stream = its index). Once chosen, it just says
 * "your stream" with the chosen one highlighted ('on').
 */
function streamPicker(d) {
  const streams = d.streams || [];
  if (streams.length < 2) return '';
  // The stream whose name matches the saved choice (undefined if none).
  const chosen = streams.find((x) => x.name === d.stream);
  // Card HTML: question (or "your stream"), a button per stream with its name and optional
  // one-line description, and a help hint while nothing is chosen.
  return `<div class="ask-card ${chosen ? 'answered' : ''}" id="stream-card">
    <div class="ask-q">${chosen ? 'your stream' : `your program has ${streams.length} streams with different requirements. which one are you in?`}</div>
    <div class="ask-opts">${streams.map((x, i) => `<button class="ask-opt ${x.name === d.stream ? 'on' : ''}" data-stream="${i}"><b>${esc(x.name)}</b>${x.description ? `<small>${esc(x.description)}</small>` : ''}</button>`).join('')}</div>
    ${chosen ? '' : '<p class="small muted" style="margin:8px 0 0">not sure? check your acceptance letter, ACORN/your student portal, or ask your program advisor.</p>'}
  </div>`;
}

/*
 * questionsBox(d): HTML for the AI's follow-up questions (e.g. "Are you in co-op?").
 * Input: degree. Returns '' if there are no questions; otherwise a card with each question and
 * its answer buttons (data-q = question index, data-a = answer). Saved answers are highlighted.
 * When all are answered and something changed, an "update my requirements" button appears.
 */
function questionsBox(d) {
  // Only real questions (skip empty/broken entries).
  const qs = (d.questions || []).filter((q) => q && q.question);
  if (!qs.length) return '';
  // Saved answers: { 'question text': 'chosen option' }.
  const answers = d.answers || {};
  // Questions still unanswered.
  const open = qs.filter((q) => !answers[q.question]);
  // Card HTML. If a question has no options, it offers 'yes' / 'no' (`q.options?.length` is safe if options is missing).
  return `<div class="ask-card ${open.length ? '' : 'answered'}" id="q-card">
    <div class="ask-q">${open.length ? 'a few more questions so the checklist matches you exactly' : 'your answers'}</div>
    ${qs.map((q, i) => `<div class="ask-item">
      <div class="small" style="margin-bottom:6px">${esc(q.question)}</div>
      <div class="ask-opts">${(q.options?.length ? q.options : ['yes', 'no']).map((o) => `<button class="ask-opt sm ${answers[q.question] === o ? 'on' : ''}" data-q="${i}" data-a="${esc(o)}">${esc(o)}</button>`).join('')}</div>
    </div>`).join('')}
    ${!open.length && d.answersChanged ? '<button class="btn sm" id="q-recheck" style="margin-top:10px">update my requirements</button>' : ''}
  </div>`;
}

/*
 * applyStream(dd, stream): switch the active requirement list to a stream's requirements.
 * Inputs: dd = the degree object (inside upd, so changes are saved), stream = { name, requirements, totalCredits }.
 * Returns nothing; it changes dd directly.
 * Keeps: any requirements you added by hand (source 'manual'), and the ticked "done" state of
 * manual-type requirements whose names match (so switching streams doesn't untick your GPA box).
 */
function applyStream(dd, stream) {
  // Map from manual requirement name (lower-case) → whether it was ticked done.
  // new Map([[key, value], …]) builds a Map from an array of pairs.
  const manualDone = new Map(dd.requirements.filter((r) => r.type === 'manual').map((r) => [r.name.toLowerCase(), r.done]));
  // Copy each stream requirement with a fresh id. done is restored for manual ones (Boolean turns
  // undefined into false); every other type starts as not done (the engine works that out).
  const reqs = (stream.requirements || []).map((r) => ({ ...r, id: uid(), done: r.type === 'manual' ? Boolean(manualDone.get(r.name.toLowerCase())) : false }));
  // New list = the stream's requirements followed by your hand-added ones.
  dd.requirements = [...reqs, ...dd.requirements.filter((r) => r.source === 'manual')];
  // Remember which stream is active.
  dd.stream = stream.name;
  // If the stream says how many credits it needs, use that.
  if (stream.totalCredits) dd.totalCredits = Number(stream.totalCredits);
}

/*
 * reqRow(r, x, d, labels): HTML for one requirement row.
 * Inputs: r = the requirement, x = its result from evaluate() ({ state, done, inProgress, planned,
 * need, unit, matched, missing }), d = degree, labels = state → word map.
 * Returns an HTML string ('' if there's no result).
 */
function reqRow(r, x, d, labels) {
  if (!x) return '';
  // Word for the amounts: 'course'/'courses' (singular when need is 1), or the school's credit unit.
  const unit = x.unit === 'courses' ? (x.need === 1 ? 'course' : 'courses') : d.unit || 'credits';
  const need = x.need || 0;
  // w(v): v as a % of need (max 100), used for bar widths. 0 if nothing is needed.
  const w = (v) => (need ? Math.min(100, (v / need) * 100) : 0);
  // Three variables in one statement; `|| 0` replaces missing values with 0.
  const done = x.done || 0, ip = x.inProgress || 0, pl = x.planned || 0;
  // Row HTML:
  //  - name + "X + Y in progress + Z planned of N unit" (not for manual ones) + the state word.
  //  - manual: a "done" checkbox. Otherwise:
  //    - a stacked progress bar: done part, then in-progress part, then planned part. Each later
  //      part's width is the difference between cumulative widths (Math.max(0, …) avoids negatives).
  //    - "counts:" chips for the matched courses, coloured by status.
  //    - "still need:" list; m.replace(/\s*\|\s*/g, ' or ') turns "A | B" (a bar with any spaces
  //      around it) into "A or B".
  //    - for unmet "choose" ones: "from:" the first 12 patterns, with every | changed to " or ",
  //      and "…" if there are more than 12.
  //  - the note (if any), and edit / remove buttons.
  return `<div class="req s-${x.state}" data-req="${r.id}">
    <div class="row spread" style="flex-wrap:nowrap;align-items:flex-start">
      <div style="min-width:0">
        <div class="req-name">${esc(r.name || 'requirement')}</div>
        ${r.type === 'manual' ? '' : `<div class="small muted">${fmt(done)}${ip ? ` + ${fmt(ip)} in progress` : ''}${pl ? ` + ${fmt(pl)} planned` : ''} of ${fmt(need)} ${esc(unit)}</div>`}
      </div>
      <span class="req-state">${labels[x.state]}</span>
    </div>
    ${r.type === 'manual' ? `<label class="check small" style="margin-top:8px"><input type="checkbox" data-req-done ${r.done ? 'checked' : ''}> done</label>` : `
      <div class="req-bar"><span class="b-done" style="width:${w(done)}%"></span><span class="b-ip" style="width:${Math.max(0, w(done + ip) - w(done))}%"></span><span class="b-pl" style="width:${Math.max(0, w(done + ip + pl) - w(done + ip))}%"></span></div>
      ${x.matched?.length ? `<div class="small muted">counts: ${x.matched.map((m) => `<span class="code-chip s-${m.status}">${esc(m.code)}</span>`).join(' ')}</div>` : ''}
      ${x.missing?.length ? `<div class="small" style="color:var(--accent);margin-top:4px">still need: ${x.missing.map((m) => esc(m.replace(/\s*\|\s*/g, ' or '))).join(', ')}</div>` : ''}
      ${r.type === 'choose' && x.state !== 'met' && r.courses?.length ? `<div class="small faint" style="margin-top:4px">from: ${esc(r.courses.slice(0, 12).join(', ').replace(/\|/g, ' or '))}${r.courses.length > 12 ? '…' : ''}</div>` : ''}`}
    ${r.note ? `<div class="small faint" style="margin-top:4px">${esc(r.note)}</div>` : ''}
    <div class="req-actions"><button class="icon-btn" data-req-edit>edit</button><button class="icon-btn" data-req-del>remove</button></div>
  </div>`;
}

// ---------------- wiring ----------------
/*
 * wire(el, draw): attach all the event handlers (clicks, typing, file drops) to the page that
 * render() just drew. Inputs: el = page element, draw = function that redraws the page.
 * Returns nothing. Because draw() replaces the HTML, wire() runs again after every redraw.
 * Pattern: `button.onclick = () => {...}` sets the click handler; most handlers change data with
 * upd(...) and then call draw().
 */
function wire(el, draw) {
  // $(q): shortcut to find the first element inside the page matching a CSS selector, e.g. $('#d-save').
  const $ = (q) => el.querySelector(q);

  // addYear: create a new year folder that follows on from the last one.
  const addYear = () => {
    const d = deg();
    // The last existing year (undefined if none).
    const prev = d.years[d.years.length - 1];
    // Read its start year from its label, e.g. "Year 2 · 2025–26" → 2025.
    // Regex: (20\d{2}) = a year 2000–2099 (captured as group 1), then optional spaces, then an
    // en dash or hyphen. `|| []` gives an empty array when there's no match, so [1] is undefined
    // instead of crashing; the leading + turns the text into a number. `prev &&` skips all this if there's no prev.
    const prevStart = prev && +(prev.label.match(/(20\d{2})\s*[–-]/) || [])[1];
    // New year starts the year after, or (if unknown) the current academic year.
    const start = prevStart ? prevStart + 1 : academicStart();
    const id = uid();
    // Add the folder, labelled e.g. "Year 3 · 2026–27", open and empty.
    upd((dd) => dd.years.push({ id, label: yearLabel(dd.years.length + 1, start), open: true, courses: [] }));
    draw();
    // After a short delay (30 ms, so the new HTML exists), put the cursor in its course-code box.
    setTimeout(() => el.querySelector(`[data-year="${id}"] [data-f="code"]`)?.focus(), 30);
  };
  // The header "+ add year" button.
  $('#add-year').onclick = addYear;
  // The empty-state button only exists when there are no years, hence `?.`.
  $('#add-year-2')?.addEventListener('click', addYear);
  // Both transcript file inputs (filter(Boolean) drops the one that isn't on the page): when files
  // are chosen, import them.
  [$('#tx-file'), $('#tx-file-2')].filter(Boolean).forEach((inp) => (inp.onchange = (e) => importTranscript(e.target.files, draw)));

  // ---- year folders ----
  // For each folder on the page (elements with data-year)…
  el.querySelectorAll('[data-year]').forEach((f) => {
    // dataset.year reads the data-year="..." attribute: this folder's id.
    const yid = f.dataset.year;
    // year(): look up this year's current saved data (fresh each time it's called).
    const year = () => deg().years.find((y) => y.id === yid);
    // Open/close button: flip y.open. `y.open === false` is true when it was closed, so it becomes
    // open, and vice versa (undefined counts as open, so it becomes false = closed).
    f.querySelector('[data-toggle]').onclick = () => { upd((d) => { const y = d.years.find((x) => x.id === yid); y.open = y.open === false; }); draw(); };
    // Renaming the folder: save the trimmed text, or 'Year' if left blank.
    f.querySelector('[data-label]').onchange = (e) => upd((d) => (d.years.find((x) => x.id === yid).label = e.target.value.trim() || 'Year'));
    // Delete button.
    f.querySelector('[data-del-year]').onclick = () => {
      const y = year();
      // Ask first if it has courses; if they click Cancel, stop (return).
      if (y.courses.length && !confirm(`Delete “${y.label}” and its ${y.courses.length} courses?`)) return;
      // Remember its position so "undo" can put it back in the same place.
      const idx = deg().years.indexOf(y);
      // Remove it (keep every year whose id isn't this one).
      upd((d) => (d.years = d.years.filter((x) => x.id !== yid)));
      draw();
      // Toast with an undo button: splice(idx, 0, y) inserts y back at idx without removing anything.
      // The undo handler can still see `y` and `idx` because of closures.
      toast('year deleted', { action: 'undo', onAction: () => { upd((d) => d.years.splice(idx, 0, y)); draw(); } });
    };
    // The "add" button only exists when the folder is open.
    const add = f.querySelector('[data-add]');
    if (add) {
      // val(k): trimmed value of the add-row field named k (code, title, credits, term, status).
      const val = (k) => f.querySelector(`[data-f="${k}"]`).value.trim();
      // doAdd: add the typed course to this year.
      const doAdd = () => {
        const code = val('code').toUpperCase();
        // No code typed → put the cursor in the code box and stop.
        if (!code) return f.querySelector('[data-f="code"]').focus();
        // Push the new course (new id, credits as a number, no grade yet).
        upd((d) => d.years.find((x) => x.id === yid).courses.push({ id: uid(), code, title: val('title'), credits: Number(val('credits')) || 0, term: val('term'), status: val('status'), grade: '' }));
        draw();
        // The page was redrawn, so find the new code box and focus it, ready for the next course.
        el.querySelector(`[data-year="${yid}"] [data-f="code"]`)?.focus();
      };
      add.onclick = doAdd;
      // Pressing Enter in any add-row input also adds the course.
      f.querySelectorAll('.add-course input').forEach((i) => (i.onkeydown = (e) => { if (e.key === 'Enter') doAdd(); }));
    }
    // "+ add my current courses" button (last folder only, if shown).
    f.querySelector('[data-add-current]')?.addEventListener('click', () => {
      const d = deg();
      const list = currentCoursesToAdd(d);
      // push(...array) spreads the array so each item is pushed separately. Each app course becomes
      // a degree course: code upper-cased, title only if the name differs from the code, default
      // credits, the current term, status in-progress.
      upd((dd) => dd.years.find((x) => x.id === yid).courses.push(...list.map((c) => ({ id: uid(), code: c.code.toUpperCase(), title: c.name !== c.code ? c.name : '', credits: dd.defaultCredit ?? 0.5, term: currentTerm(), status: 'in-progress', grade: '' }))));
      toast(`added ${list.length} current course${list.length === 1 ? '' : 's'}`);
      draw();
    });
    // For each course row in this folder…
    f.querySelectorAll('[data-course]').forEach((row) => {
      const cid = row.dataset.course;
      // …each editable field (data-c = field name) saves when changed.
      row.querySelectorAll('[data-c]').forEach((inp) => (inp.onchange = () => {
        // k = which field ('code', 'credits', 'grade', …); v = the new value.
        const k = inp.dataset.c;
        let v = inp.value.trim();
        // Credits are stored as numbers; codes in upper case.
        if (k === 'credits') v = Number(v) || 0;
        if (k === 'code') v = v.toUpperCase();
        upd((d) => {
          // Find this exact course and set the field. c[k] = v uses k as the property name.
          const c = d.years.find((x) => x.id === yid).courses.find((x) => x.id === cid);
          c[k] = v;
          // entering a grade on an in-progress course means it's finished
          if (k === 'grade' && v && c.status !== 'completed' && c.status !== 'failed') c.status = 'completed';
        });
        draw();
      }));
      // × button: remove this course from the year.
      row.querySelector('[data-del-course]').onclick = () => { upd((d) => { const y = d.years.find((x) => x.id === yid); y.courses = y.courses.filter((c) => c.id !== cid); }); draw(); };
    });
  });

  // ---- requirements setup ----
  // saveSetup: copy everything from the setup form into the saved degree.
  const saveSetup = () => {
    const school = $('#d-school').value.trim();
    // Preset for that school (or null).
    const p = schoolPreset(school);
    upd((d) => {
      // Did the user switch to a different school just now?
      const changedSchool = school && school !== d.school;
      d.school = school;
      d.program = $('#d-program').value.trim();
      // If the typed stream changed, save it and, if it matches one of the known streams, switch to
      // that stream's requirements.
      const typed = $('#d-stream').value.trim();
      if (typed !== (d.stream || '')) {
        d.stream = typed;
        const hit = (d.streams || []).find((x) => matchStream(x.name, typed));
        if (hit) applyStream(d, hit);
      }
      d.links = $('#d-links').value.trim();
      // Total needed: the typed number; or, if blank, the preset total when the school just changed
      // and no total was set; otherwise keep the old total (or 0).
      d.totalCredits = Number($('#d-total').value) || (changedSchool && p && !d.totalCredits ? p.total : d.totalCredits || 0);
      // One-term credit value: the typed number (even 0), else the preset's, else keep the old one.
      d.defaultCredit = $('#d-credit').value !== '' ? Number($('#d-credit').value) : p ? p.credit : d.defaultCredit;
      // Unit name: typed, else preset's, else the old one, else 'credits'.
      d.unit = $('#d-unit').value.trim() || (p ? p.unit : d.unit || 'credits');
    });
  };
  // Turn the university box into a suggestion dropdown of all school names; picking one runs the
  // box's onchange handler (defined below) to fill in the preset numbers.
  mountCombo($('#d-school'), $('#school-list'), SCHOOLS.map((x) => x.name), () => $('#d-school').onchange());
  // Stream buttons: data-stream is the index (+ turns the text into a number). Apply that stream.
  el.querySelectorAll('[data-stream]').forEach((b) => (b.onclick = () => {
    const st = deg().streams[+b.dataset.stream];
    upd((d) => applyStream(d, st));
    toast(`using the ${st.name} requirements`);
    draw();
  }));
  // Question answer buttons: save the answer and note that answers changed (so the
  // "update my requirements" button appears).
  el.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
    const q = deg().questions[+b.dataset.q];
    // `{ ...old, [key]: value }` copies the old answers and adds/overwrites one. [q.question] in
    // square brackets is a "computed key": the question text becomes the property name.
    upd((d) => { d.answers = { ...(d.answers || {}), [q.question]: b.dataset.a }; d.answersChanged = true; });
    draw();
  }));
  // "update my requirements": clear the flag and re-run the AI check with the answers included.
  $('#q-recheck')?.addEventListener('click', () => { upd((d) => (d.answersChanged = false)); checkRequirements($('#d-paste')?.value.trim() || '', draw); });
  // When the university box changes: if it's a known school, fill any EMPTY number fields with its preset.
  $('#d-school').onchange = () => {
    const p = schoolPreset($('#d-school').value);
    if (!p) return;
    if (!$('#d-credit').value) $('#d-credit').value = p.credit;
    if (!$('#d-unit').value) $('#d-unit').value = p.unit;
    if (!$('#d-total').value) $('#d-total').value = p.total;
  };
  // Save button.
  $('#d-save').onclick = () => { saveSetup(); toast('saved'); draw(); };
  const reqFile = $('#req-file');
  // loadReqFiles(files): read uploaded requirement files and add their text to the paste box.
  // `async` lets us use `await`, which pauses this function until the file reading finishes
  // (without freezing the page).
  const loadReqFiles = async (files) => {
    const ta = $('#d-paste');
    ta.placeholder = 'reading…';
    // Add the text after anything already there (with a blank line between). onProgress updates
    // the placeholder with progress messages. If reading fails, show the error for 8 seconds.
    try { ta.value = (ta.value ? ta.value + '\n\n' : '') + (await readFilesText(files, { onProgress: (m) => (ta.placeholder = m) })); } catch (e) { toast(e.message, { timeout: 8000 }); }
    ta.placeholder = 'paste requirement text here';
  };
  // Files picked with the file chooser.
  reqFile.onchange = (e) => loadReqFiles(e.target.files);
  // Drag-and-drop area.
  const drop = $('#req-drop');
  // While dragging over it: preventDefault stops the browser from opening the file itself, and
  // the 'over' class highlights the area.
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  // Leaving or dropping: remove the highlight.
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  // On drop: read the dropped files.
  drop.addEventListener('drop', (e) => loadReqFiles(e.dataTransfer.files));

  // "check my requirements": save the form, then ask the AI (or explain that AI is needed).
  $('#d-check').onclick = () => {
    saveSetup();
    if (!aiEnabled()) {
      toast('reading requirements needs ai. add them with “+ add requirement” for now', { timeout: 7000 });
      draw();
      return;
    }
    checkRequirements($('#d-paste').value.trim(), draw);
  };

  // ---- requirement rows ----
  el.querySelectorAll('[data-req]').forEach((row) => {
    const rid = row.dataset.req;
    // Manual requirements' "done" checkbox: save whether it's ticked.
    row.querySelector('[data-req-done]')?.addEventListener('change', (e) => { upd((d) => (d.requirements.find((r) => r.id === rid).done = e.target.checked)); draw(); });
    // Edit: open the editor with this requirement.
    row.querySelector('[data-req-edit]').onclick = () => editRequirement(deg().requirements.find((r) => r.id === rid), draw);
    // Remove, with undo (same idea as deleting a year).
    row.querySelector('[data-req-del]').onclick = () => {
      const r = deg().requirements.find((x) => x.id === rid);
      const idx = deg().requirements.indexOf(r);
      upd((d) => (d.requirements = d.requirements.filter((x) => x.id !== rid)));
      draw();
      toast('requirement removed', { action: 'undo', onAction: () => { upd((d) => d.requirements.splice(idx, 0, r)); draw(); } });
    };
  });
  // "+ add detected courses": add the auto-detected required courses that aren't in a folder yet
  // into the latest year, so the requirement checklist updates itself.
  $('#detect-add')?.addEventListener('click', () => {
    const d = deg();
    const add = toAdd(d);
    if (!add.length) return;
    // The app courses we're pulling details (name, grade, status) from, by normalised code.
    const appByCode = new Map(store.get().courses.filter((c) => c.code).map((c) => [normCode(c.code), c]));
    upd((dd) => {
      // Make sure there's a year folder to add into; create one if the planner is empty.
      if (!dd.years.length) dd.years.push({ id: uid(), label: yearLabel(1, academicStart()), open: true, courses: [] });
      const folder = dd.years[dd.years.length - 1];
      // Codes already in that folder, so we never add a duplicate.
      const have = new Set(folder.courses.map((c) => normCode(c.code)));
      for (const x of add) {
        if (have.has(x.key)) continue;
        have.add(x.key);
        // Pull the full title from the matching app course if we have it.
        const app = appByCode.get(x.key);
        folder.courses.push({
          id: uid(),
          code: x.code.toUpperCase(),
          title: app && app.name && app.name !== app.code ? app.name : '',
          credits: dd.defaultCredit ?? 0.5,
          term: currentTerm(),
          // Keep the status we detected (completed / in-progress), defaulting to completed.
          status: x.status || 'completed',
          grade: x.grade || '',
        });
      }
    });
    toast(`added ${add.length} course${add.length === 1 ? '' : 's'} · check the credits`);
    draw();
  });
  // "+ add requirement": open the editor empty (null = new).
  $('#req-add').onclick = () => editRequirement(null, draw);
  // "what should i take next?": send a ready-made question to the chat page.
  $('#req-plan')?.addEventListener('click', () => askAbout(`Look at my degree progress and requirements. What should I take next term to stay on track to graduate? Point out anything I'm at risk of missing.`));
}

// ---------------- requirement editor ----------------
/*
 * editRequirement(r, draw): open a dialog to add or edit one requirement.
 * Inputs: r = the requirement to edit, or null to add a new one; draw = redraw function.
 * Returns nothing. On save it updates the store and redraws.
 */
function editRequirement(r, draw) {
  // No requirement given → we're adding a new one.
  const isNew = !r;
  // x = the values to show in the form: the existing requirement, or blank defaults.
  const x = r || { name: '', type: 'choose', min: '', unit: 'credits', courses: [], note: '', overlap: false };
  // modal(title, bodyHTML, options) shows a dialog. The body HTML contains:
  //  - name; a type dropdown built from [value, label] pairs (destructured as [v, l]) with the
  //    current type selected;
  //  - "how many" (min) and "counted in" (credits or courses);
  //  - the course list textarea, one per line (x.courses joined with '\n'), with example
  //    patterns in the placeholder (&#10; = line break in HTML);
  //  - the overlap checkbox, a note, and the add/save button.
  // onMount(body, close) runs once the dialog is on the page: body = its content element,
  // close = function that closes it. (Writing `onMount(body, close) {` inside an object is the
  // short "method" syntax.)
  modal(isNew ? 'add requirement' : 'edit requirement', `
    <label class="field">name<input id="r-name" value="${esc(x.name)}" placeholder="e.g. 1.0 credit of 300/400-level PSY"></label>
    <label class="field">type<select id="r-type">
      ${[['courses', 'take these specific courses'], ['choose', 'earn an amount from a list'], ['total', 'total needed to graduate'], ['manual', 'something i check off myself (gpa, breadth…)']].map(([v, l]) => `<option value="${v}" ${x.type === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <div class="row" id="r-amount">
      <label class="field">how many<input id="r-min" type="number" step="0.5" min="0" value="${esc(String(x.min ?? ''))}" placeholder="leave empty = all"></label>
      <label class="field">counted in<select id="r-unit"><option value="credits" ${x.unit !== 'courses' ? 'selected' : ''}>${esc(deg().unit || 'credits')}</option><option value="courses" ${x.unit === 'courses' ? 'selected' : ''}>courses</option></select></label>
    </div>
    <label class="field" id="r-courses-f">courses (one per line)<textarea id="r-courses" style="min-height:110px" placeholder="PSY100H1&#10;PSY201H1 | STA220H1   ← either one&#10;PSY3XX   ← any 300-level PSY&#10;PSY   ← any PSY course">${esc((x.courses || []).join('\n'))}</textarea></label>
    <label class="check small" id="r-overlap-f"><input type="checkbox" id="r-overlap" ${x.overlap ? 'checked' : ''}> courses here can also count toward other requirements</label>
    <label class="field">note<input id="r-note" value="${esc(x.note || '')}" placeholder="optional"></label>
    <div class="row" style="justify-content:flex-end"><button class="btn" id="r-save">${isNew ? 'add' : 'save'}</button></div>`, {
    onMount(body, close) {
      // Selector shortcut, but searching inside the dialog.
      const $ = (q) => body.querySelector(q);
      // sync(): show only the fields that make sense for the chosen type
      // (style.display = 'none' hides; '' shows it normally).
      const sync = () => {
        const t = $('#r-type').value;
        // Course list and overlap: only for 'courses' and 'choose'.
        $('#r-courses-f').style.display = t === 'courses' || t === 'choose' ? '' : 'none';
        $('#r-overlap-f').style.display = t === 'courses' || t === 'choose' ? '' : 'none';
        // Amount: hidden for 'manual'.
        $('#r-amount').style.display = t === 'manual' ? 'none' : '';
        // "counted in" (credits vs courses): only for 'choose'. parentElement = its surrounding <label>.
        $('#r-unit').parentElement.style.display = t === 'choose' ? '' : 'none';
      };
      // Re-run whenever the type changes, and once now.
      $('#r-type').onchange = sync;
      sync();
      // Save button: collect the form into a data object.
      $('#r-save').onclick = () => {
        const data = {
          // Name, or 'requirement' if blank.
          name: $('#r-name').value.trim() || 'requirement',
          type: $('#r-type').value,
          // Empty box stays '' (meaning "all"); otherwise a number.
          min: $('#r-min').value === '' ? '' : Number($('#r-min').value),
          unit: $('#r-unit').value,
          // Split the textarea into entries. Regex: a line break (\n), OR a comma that is NOT
          // followed later on by a "|" (the lookahead (?![^|]*\|) checks "no run of non-| characters
          // and then a |"). So commas split entries, except commas sitting before a "|" alternative.
          // Then trim each entry and drop empty ones.
          courses: $('#r-courses').value.split(/\n|,(?![^|]*\|)/).map((s) => s.trim()).filter(Boolean),
          overlap: $('#r-overlap').checked,
          note: $('#r-note').value.trim(),
        };
        // A "total" requirement also sets the degree's total-needed number.
        if (data.type === 'total' && data.min) upd((d) => (d.totalCredits = data.min));
        upd((d) => {
          // New: add it with a fresh id, marked as hand-made (source 'manual'), then spread in the form data.
          if (isNew) d.requirements.push({ id: uid(), source: 'manual', done: false, ...data });
          // Edit: Object.assign copies the form data onto the existing saved requirement.
          else Object.assign(d.requirements.find((q) => q.id === r.id), data);
        });
        close();
        draw();
      };
    },
  });
}

// ---------------- combobox (styled replacement for <datalist>) ----------------
/*
 * mountCombo(input, list, options, onPick): turn a text input into an autocomplete box.
 * Inputs: input = the text box, list = the (hidden) element that holds suggestions,
 * options = array of suggestion strings (school names), onPick = function called with the
 * picked value (optional). Returns nothing.
 * Supports typing to filter, mouse clicks, arrow keys, Enter and Escape.
 */
function mountCombo(input, list, options, onPick) {
  // Index of the keyboard-highlighted suggestion (-1 = none). Shared by the functions below (closure).
  let active = -1;
  // show(): rebuild and display matching suggestions.
  const show = () => {
    const q = input.value.trim().toLowerCase();
    // Matching options: all if empty, or ones containing the typed text, or the school whose
    // nickname matches (e.g. 'uoft' → 'University of Toronto'). At most 8.
    const items = options.filter((o) => !q || o.toLowerCase().includes(q) || (schoolPreset(q)?.name === o)).slice(0, 8);
    // Nothing to show, or the only match is exactly what's typed → hide the list.
    if (!items.length || (items.length === 1 && items[0] === input.value)) return hide();
    // Keep the highlight within the new list length.
    active = Math.min(active, items.length - 1);
    // One button per suggestion; the highlighted one gets class 'on'; data-v holds its value.
    list.innerHTML = items.map((o, i) => `<button type="button" class="combo-opt ${i === active ? 'on' : ''}" data-v="${esc(o)}" role="option">${esc(o)}</button>`).join('');
    list.hidden = false;
    // Tell screen readers the list is open.
    input.setAttribute('aria-expanded', 'true');
    // mousedown (not click) so it fires before the input loses focus; preventDefault keeps focus in the input.
    list.querySelectorAll('[data-v]').forEach((b) => (b.onmousedown = (e) => { e.preventDefault(); pick(b.dataset.v); }));
  };
  // hide(): close the list and reset the highlight.
  const hide = () => { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); };
  // pick(v): put the value in the box, close the list, and call onPick if one was given (`?.()` calls it only if it exists).
  const pick = (v) => { input.value = v; hide(); onPick?.(v); };
  // Show suggestions when the box gets focus or the text changes (typing resets the highlight).
  input.addEventListener('focus', show);
  input.addEventListener('input', () => { active = -1; show(); });
  // On leaving the box, hide after 120 ms (a small delay so a click on a suggestion still lands).
  input.addEventListener('blur', () => setTimeout(hide, 120));
  // Keyboard controls.
  input.addEventListener('keydown', (e) => {
    // The suggestion buttons currently shown, as a real array.
    const opts = [...list.querySelectorAll('[data-v]')];
    if (list.hidden || !opts.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Stop the cursor jumping to the start/end of the text.
      e.preventDefault();
      // Move the highlight down (+1) or up (-1), wrapping around: adding opts.length before % keeps
      // it from going negative (e.g. -1 + 5 = 4, so up from the first goes to the last).
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      // classList.toggle(name, condition) adds 'on' only to the highlighted one.
      opts.forEach((o, i) => o.classList.toggle('on', i === active));
    // Enter with something highlighted → pick it.
    } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(opts[active].dataset.v); }
    // Escape → close.
    else if (e.key === 'Escape') hide();
  });
}

// normStream(x): simplify a stream name for comparing: lower-case, and every run of characters that
// aren't a–z or 0–9 becomes one space, then trim. e.g. 'CMP-1 (Co-op)' → 'cmp 1 co op'.
const normStream = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/*
 * matchStream(name, typed): does what the student typed refer to this stream?
 * Inputs: name = the stream's name, typed = what the student typed. Returns true/false.
 * True if (after normStream) they're equal, or one contains the other, or they share a word
 * longer than 2 characters that contains a digit (e.g. 'cmp1').
 * Example: matchStream('CMP1 admission category', 'cmp1') → true.
 */
function matchStream(name, typed) {
  // Two consts in one statement.
  const a = normStream(name), b = normStream(typed);
  // Either empty → no match.
  if (!a || !b) return false;
  // split(' ') breaks into words; /\d/ tests whether a word has a digit.
  return a === b || a.includes(b) || b.includes(a) || a.split(' ').some((w) => w.length > 2 && b.split(' ').includes(w) && /\d/.test(w));
}

// ---------------- automatic requirement check ----------------
/*
 * checkRequirements(pasted, draw): the AI requirement extraction.
 * Inputs: pasted = any requirement text the student pasted/uploaded ('' if none), draw = redraw.
 * Steps:
 *  1) fetch each calendar link's text through our own server (/api/page-text), because the
 *     browser isn't allowed to read other websites directly;
 *  2) send all the text to the AI with detailed instructions to reply with JSON
 *     (streams, requirements, follow-up questions, warnings);
 *  3) clean up the reply and save it; pick the student's stream if we can tell which one it is.
 * Returns nothing useful (async functions return a Promise); results go into the store.
 * `async function` means it can use `await` to wait for network requests.
 */
async function checkRequirements(pasted, draw) {
  const d = deg();
  // The links box split on any whitespace (\s+ = one or more spaces/newlines), trimmed, keeping only
  // entries starting with http:// or https:// (s? = optional "s", /i = any case).
  const links = d.links.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  // Nothing to read → tell the user and stop.
  if (!links.length && !pasted) return toast('add a link to your program page (or paste the requirements) first');
  // Show a spinner label, e.g. "reading 2 pages…".
  busy = links.length ? `reading ${links.length} page${links.length === 1 ? '' : 's'}…` : 'reading requirements…';
  draw();
  // texts = page texts for the AI; sources = short names to show "read from: …"; errors = failed links.
  const texts = [];
  const sources = [];
  const errors = [];
  // Hosted website (no server): the browser can't read other websites (CORS), so we can't fetch
  // the calendar links. Note each one as unavailable; the pasted/uploaded text path still works.
  if (isBrowserMode() && links.length) {
    for (const url of links) {
      try { errors.push(`${new URL(url).hostname}: reading links needs the local app (node server.js); paste the requirements text instead`); } catch { errors.push('a link could not be read on the hosted site; paste the requirements instead'); }
    }
  }
  // One page at a time (for…of with await waits for each before the next). Skipped on the website.
  for (const url of isBrowserMode() ? [] : links) {
    try {
      // Ask our server to download the page and return its text. encodeURIComponent makes the URL
      // safe to put inside another URL (escapes ?, &, / etc.).
      const r = await fetch('/api/page-text?url=' + encodeURIComponent(url));
      // Read the JSON reply ({ title, text } or { error }).
      const data = await r.json();
      // r.ok is false for error status codes; `throw` jumps to the catch below.
      if (!r.ok) throw new Error(data.error);
      // Label each page's text with a "# Source:" heading and its URL so the AI knows where it came from.
      texts.push(`# Source: ${data.title || url}\n${url}\n\n${data.text}`);
      // Short source name: the page title (max 60 chars) or just the website name (hostname).
      sources.push(data.title ? data.title.slice(0, 60) : new URL(url).hostname);
    } catch (e) {
      // Remember the failure as "site: message" and keep going with the other links.
      errors.push(`${new URL(url).hostname}: ${e.message}`);
    }
  }
  // Add the pasted text too, with its own heading.
  if (pasted) { texts.push(`# Source: pasted / uploaded text\n\n${pasted}`); sources.push('pasted text'); }
  // Nothing could be read at all → clear the spinner and show the errors.
  if (!texts.length) {
    busy = null;
    draw();
    return showStatus(`couldn’t read your links. ${errors.join(' · ')}`);
  }
  busy = 'working out your requirements…';
  draw();
  // Up to 25 of the student's own course codes, so the AI copies the same code style.
  const sampleCodes = d.years.flatMap((y) => y.courses.map((c) => c.code)).slice(0, 25);
  // Previous answers as lines like "- Are you in co-op? → yes". Object.entries turns
  // { q: a } into [[q, a], …]; ([q, a]) destructures each pair.
  const answers = Object.entries(d.answers || {}).map(([q, a]) => `- ${q} → ${a}`).join('\n');
  // The JSON shape of one requirement, written once and inserted into the prompt below.
  const reqSchema = '{"name":"short readable name","type":"courses|choose|total|manual","min":number|null,"unit":"credits|courses","courses":["CODE"],"note":"","overlap":false}';
  // try/catch: if anything below fails (network, bad JSON), jump to catch and show an error.
  try {
    // Ask the AI. `system` = the instructions (a long template literal). In plain words it says:
    //  - turn Canadian program requirements into a checklist, using ONLY the source text, never inventing;
    //  - reply with ONLY JSON in this shape: school, program, totalCredits, unit, defaultCredit,
    //    a list of streams (each with name, description, totalCredits and requirements in the
    //    reqSchema shape), up to 4 follow-up questions, and warnings;
    //  - STREAMS: if the program has several requirement sets (co-op vs regular, CMP1, etc.),
    //    return one complete stream per set; otherwise exactly one stream;
    //  - QUESTIONS: only for choices that change requirements but aren't streams; max 4, 2–5 options;
    //  - REQUIREMENT TYPES: explains courses / choose / total / manual, the " | " alternatives,
    //    the X wildcard, bare-subject and "*4XX" patterns (the same ones codeMatches understands),
    //    and when to set overlap;
    //  - copy codes exactly; here are the student's codes (sampleCodes, or "(none yet)"); and
    //    cover both major and minor, prefixing names "Major: …" / "Minor: …".
    // `messages` = the user message: school, program(s), stream, any answers (only if there are some),
    // then all the source texts separated by "---", cut to 70,000 characters so it isn't too long.
    // maxTokens = the longest reply allowed. `await` waits for the reply text.
    const reply = await ask({
      system: `You turn Canadian university program requirements into a precise checklist. Use ONLY the source text; never invent requirements, course codes or numbers.
Return ONLY JSON:
{"school":"","program":"","totalCredits":number|null,"unit":"credits|units|courses|credit hours","defaultCredit":number|null,
 "streams":[{"name":"short stream name exactly as the calendar calls it","description":"one line: who this stream is for / how you get in","totalCredits":number|null,"requirements":[${reqSchema}]}],
 "questions":[{"question":"","options":["",""]}],
 "warnings":["anything ambiguous the student should confirm"]}
STREAMS: Many programs have different requirement sets depending on stream, admission category, option, concentration, focus, co-op vs regular, specialist vs major, honours vs general, or year of entry (e.g. UTM Computer Science has a CMP1 admission category and other streams with different first-year requirements). If the source describes more than one such set, return ONE stream per set, each with its COMPLETE requirements (repeat shared requirements in every stream). If there is only one set, return exactly one stream.
QUESTIONS: Only for choices that change requirements but are NOT separate streams in the text (e.g. "Are you in co-op?", "Which minor are you pairing this with?", "Did you start before Fall 2024?"). Max 4, each with 2-5 short options. Don't ask anything the student already answered. Return [] if none.
REQUIREMENT TYPES:
- "courses": specific required courses. Alternatives in one entry joined with " | " (e.g. "PSY201H1 | STA220H1"). min = how many entries are required (null = all).
- "choose": "X credits/courses from a list or level". courses = codes or patterns: X is a digit wildcard ("CSC3XX" = any 300-level CSC), a bare subject ("CSC") = any course in that subject, "*4XX" = any 400-level course. min = the amount, unit = credits or courses.
- "total": total needed for the degree (also set totalCredits).
- "manual": things that can't be checked from course codes (minimum GPA/CGPA, breadth/distribution categories not defined by codes, residency, experiential learning, program admission/POSt requirements). Put the detail in note.
- overlap true for breadth/distribution-type requirements that may use courses also counted elsewhere, when the text allows it.
- Write course codes exactly as the calendar does. The student's codes look like: ${sampleCodes.join(', ') || '(none yet)'}.
- defaultCredit = credit value of a one-term course at this school; unit = what the school calls credits.
- Cover every program named (major AND minor), prefixing names ("Major: …", "Minor: …").`,
      messages: [{ role: 'user', content: `School: ${d.school || 'unknown'}\nProgram(s): ${d.program || 'see sources'}\nStream the student says they're in: ${d.stream || '(not given)'}\n${answers ? `Student's answers:\n${answers}\n` : ''}\n${texts.join('\n\n---\n\n').slice(0, 70000)}` }],
      maxTokens: 8000,
    });
    // Pull the JSON object out of the reply text (the AI may wrap it in ``` fences or extra words).
    const data = extractJSON(reply);
    // cleanReqs(list): never trust AI output blindly. Keep only requirements with a known type,
    // and rebuild each one with safe values: a new id, source 'ai', not done, name max 140 chars,
    // min as a number (or '' meaning "all"; `== null` catches null and undefined), unit forced to
    // 'courses' or 'credits', courses as non-empty strings (max 200), note max 300 chars, overlap
    // as a true/false. The `({ ... })` parentheses make the arrow function return an object.
    const cleanReqs = (list) => (list || [])
      .filter((r) => r && ['courses', 'choose', 'total', 'manual'].includes(r.type))
      .map((r) => ({
        id: uid(), source: 'ai', done: false,
        name: String(r.name || 'requirement').slice(0, 140),
        type: r.type,
        min: r.min == null || r.min === '' ? '' : Number(r.min),
        unit: r.unit === 'courses' ? 'courses' : 'credits',
        courses: (r.courses || []).map(String).filter(Boolean).slice(0, 200),
        note: String(r.note || '').slice(0, 300),
        overlap: Boolean(r.overlap),
      }));
    // older single-list replies still work
    // Streams: keep those with at least one requirement, and clean each one (name max 80 chars,
    // description max 200, requirements cleaned).
    let streams = (data.streams || []).filter((x) => x && x.requirements?.length).map((x) => ({ name: String(x.name || 'stream').slice(0, 80), description: String(x.description || '').slice(0, 200), totalCredits: x.totalCredits || null, requirements: cleanReqs(x.requirements) }));
    // If the AI returned a plain "requirements" list instead of streams, wrap it as one 'main' stream.
    if (!streams.length && data.requirements) streams = [{ name: 'main', description: '', requirements: cleanReqs(data.requirements) }];
    // Questions: real ones only, max 4, text max 200 chars, up to 5 options each as strings.
    const questions = (data.questions || []).filter((q) => q?.question).slice(0, 4).map((q) => ({ question: String(q.question).slice(0, 200), options: (q.options || []).map(String).filter(Boolean).slice(0, 5) }));
    // The stream we end up applying (set inside upd below).
    let picked = null;
    upd((dd) => {
      // Only store the stream list if there's an actual choice to make (2 or more).
      dd.streams = streams.length > 1 ? streams : [];
      dd.questions = questions;
      // Keep only answers to questions that still exist. Object.fromEntries is the opposite of
      // Object.entries: it turns [[q, a], …] back into { q: a }.
      dd.answers = Object.fromEntries(Object.entries(dd.answers || {}).filter(([q]) => questions.some((x) => x.question === q)));
      dd.answersChanged = false;
      // Take the school-wide numbers from the AI if it found them.
      if (data.totalCredits) dd.totalCredits = Number(data.totalCredits);
      if (data.defaultCredit) dd.defaultCredit = Number(data.defaultCredit);
      if (data.unit) dd.unit = String(data.unit);
      // Fill school/program only if the student left them blank.
      if (!dd.school && data.school) dd.school = String(data.school);
      if (!dd.program && data.program) dd.program = String(data.program);
      dd.sources = sources;
      // Timestamp (milliseconds) of this check, shown in the summary card.
      dd.checkedAt = Date.now();
      // One stream → use it. Several → the one matching what the student typed (if any).
      picked = streams.length === 1 ? streams[0] : streams.find((x) => matchStream(x.name, dd.stream));
      // Apply it. Special case: with only one stream and no stream typed, apply it with an empty
      // name (a copy made with spread) so a made-up name like 'main' isn't shown as "your stream".
      if (picked) applyStream(dd, streams.length === 1 && !dd.stream ? { ...picked, name: '' } : picked);
      // No stream picked yet: clear the AI requirements (keep hand-made ones) until the student chooses.
      else { dd.requirements = dd.requirements.filter((r) => r.source === 'manual'); dd.stream = ''; }
    });
    busy = null;
    draw();
    // Failed links plus the AI's warnings, shown as a bullet list (each escaped for safety).
    const warn = [...errors, ...(data.warnings || [])];
    if (warn.length) showStatus(`<b>double-check:</b><ul style="margin:4px 0 0;padding-left:18px">${warn.map((w) => `<li>${esc(String(w))}</li>`).join('')}</ul>`, true);
    // Tell the student what to do next, and scroll the relevant card into view.
    if (streams.length > 1 && !picked) {
      toast(`your program has ${streams.length} streams. pick yours`);
      document.querySelector('#stream-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // There are questions and at least one is unanswered.
    } else if (questions.length && questions.some((q) => !deg().answers?.[q.question])) {
      toast('answer a couple of questions to finish your checklist');
      document.querySelector('#q-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // All good: say how many requirements were found.
    } else toast(`found ${deg().requirements.length} requirement${deg().requirements.length === 1 ? '' : 's'}`);
  } catch (e) {
    // Something failed: stop the spinner and show the error (escaped).
    busy = null;
    draw();
    showStatus(`couldn’t work out the requirements: ${esc(e.message)}`);
  }
}
/*
 * showStatus(html, isHtml): show a message in the #d-status box under the setup form.
 * Inputs: the message, and isHtml = true if it's already safe HTML (otherwise it's escaped).
 * Returns nothing. Does nothing if the box isn't on the page.
 */
function showStatus(html, isHtml) {
  const box = document.querySelector('#d-status');
  if (box) box.innerHTML = `<div class="small" style="color:var(--accent)">${isHtml ? html : esc(html)}</div>`;
}

// ---------------- transcript import ----------------
/*
 * importTranscript(files, draw): read transcript file(s) and add the courses to year folders.
 * Inputs: files = the chosen files (a FileList), draw = redraw. Returns nothing (async).
 * Uses AI if connected; if AI is off or fails, falls back to the offline parseTranscript().
 * Courses already in a folder (same code, term and folder) are skipped, so importing twice is safe.
 */
async function importTranscript(files, draw) {
  // No files chosen → nothing to do. `files?.length` is safe if files is null.
  if (!files?.length) return;
  busy = 'reading your transcript…';
  toast('reading your transcript…');
  // Will hold the text extracted from the files.
  let text;
  try {
    // Wait for the files to be read as text (PDF, image OCR, etc. handled in fileread.js).
    text = await readFilesText(files);
  } catch (e) {
    busy = null;
    return toast(e.message, { timeout: 8000 });
  }
  // The years found: [{ start, courses: [...] }] (null until we have some).
  let years = null;
  if (aiEnabled()) {
    try {
      // Ask the AI to extract every course as JSON: school, plus years each with a start year and
      // courses (code, title, credits, term, grade, status). The instructions explain that
      // "start" is the year the academic year began, to copy credits exactly, that withdrawn
      // (WDR/W) = dropped, no grade = in-progress, and never to invent courses.
      // The transcript text is cut to 60,000 characters.
      const reply = await ask({
        system: `Extract every course from this university transcript / academic history. Return ONLY JSON:
{"school":"","years":[{"start":2025,"courses":[{"code":"","title":"","credits":number|null,"term":"Fall|Winter|Summer|Full year","grade":"","status":"completed|in-progress|failed|dropped"}]}]}
"start" = the calendar year the academic year began (Fall 2025 and Winter 2026 are both start 2025). Use credits exactly as shown (credits attempted/earned for the course). Withdrawn/"WDR"/"W" = dropped. No grade yet = in-progress. Never invent courses.`,
        messages: [{ role: 'user', content: text.slice(0, 60000) }],
        maxTokens: 6000,
      });
      const data = extractJSON(reply);
      // Keep only years that actually have courses.
      years = (data.years || []).filter((y) => y.courses?.length);
      // If the AI found the school name and we don't have one, save it.
      if (data.school && !deg().school) upd((d) => (d.school = String(data.school)));
    } catch (e) {
      toast(`ai couldn’t read it (${e.message}), trying the basic reader`);
    }
  }
  // AI off, failed, or found nothing → use the offline reader from degree-engine.js.
  if (!years?.length) years = parseTranscript(text);
  busy = null;
  // Still nothing → give up with a message.
  if (!years.length) return toast('couldn’t find any courses in that file. add them by hand instead', { timeout: 7000 });

  // Credits to use when the transcript didn't show any.
  const def = deg().defaultCredit ?? 0.5;
  // Count of courses actually added (for the final message).
  let added = 0;
  upd((d) => {
    // Set of "CODE|term|folder label" strings for every existing course, to spot duplicates.
    const have = new Set(d.years.flatMap((y) => y.courses.map((c) => `${normCode(c.code)}|${c.term}|${y.label}`)));
    // Oldest year first (missing start counts as 0), then handle each one.
    years.sort((a, b) => (a.start || 0) - (b.start || 0)).forEach((y, i) => {
      // Text like "2024–" that appears in that year's folder label (e.g. "Year 1 · 2024–25").
      const labelStart = y.start ? `${y.start}–` : null;
      // Is there already a folder for that year?
      let folder = labelStart && d.years.find((f) => f.label.includes(labelStart));
      // If not, make one at the end.
      if (!folder) {
        folder = { id: uid(), label: yearLabel(d.years.length + 1, y.start), open: true, courses: [] };
        d.years.push(folder);
      }
      for (const c of y.courses) {
        const key = `${normCode(c.code)}|${c.term}|${folder.label}`;
        // Skip courses with no code, or ones already in this folder for this term.
        if (!c.code || have.has(key)) continue;
        have.add(key);
        // Add the course with safe values: code upper-cased, title as text, credits (default if
        // missing), a known term (else 'Fall'), grade as text, a known status (else 'completed').
        folder.courses.push({ id: uid(), code: String(c.code).toUpperCase(), title: String(c.title || ''), credits: c.credits == null ? def : Number(c.credits), term: TERMS.includes(c.term) ? c.term : 'Fall', grade: String(c.grade ?? ''), status: ['completed', 'in-progress', 'failed', 'dropped', 'planned'].includes(c.status) ? c.status : 'completed' });
        added++;
      }
    });
    // keep folders in chronological order and renumber "Year N"
    // Sort by the start year read from each label (same regex as in addYear: a 20xx year followed by
    // an en dash or hyphen). Folders with no year in their label get 9999 so they go last.
    d.years.sort((a, b) => (+(a.label.match(/(20\d{2})\s*[–-]/) || [])[1] || 9999) - (+(b.label.match(/(20\d{2})\s*[–-]/) || [])[1] || 9999));
    // Replace "Year <number>" at the start of each label (^ = start, \d+ = digits) with the new position.
    d.years.forEach((y, i) => { y.label = y.label.replace(/^Year \d+/, `Year ${i + 1}`); });
  });
  toast(`imported ${added} course${added === 1 ? '' : 's'}. check the credits and grades`);
  draw();
}

// Short text summary for the chat assistant
/*
 * degreeContext(): a plain-text summary of the degree so the chat AI knows your situation.
 * Returns '' if nothing is set up, otherwise text like:
 *   "Degree: BSc Psych at UofT. 10/20 credits earned, 2 in progress, … Courses by year: … Unmet requirements: …"
 */
export function degreeContext() {
  const d = deg();
  // Nothing entered yet → nothing to tell the AI.
  if (!d.years.length && !d.requirements.length) return '';
  const s = summary(d);
  const res = evaluate(d);
  // One line per unmet requirement (not the total one): "- name: state", plus "(missing …)" if
  // there are missing entries, plus for 'choose' ones "(done/need unit; from first 8 patterns)".
  const open = d.requirements.filter((r) => r.type !== 'total' && res[r.id] && res[r.id].state !== 'met')
    .map((r) => `- ${r.name}: ${res[r.id].state}${res[r.id].missing?.length ? ` (missing ${res[r.id].missing.join(', ')})` : ''}${r.type === 'choose' ? ` (${res[r.id].done}/${res[r.id].need} ${r.unit}; from ${r.courses.slice(0, 8).join(', ')})` : ''}`);
  // One line per year: "Year 1 · 2024–25: PSY100H1 (completed, 85), …".
  const courses = d.years.map((y) => `${y.label}: ${y.courses.map((c) => `${c.code} (${c.status}${c.grade ? ', ' + c.grade : ''})`).join(', ')}`).join('\n');
  // The final text: program, school, credit totals (? when unknown), the average if known,
  // then the course lines, then the unmet requirements (or "(none)").
  return `\nDegree: ${d.program || '?'} at ${d.school || '?'}. ${s.earned}/${s.total || '?'} ${d.unit} earned, ${s.inProgress} in progress, ${s.planned} planned, ${s.left} left.${s.percent != null ? ` Average ${s.percent}%.` : ''}\nCourses by year:\n${courses}\nUnmet requirements:\n${open.join('\n') || '(none)'}`;
}
