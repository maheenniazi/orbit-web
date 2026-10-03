/*
 * calendar.js — the Calendar page ("#/calendar") plus the pop-up event editor used all over the app.
 *
 * How it fits in: app.js (the router) calls render(el) when the URL hash is "#/calendar".
 * Other pages (e.g. the dashboard) import openEventModal() from here to edit an event.
 *
 * What's on the page:
 *  - a month grid: 6 rows × 7 days = 42 squares, starting on the Sunday on/before the 1st;
 *    each square shows up to 3 coloured "chips" (events);
 *  - course filter chips to hide/show a course, and a toggle for auto study-plan sessions;
 *  - a side panel for the selected day with its events and a quick-add box;
 *  - an "export .ics" button that downloads a calendar file Google/Apple Calendar can import.
 *
 * Key ideas: the page is rebuilt from scratch by draw() each time something changes (simple and
 * reliable); HTML is built with template literals and put on screen with innerHTML; clicks are
 * handled by assigning functions to .onclick on the freshly-created elements. Dates are stored as
 * "YYYY-MM-DD" strings (ISO format) and turned into JS Date objects only when we need maths.
 */
// Calendar: month grid, day panel, event editor, course filters, .ics export.
// Store helpers: add/remove events, look up a course's colour/details, create a course if needed.
import { store, addEvents, removeEvents, courseColor, getCourse, ensureCourse } from './store.js';
// Date/text helpers: esc = HTML-safe text; toISO(Date) -> "YYYY-MM-DD"; fromISO does the reverse;
// MONTHS/WEEKDAYS = name lists; TYPE_META = event type labels; EXAM_TYPES = exam/midterm/final.
import { esc, toISO, todayISO, fromISO, addDays, MONTHS, WEEKDAYS, TYPE_META, fmtDate, fmtTime, EXAM_TYPES } from './util.js';
// modal = pop-up dialog; toast = small temporary message.
import { modal, toast } from './ui.js';
// parseQuick turns "lab report 5pm" into an event object.
import { parseQuick } from './syllabus.js';
// syncStudyPlans adds study sessions before any exam that doesn't have them yet.
import { syncStudyPlans } from './focus.js';

/*
 * openEventModal(evt) — opens a pop-up form to create or edit an event.
 * Input: evt = an existing event object (edit mode), or a partial one like { date: '2026-10-14' }
 *        (new event pre-filled with that date). `evt = {}` is a default parameter: if nothing is
 *        passed, evt is an empty object.
 * Returns: nothing (the modal saves to the store itself).
 */
export function openEventModal(evt = {}) {
  // A real saved event has an id; no id means we're creating a new one.
  const isNew = !evt.id;
  // Start from sensible defaults, then let evt's fields overwrite them (the spread `...evt` at
  // the END wins). courses[0]?.id = the first course's id, if any course exists (optional chaining).
  const e = { title: '', type: 'assignment', date: todayISO(), time: '', notes: '', courseId: store.get().courses[0]?.id || '', done: false, ...evt };
  // All courses, for the course dropdown.
  const courses = store.get().courses;
  // Open the modal. Title is "new event" or "edit event". The body HTML contains:
  //  - a Title text box (#e-title) pre-filled with the event's title;
  //  - a row with a Type dropdown (#e-type: one <option> per entry of TYPE_META, the current type
  //    marked "selected"; Object.entries turns { final: {...} } into [['final', {...}], …] and
  //    ([k, m]) destructures each pair into key k and meta m) and a Course dropdown (#e-course:
  //    "No course", one option per course, then "+ New course…" with the special value "__new");
  //  - a row with a Date picker (#e-date) and a Time picker (#e-time);
  //  - a Notes textarea (#e-notes);
  //  - only when editing: a "Done" tick box (#e-done);
  //  - a bottom row with a Delete button (only when editing; otherwise an empty span keeps the
  //    layout) and the save button ("Add event" or "Save").
  // The third argument is an options object; its onMount function runs once the modal is on screen.
  modal(isNew ? 'new event' : 'edit event', `
    <label class="field">Title<input id="e-title" value="${esc(e.title)}" placeholder="e.g. Problem Set 4"></label>
    <div class="row">
      <label class="field">Type<select id="e-type">${Object.entries(TYPE_META).map(([k, m]) => `<option value="${k}" ${k === e.type ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
      <label class="field">Course<select id="e-course"><option value="">No course</option>${courses.map((c) => `<option value="${c.id}" ${c.id === e.courseId ? 'selected' : ''}>${esc(c.code || c.name)}</option>`).join('')}<option value="__new">+ New course…</option></select></label>
    </div>
    <div class="row">
      <label class="field">Date<input type="date" id="e-date" value="${e.date}"></label>
      <label class="field">Time<input type="time" id="e-time" value="${e.time || ''}"></label>
    </div>
    <label class="field">Notes<textarea id="e-notes" style="min-height:80px" placeholder="Chapters, room, weight…">${esc(e.notes || '')}</textarea></label>
    ${isNew ? '' : `<label class="check"><input type="checkbox" id="e-done" ${e.done ? 'checked' : ''}> Done</label>`}
    <div class="row spread" style="margin-top:6px">
      ${isNew ? '<span></span>' : '<button class="btn danger" id="e-del">Delete</button>'}
      <button class="btn" id="e-save">${isNew ? 'Add event' : 'Save'}</button>
    </div>`, {
    // onMount(body, close): body = the modal's content element; close = a function that closes it.
    // (This is "method shorthand": onMount(...) { } inside an object = onMount: function (...) { }.)
    onMount(body, close) {
      // A tiny helper: $('#e-title') finds that element inside the modal body.
      const $ = (s) => body.querySelector(s);
      // Put the typing cursor in the Title box straight away.
      $('#e-title').focus();
      // When the course dropdown changes…
      $('#e-course').onchange = (ev) => {
        // …only act if "+ New course…" was picked.
        if (ev.target.value !== '__new') return;
        // Ask for the name with the browser's built-in prompt box.
        const name = prompt('Course name or code (e.g. "BIO 150")');
        // Cancelled or empty: reset the dropdown to "No course" and stop.
        if (!name) return (ev.target.value = '');
        // Create (or find) the course. Regex /\d/ means "contains any digit" — if the text has a
        // number (like "BIO 150") we also treat it as the course code.
        const id = ensureCourse(name, /\d/.test(name) ? name : '');
        // Add the new course as an <option> at the top of the dropdown…
        ev.target.insertAdjacentHTML('afterbegin', `<option value="${id}">${esc(name)}</option>`);
        // …and select it.
        ev.target.value = id;
      };
      // When Save / Add event is clicked…
      $('#e-save').onclick = () => {
        // Collect the form values into one object.
        const data = {
          // Title, trimmed; 'Untitled' if left blank.
          title: $('#e-title').value.trim() || 'Untitled',
          // The chosen type key, e.g. 'quiz'.
          type: $('#e-type').value,
          // The chosen course id ('' if still on "+ New course…" or "No course").
          courseId: $('#e-course').value === '__new' ? '' : $('#e-course').value,
          // The date, or today if the picker was cleared.
          date: $('#e-date').value || todayISO(),
          // The time ("HH:MM") or '' for all-day.
          time: $('#e-time').value,
          // Notes, trimmed.
          notes: $('#e-notes').value.trim(),
        };
        // New: add it as a manual event. Editing: find the saved event by id and copy the form
        // values (and the Done tick box) onto it with Object.assign(target, ...sources).
        if (isNew) addEvents([{ ...data, source: 'manual' }]);
        else store.update((s) => Object.assign(s.events.find((x) => x.id === e.id), data, { done: $('#e-done').checked }));
        // Exams get study sessions scheduled before them.
        if (EXAM_TYPES.includes(data.type)) syncStudyPlans();
        // Close the pop-up.
        close();
      };
      // The Delete button only exists when editing, so ?. skips this line for new events.
      $('#e-del')?.addEventListener('click', () => {
        // Keep a copy of the event AND its auto study sessions (examId points at this event) so Undo can restore them.
        const snapshot = store.get().events.filter((x) => x.id === e.id || x.examId === e.id);
        // Delete them (removeEvents also removes events whose examId matches).
        removeEvents([e.id]);
        // Close the pop-up.
        close();
        // Show "Event deleted" with an Undo button that pushes the saved copies back in.
        // push(...snapshot) spreads the array so each event is added separately.
        toast('Event deleted', { action: 'Undo', onAction: () => store.update((s) => s.events.push(...snapshot)) });
      });
    },
  });
}

/*
 * exportICS() — downloads all events as "orbit.ics", the standard calendar-file format
 * (plain text lines like "DTSTART:20261014T090000") that Google/Apple/Outlook can import.
 * Inputs: none. Returns: nothing (triggers a download).
 */
function exportICS() {
  // The saved state.
  const s = store.get();
  // A timestamp for "when this file was made" in ICS format, e.g. "20261014T153000Z":
  //  toISOString() gives "2026-10-14T15:30:00.123Z"; the regex /[-:]/g matches every "-" or ":"
  //  (g = all of them) and removes them; split('.')[0] drops the ".123Z" part; then add "Z" back
  //  (Z means UTC time).
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  // escI(t) — escapes text for ICS: the regex /[\\;,]/g matches every backslash, semicolon or
  // comma and puts a backslash in front of it; then /\n/g matches every line break and turns it
  // into the two characters "\n" (ICS values must stay on one line).
  const escI = (t) => String(t).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  // The lines of the file, starting with the required calendar header.
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//orbit//EN', 'CALSCALE:GREGORIAN'];
  // One VEVENT block per event.
  for (const e of s.events) {
    // "2026-10-14" -> "20261014" (regex /-/g = every dash).
    const d = e.date.replace(/-/g, '');
    // The event's course (or undefined).
    const c = getCourse(e.courseId);
    // Start the block with a unique id and the timestamp.
    lines.push('BEGIN:VEVENT', `UID:${e.id}@study-os`, `DTSTAMP:${stamp}`);
    // Timed event: start at that time, end one hour later.
    if (e.time) {
      // "14:30" -> "1430" + "00" seconds = "143000".
      const t = e.time.replace(':', '') + '00';
      // Split "14:30" into the numbers h = 14, m = 30 (.map(Number) converts each piece to a number).
      const [h, m] = e.time.split(':').map(Number);
      // End = one hour later, but never past 23 (so it stays on the same day); padStart(2, '0')
      // makes "9" into "09".
      const end = `${String(Math.min(23, h + 1)).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
      // e.g. DTSTART:20261014T143000 and DTEND:20261014T153000.
      lines.push(`DTSTART:${d}T${t}`, `DTEND:${d}T${end}`);
    } else {
      // All-day event: ICS wants a date-only start and an end on the NEXT day.
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(e.date, 1).replace(/-/g, '')}`);
    }
    // The title, prefixed with "[COURSE] " if the event has a course, e.g. "[PSYC 210] Midterm".
    lines.push(`SUMMARY:${escI((c ? `[${c.code || c.name}] ` : '') + e.title)}`);
    // Notes become the description (only if there are any).
    if (e.notes) lines.push(`DESCRIPTION:${escI(e.notes)}`);
    // Close the event block.
    lines.push('END:VEVENT');
  }
  // Close the calendar.
  lines.push('END:VCALENDAR');
  // Download trick: make an invisible <a> link…
  const a = document.createElement('a');
  // …point it at a Blob (an in-memory file) holding the lines joined with "\r\n" (the line
  // ending ICS requires); createObjectURL gives that file a temporary URL…
  a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
  // …tell the browser to download it with this file name instead of opening it…
  a.download = 'orbit.ics';
  // …and "click" it from code.
  a.click();
}

// Filters/cursor persist across navigation
// view lives at module level (outside render), so it isn't reset when you leave and come back:
//  cursor = the 1st day of the month being shown (a Date), selected = the chosen day ("YYYY-MM-DD"),
//  hidden = a Set of course ids that are filtered out ('none' = events with no course),
//  hideStudy = whether auto study sessions are hidden.
const view = { cursor: null, selected: todayISO(), hidden: new Set(), hideStudy: false };

/*
 * render(el) — draws the Calendar page. Called by the router in app.js.
 * Input: el = the element to draw into.
 * Returns: an unsubscribe function (the router calls it when you leave the page).
 */
export function render(el) {
  // First visit: show the current month (new Date(year, month, 1) = the 1st of this month).
  if (!view.cursor) { const d = new Date(); view.cursor = new Date(d.getFullYear(), d.getMonth(), 1); }

  // draw() rebuilds the whole page; it's called at the start, after any change, and on store updates.
  const draw = () => {
    // The saved state.
    const s = store.get();
    // The year and month (0 = January … 11 = December) being shown.
    const y = view.cursor.getFullYear();
    const mo = view.cursor.getMonth();
    // The first square of the grid = the Sunday on or before the 1st of the month.
    // new Date(y, mo, 1).getDay() = weekday of the 1st (0 = Sunday); going back that many days
    // (day "1 - weekday", which JS happily rolls back into the previous month) lands on Sunday.
    const start = new Date(y, mo, 1 - new Date(y, mo, 1).getDay());
    // Today as "YYYY-MM-DD", to highlight today's square.
    const today = todayISO();
    // Events that pass the filters: their course isn't hidden (no course counts as 'none'),
    // and they're not study sessions while study sessions are hidden.
    const visible = s.events.filter((e) => !view.hidden.has(e.courseId || 'none') && !(view.hideStudy && e.type === 'study'));
    // byDay groups events by date: { "2026-10-14": [event, event], … }.
    const byDay = {};
    // `||=` means "if byDay[e.date] doesn't exist yet, set it to []", then push the event into that list.
    for (const e of visible) (byDay[e.date] ||= []).push(e);
    // rank(e) — sort priority inside a day: exams first (0), then other deadlines (1), classes (2), study sessions (3).
    const rank = (e) => (EXAM_TYPES.includes(e.type) ? 0 : e.type === 'study' ? 3 : e.type === 'class' ? 2 : 1);
    // Sort each day's list by rank, and when the rank is equal (difference 0, which `||` treats as
    // false) by time.
    Object.values(byDay).forEach((l) => l.sort((a, b) => rank(a) - rank(b) || (a.time || '').localeCompare(b.time || '')));

    // Build the 42 grid squares as one HTML string.
    let cells = '';
    for (let i = 0; i < 42; i++) {
      // The date of square i: start date + i days (JS rolls over month ends automatically).
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      // As "YYYY-MM-DD", to look up its events.
      const iso = toISO(d);
      // That day's events, or an empty list.
      const evs = byDay[iso] || [];
      // One square: classes "other" (faded; day belongs to the previous/next month), "today" and
      // "sel" (the selected day); data-day holds its date for click handling. Inside: the day
      // number, up to 3 event chips (exam chips get an "exam" class, study ones "study", ticked
      // ones "done"; each coloured by course, with data-ev = event id and the title as a hover
      // tooltip), and "+N more" if the day has more than 3 events.
      cells += `<div class="cal-cell ${d.getMonth() !== mo ? 'other' : ''} ${iso === today ? 'today' : ''} ${iso === view.selected ? 'sel' : ''}" data-day="${iso}">
        <span class="num">${d.getDate()}</span>
        ${evs.slice(0, 3).map((e) => `<div class="cal-chip ${EXAM_TYPES.includes(e.type) ? 'exam' : ''} ${e.type === 'study' ? 'study' : ''} ${e.done ? 'done' : ''}" style="--c:${courseColor(e.courseId)}" data-ev="${e.id}" title="${esc(e.title)}">${esc(e.title)}</div>`).join('')}
        ${evs.length > 3 ? `<span class="cal-more">+${evs.length - 3} more</span>` : ''}
      </div>`;
    }

    // Events of the selected day, for the side panel.
    const dayEvs = (byDay[view.selected] || []);
    // Put the page on screen. Sections:
    //  1. header: "N events · N course(s)", the title "the calendar", and buttons: export .ics
    //     (#ics), a link to the syllabus import, and "+ new event" (#new);
    //  2. the main card: a month header with ‹ (#prev), the month name and year, › (#next) and
    //     "today" (#today); filter chips — one per course (class "on" when visible; data-f =
    //     course id; a coloured dot) plus a "study plan" chip (data-study); then the grid: 7
    //     weekday headings (Sun…Sat) followed by the 42 squares built above;
    //  3. the side card: the selected day's full date, a quick-add box (#qa + #qa-go), and either
    //     that day's events (each row: tick box with data-done, coloured bar, title, a sub-line
    //     with course code/name or type label plus notes, and the time) or "free day. nothing planned".
    el.innerHTML = `
      <div class="page-head">
        <div><div class="kicker">${s.events.length} events · ${s.courses.length} course${s.courses.length === 1 ? '' : 's'}</div><h1>the <em>calendar</em></h1></div>
        <div class="row">
          <button class="btn ghost sm" id="ics" title="Import into Google/Apple Calendar">export .ics</button>
          <a class="btn ghost sm" href="#/import">import syllabus</a>
          <button class="btn sm" id="new">+ new event</button>
        </div>
      </div>
      <div class="cal-layout">
        <div class="card">
          <div class="cal-head">
            <div class="row"><button class="icon-btn" id="prev">‹</button><span class="title">${MONTHS[mo].toLowerCase()} <span class="faint">${y}</span></span><button class="icon-btn" id="next">›</button><button class="btn ghost sm" id="today">today</button></div>
            <div class="filters">
              ${s.courses.map((c) => `<span class="chip ${view.hidden.has(c.id) ? '' : 'on'}" data-f="${c.id}"><span class="dot-c" style="background:${c.color}"></span>${esc(c.code || c.name)}</span>`).join('')}
              <span class="chip ${view.hideStudy ? '' : 'on'}" data-study>study plan</span>
            </div>
          </div>
          <div class="cal-grid">${WEEKDAYS.map((d) => `<div class="cal-dow">${d}</div>`).join('')}${cells}</div>
        </div>
        <div class="card">
          <h3>${fmtDate(view.selected, { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
          <div class="quick-add" style="margin-bottom:12px"><input id="qa" placeholder="quick add: “lab report 5pm”"><button class="btn sm" id="qa-go">add</button></div>
          ${dayEvs.length ? `<div class="ev-list">${dayEvs.map((e) => `
            <div class="ev ${e.done ? 'done' : ''}" data-ev="${e.id}" style="--c:${courseColor(e.courseId)}">
              <input type="checkbox" data-done="${e.id}" ${e.done ? 'checked' : ''}>
              <span class="bar"></span>
              <div><div class="t">${esc(e.title)}</div><div class="s">${esc(getCourse(e.courseId)?.code || getCourse(e.courseId)?.name || TYPE_META[e.type]?.label || '')}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div>
              <span class="when">${fmtTime(e.time)}</span>
            </div>`).join('')}</div>` : '<div class="empty"><span class="big">free day.</span>nothing planned</div>'}
        </div>
      </div>`;

    // Shortcut: $('#prev') = el.querySelector('#prev').
    const $ = (q) => el.querySelector(q);
    // ‹ / ›: move to the 1st of the previous / next month and re-draw (month -1 or 12 rolls the year over).
    $('#prev').onclick = () => { view.cursor = new Date(y, mo - 1, 1); draw(); };
    $('#next').onclick = () => { view.cursor = new Date(y, mo + 1, 1); draw(); };
    // "today": jump back to this month and select today.
    $('#today').onclick = () => { const d = new Date(); view.cursor = new Date(d.getFullYear(), d.getMonth(), 1); view.selected = todayISO(); draw(); };
    // "+ new event": open the editor pre-filled with the selected day.
    $('#new').onclick = () => openEventModal({ date: view.selected });
    // "export .ics": download the calendar file.
    $('#ics').onclick = exportICS;
    // Grid squares:
    el.querySelectorAll('[data-day]').forEach((c) => {
      // Single click…
      c.onclick = (ev) => {
        // …on a chip (closest walks up from the clicked element to find one) opens that event…
        const chip = ev.target.closest('[data-ev]');
        if (chip) return openEventModal(s.events.find((x) => x.id === chip.dataset.ev));
        // …anywhere else selects the day and re-draws.
        view.selected = c.dataset.day;
        draw();
      };
      // Double click: create a new event on that day.
      c.ondblclick = () => openEventModal({ date: c.dataset.day });
    });
    // Rows in the side panel: click opens the editor (unless the tick box was clicked).
    el.querySelectorAll('.ev[data-ev]').forEach((r) => (r.onclick = (ev) => {
      if (ev.target.matches('input')) return;
      openEventModal(s.events.find((x) => x.id === r.dataset.ev));
    }));
    // Tick boxes: save done = checked for that event.
    el.querySelectorAll('[data-done]').forEach((c) => (c.onchange = () =>
      store.update((st) => { const e = st.events.find((x) => x.id === c.dataset.done); if (e) e.done = c.checked; })));
    // Course filter chips: toggle that course in the hidden Set, then re-draw.
    el.querySelectorAll('[data-f]').forEach((c) => (c.onclick = () => {
      const id = c.dataset.f;
      // A ternary used as a statement: if hidden, un-hide it; otherwise hide it.
      view.hidden.has(id) ? view.hidden.delete(id) : view.hidden.add(id);
      draw();
    }));
    // "study plan" chip: flip hiding of study sessions.
    $('[data-study]').onclick = () => { view.hideStudy = !view.hideStudy; draw(); };
    // Quick add in the side panel.
    const qa = () => {
      // The typed text.
      const v = $('#qa').value.trim();
      // Ignore empty input.
      if (!v) return;
      // Parse it into { title, date, time, type, courseId }.
      const parsed = parseQuick(v);
      // Quick add in the day panel defaults to the selected day unless a date was typed
      // parseQuick uses today when no date is found, so: if the date isn't today, a date was
      // typed; or if it IS today, check whether the word "today" was typed (/today/i = the word
      // "today", any capitalisation).
      const typedDate = parsed.date !== todayISO() || /today/i.test(v);
      // Save it, using the selected day when no date was typed.
      addEvents([{ ...parsed, date: typedDate ? parsed.date : view.selected, source: 'manual' }]);
      // Exams get study sessions.
      if (EXAM_TYPES.includes(parsed.type)) syncStudyPlans();
      // Confirm.
      toast(`Added “${parsed.title}”`);
    };
    // Run quick add on the button or the Enter key.
    $('#qa-go').onclick = qa;
    $('#qa').onkeydown = (e) => { if (e.key === 'Enter') qa(); };
  };

  // First draw.
  draw();
  // Re-draw on every store change; return the unsubscribe function as the page's cleanup.
  return store.subscribe(draw);
}
