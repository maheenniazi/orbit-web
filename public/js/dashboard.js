/*
 * dashboard.js — the Home page ("#/dashboard"), the first thing you see when you open orbit.
 *
 * How it fits in: app.js (the router) calls render(el) from this file whenever the URL hash is
 * "#/dashboard" (or empty). render() builds the whole page as one big HTML string and puts it
 * into el with innerHTML, then attaches event handlers (onclick, onchange…) to the new elements.
 *
 * What's on the page (each is a "card" / widget):
 *  - cover: the current focus phase + an "orbit map" picture (an SVG drawing) where today is
 *    the sun and upcoming deadlines are planets on rings (7, 14, 30 days away);
 *  - this week: an agenda of everything due in the next 7 days, with tick boxes;
 *  - countdowns: "polaroid" cards counting the days to each exam;
 *  - soundtrack: the Spotify panel; recent notes: the 4 latest notes.
 *  The cards can be rearranged ("customize" mode) with buttons or by drag and drop; the layout
 *  is saved in the store under settings.home.
 *
 * Key ideas: template literals (`...${value}...`) build HTML; esc() makes user text safe inside
 * HTML; store.subscribe(draw) re-draws the page whenever the saved data changes.
 */
// Home: editorial cover + orbit map (today = sun, deadlines = planets), agenda, polaroid countdowns.
// store = saved app data; addEvents adds calendar events; courseColor/getCourse look up a course by id.
import { store, addEvents, courseColor, getCourse } from './store.js';
// Date/text helpers. Dates in this app are "ISO" strings like "2026-10-14" (year-month-day).
// esc = make text HTML-safe; todayISO = today's date string; addDays("2026-10-14", 3) = "2026-10-17";
// fmtDate/fmtTime = pretty text ("Wed, Oct 14", "2pm"); relDay = "Today"/"Tomorrow"/"In 3 days";
// daysUntil = whole days from today; TYPE_META = labels for each event type; EXAM_TYPES = ['exam','midterm','final'].
import { esc, todayISO, addDays, fmtDate, fmtTime, relDay, daysUntil, TYPE_META, EXAM_TYPES } from './util.js';
// toast() shows a small temporary pop-up message at the bottom of the screen.
import { toast } from './ui.js';
// getFocusState = which focus phase we're in; syncStudyPlans = auto-add study sessions before exams.
import { getFocusState, syncStudyPlans } from './focus.js';
// parseQuick turns typed text like "bio quiz fri 2pm" into an event object.
import { parseQuick } from './syllabus.js';
// openEventModal opens the pop-up editor for one event.
import { openEventModal } from './calendar.js';
// renderSpotify draws the music panel into an element.
import { renderSpotify } from './spotify.js';

/*
 * greeting() — picks a greeting for the time of day.
 * Inputs: none. Returns: a string like 'good morning'.
 */
function greeting() {
  // Current hour, 0–23.
  const h = new Date().getHours();
  // A chain of "ternary" operators: condition ? valueIfTrue : (next check…).
  // Before 5am -> 'up late', before noon -> morning, before 6pm -> afternoon, else evening.
  return h < 5 ? 'up late' : h < 12 ? 'good morning' : h < 18 ? 'good afternoon' : 'good evening';
}

// Planets sit on rings by how far away they are: 0-7d, 8-14d, 15-30d.
/*
 * orbitMap(events) — builds the SVG "orbit map" picture as an HTML string.
 * Input: events = the array of all calendar events from the store.
 * Returns: a string of <svg> markup (the caller drops it into the page).
 * SVG is HTML-like markup for drawings: <ellipse>, <circle>, <text> with x/y coordinates.
 */
function orbitMap(events) {
  // Drawing size (W×H) and the centre point (cx, cy) where the "sun" (today) sits.
  // One `const` can declare several variables separated by commas.
  const W = 520, H = 300, cx = 190, cy = 150;
  // Three oval rings. rx/ry = horizontal/vertical radius; max = the furthest day count for
  // that ring; l = the label drawn on it.
  const rings = [{ rx: 92, ry: 58, max: 7, l: '7 days' }, { rx: 158, ry: 98, max: 14, l: '14 days' }, { rx: 222, ry: 136, max: 30, l: '30 days' }];
  // Today's date string, e.g. "2026-10-14". ISO strings compare correctly as text ("2026-10-02" < "2026-10-14").
  const today = todayISO();
  // Pick the events to draw as planets:
  //  .filter keeps events from today up to 30 days ahead, not ticked "done", and not routine
  //    types (class / study / reading) so the map shows only real deadlines;
  //  .sort puts them in date order (localeCompare compares two strings: negative = a comes first);
  //  .slice(0, 9) keeps at most 9 so the picture doesn't get crowded.
  const upcoming = events
    .filter((e) => e.date >= today && e.date <= addDays(today, 30) && !e.done && !['class', 'study', 'reading'].includes(e.type))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 9);
  // How many planets have been placed on each ring so far (ring 0, 1, 2).
  const perRing = [0, 0, 0];
  // .map turns each event into a "placed planet" object with screen coordinates.
  const placed = upcoming.map((e) => {
    // Days from today until this event.
    const d = daysUntil(e.date);
    // Which ring: 0 for ≤7 days, 1 for ≤14 days, otherwise 2.
    const ri = d <= 7 ? 0 : d <= 14 ? 1 : 2;
    // k = this planet's position number on its ring. perRing[ri]++ gives the current value,
    // THEN adds 1 (so the next planet on that ring gets the next number).
    const k = perRing[ri]++;
    // Each ring gets its own arc so labels on different rings don't pile up.
    // Starting angle in degrees for this ring…
    const start = [-70, 25, 140][ri];
    // …and how many degrees apart the planets on this ring are.
    const step = [95, 70, 62][ri];
    // The planet's angle, converted from degrees to radians (what Math.cos/sin expect).
    const ang = (start + k * step) * (Math.PI / 180);
    // The ring object for this planet.
    const r = rings[ri];
    // x position on the oval: centre + radius × cos(angle) (basic circle maths, stretched into an oval).
    const x = cx + r.rx * Math.cos(ang);
    // Return everything needed to draw the planet:
    //  e = the event, d = days away, x/y = position (y uses sin), big = true for exams (drawn
    //  larger with a Saturn-style ring), left = true if it's near the right edge, so its label
    //  should be drawn to the LEFT of the planet instead of running off the picture.
    // `{ e, d, x }` is shorthand for `{ e: e, d: d, x: x }`.
    return { e, d, x, y: cy + r.ry * Math.sin(ang), big: EXAM_TYPES.includes(e.type), left: x > W - 150 };
  });
  // Build and return the SVG markup. Its parts, in drawing order:
  //  1. the <svg> wrapper with a viewBox (its coordinate system) and an accessible label;
  //  2. for each ring: an <ellipse> (the middle ring gets a "dash" class) and a <text> label
  //     placed near its top-right; rings.map(...).join('') turns the array into one string;
  //  3. a <g class="spin"> group with two tiny "star" dots the CSS animates around the centre
  //     (--cx/--cy are CSS variables telling it where the centre is);
  //  4. the sun: a <circle> at the centre and the word "today";
  //  5. for each placed planet: a <g> group (data-ev holds the event id so clicking opens it)
  //     containing the planet <circle> in the course's colour (radius 10 for exams, 6 otherwise),
  //     an extra tilted ellipse ring around exams only, the title (cut to 19 chars + "…" if
  //     longer than 20) and a "today / tomorrow / in N days" line, both placed left or right
  //     of the planet depending on p.left;
  //  6. if there are no planets, the text "nothing in orbit yet".
  return `<svg class="orbit-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Upcoming deadlines in orbit around today">
    ${rings.map((r, i) => `<ellipse class="ring ${i === 1 ? 'dash' : ''}" cx="${cx}" cy="${cy}" rx="${r.rx}" ry="${r.ry}"/><text class="rlabel" x="${cx + r.rx * 0.72}" y="${cy - r.ry * 0.72 - 4}">${r.l}</text>`).join('')}
    <g class="spin" style="--cx:${cx}px;--cy:${cy}px"><circle cx="${cx + 222}" cy="${cy}" r="2" fill="currentColor" opacity=".35"/><circle cx="${cx - 158}" cy="${cy + 10}" r="1.6" fill="currentColor" opacity=".35"/></g>
    <circle class="sun" cx="${cx}" cy="${cy}" r="28"/>
    <text class="sunlabel" x="${cx}" y="${cy + 5}" text-anchor="middle">today</text>
    ${placed.map((p) => `<g class="pl" data-ev="${p.e.id}">
        <circle class="planet" cx="${p.x}" cy="${p.y}" r="${p.big ? 10 : 6}" fill="${courseColor(p.e.courseId)}"/>
        ${p.big ? `<ellipse cx="${p.x}" cy="${p.y}" rx="17" ry="5" fill="none" stroke="${courseColor(p.e.courseId)}" stroke-width="1.2" transform="rotate(-18 ${p.x} ${p.y})"/>` : ''}
        <text class="plabel" x="${p.left ? p.x - 15 : p.x + 15}" y="${p.y - 3}" text-anchor="${p.left ? 'end' : 'start'}">${esc(p.e.title.length > 20 ? p.e.title.slice(0, 19) + '…' : p.e.title)}</text>
        <text class="pdays" x="${p.left ? p.x - 15 : p.x + 15}" y="${p.y + 12}" text-anchor="${p.left ? 'end' : 'start'}">${p.d === 0 ? 'today' : p.d === 1 ? 'tomorrow' : `in ${p.d} days`}</text>
      </g>`).join('')}
    ${placed.length ? '' : `<text class="pdays" x="${cx + 60}" y="${cy + 120}">nothing in orbit yet</text>`}
  </svg>`;
}

/*
 * render(el) — draws the Home page. Called by the router in app.js.
 * Input: el = the <main id="view"> element to draw into.
 * Returns: an "unsubscribe" function. The router calls it when you leave the page, so this
 * page stops re-drawing itself on data changes.
 */
export function render(el) {
  // draw is an inner function (an arrow function stored in a const). Because it is defined inside
  // render, it can use `el` even later on — this is called a "closure": a function remembers the
  // variables that were around when it was created.
  const draw = () => {
    // s = the full saved state (courses, events, notes, settings…).
    const s = store.get();
    // Today's date as "YYYY-MM-DD".
    const today = todayISO();
    // f = current focus phase info: { mode, auto, exam, days }.
    const f = getFocusState();
    // This week's agenda: events from today through 6 days from now, excluding regular classes,
    // sorted by date and then time. (a.time || '') means "use '' if there's no time", so
    // "2026-10-14" + "09:00" -> "2026-10-1409:00" can be compared as one string.
    const week = s.events
      .filter((e) => e.date >= today && e.date <= addDays(today, 6) && e.type !== 'class')
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    // Upcoming exams (exam/midterm/final, today or later), soonest first, at most 6 — for the countdowns card.
    const exams = s.events.filter((e) => EXAM_TYPES.includes(e.type) && e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
    // The 4 most recently edited notes. [...s.notes] uses the spread operator `...` to COPY the
    // array first, because .sort() changes the array it's called on and we don't want to
    // reorder the saved notes. b.updatedAt - a.updatedAt sorts newest first (timestamps are numbers).
    const notes = [...s.notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
    // How many not-done things are due today (.length of the filtered array).
    const dueToday = week.filter((e) => e.date === today && !e.done).length;

    // Build the agenda HTML piece by piece in this string.
    let agenda = '';
    // The date of the previous event we added, so we know when to print a new day heading.
    let last = '';
    // for…of loops over each event in the week list.
    for (const e of week) {
      // When the date changes, add a heading like "tomorrow · Oct 15", then remember this date.
      if (e.date !== last) { agenda += `<div class="day-label">${relDay(e.date).toLowerCase()} · ${fmtDate(e.date, { month: 'short', day: 'numeric' })}</div>`; last = e.date; }
      // Add one event row: a wrapper (gets a "done" class if ticked; data-ev = event id so a click
      // can open it; --c = course colour for the coloured bar), a tick box (data-done = event id),
      // the title with its type label ("Quiz"), a sub-line with the course code/name and notes,
      // and the time on the right. `getCourse(...)?.code` uses optional chaining: if the event
      // has no course, getCourse returns undefined and ?. gives undefined instead of crashing.
      agenda += `<div class="ev ${e.done ? 'done' : ''}" data-ev="${e.id}" style="--c:${courseColor(e.courseId)}">
        <input type="checkbox" data-done="${e.id}" ${e.done ? 'checked' : ''}><span class="bar"></span>
        <div><div class="t">${esc(e.title)}<span class="kind">${TYPE_META[e.type]?.label || ''}</span></div><div class="s">${esc(getCourse(e.courseId)?.code || getCourse(e.courseId)?.name || '')}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div>
        <span class="when">${fmtTime(e.time)}</span></div>`;
    }

    // The "cover" card. Left side: a small "current phase" label (adds "· automatic" if the
    // phase was chosen automatically), the phase name in italics, and if there's an exam the
    // line "<exam> is today" or "<exam> in N day(s)" (adds the "s" unless N is 1); then the
    // phase's description and buttons: "start a 25-min session" (links to the focus page) and,
    // only when there is no exam yet, "import a syllabus". Right side: the orbit map SVG.
    const cover = `<div class="card cover">
          <div>
            <div class="label small muted">current phase${f.auto ? ' · automatic' : ''}</div>
            <div class="mode"><em>${esc(f.mode.label)}</em>${f.exam ? `<br>${esc(f.exam.title)} ${f.days === 0 ? 'is today' : `in ${f.days} day${f.days === 1 ? '' : 's'}`}` : ''}</div>
            <p>${esc(f.mode.blurb)}</p>
            <div class="row"><a class="btn" href="#/focus">start a ${f.mode.work}-min session</a>${f.exam ? '' : '<a class="btn ghost" href="#/import">import a syllabus</a>'}</div>
          </div>
          ${orbitMap(s.events)}
        </div>`;
    // The "this week" card: a heading with a link to the calendar, then one of three things:
    //  - if there are events this week: the agenda list built above;
    //  - else if there are events at all (just not this week): "clear skies. nothing due this week";
    //  - else (brand-new user, no events): a welcome box asking you to import your syllabus.
    const weekCard = `<div class="card">
              <h2>this week <a href="#/calendar">view calendar</a></h2>
              ${week.length ? `<div class="ev-list">${agenda}</div>` : s.events.length ? '<div class="empty"><span class="big">clear skies.</span>nothing due this week</div>' : `<div class="cta"><div class="big">hi.</div><h3>start with your syllabus</h3><p class="muted">drop it in and every deadline shows up here on its own.</p><a class="btn" href="#/import">import syllabus</a></div>`}
            </div>`;
    // The "countdowns" card — only if there are exams (otherwise an empty string = no card).
    // For each exam: a "polaroid" with the number of days left big in the middle, the exam
    // title, and a sub-line with the course code and date. data-ev lets a click open the exam.
    const countdownsCard = exams.length ? `<div class="card taped"><h2>countdowns</h2><div class="countdowns">${exams.map((e) => `<div class="countdown" data-ev="${e.id}" style="--c:${courseColor(e.courseId)}"><div class="pic">${daysUntil(e.date)}<small>days</small></div><div class="l">${esc(e.title)}</div><div class="sub">${esc(getCourse(e.courseId)?.code || '')} · ${fmtDate(e.date, { month: 'short', day: 'numeric' })}</div></div>`).join('')}</div></div>` : '';
    // The "soundtrack" card: just a heading and an empty <div id="spotify"> that renderSpotify fills in later.
    const soundCard = `<div class="card"><h2>soundtrack</h2><div id="spotify"></div></div>`;
    // The "recent notes" card: a heading with a "view all" link, then either a list of up to 4
    // notes (each a link to the notes page showing the title, the course name or "general",
    // and the last-edited date — new Date(timestamp).toISOString().slice(0, 10) turns the
    // timestamp into "YYYY-MM-DD" so fmtDate can format it), or, if there are no notes, a
    // hint with an "open notes" button.
    const notesCard = `<div class="card">
              <h2>recent notes <a href="#/notes">view all</a></h2>
              ${notes.length ? `<div class="ev-list">${notes.map((n) => `<a class="ev" href="#/notes" data-note="${n.id}" style="--c:${courseColor(n.courseId)};grid-template-columns:8px 1fr auto;text-decoration:none"><span class="bar"></span><div><div class="t" style="font-family:var(--serif);font-size:18px">${esc(n.title)}</div><div class="s">${esc(getCourse(n.courseId)?.name || 'general')}</div></div><span class="when">${fmtDate(new Date(n.updatedAt).toISOString().slice(0, 10), { month: 'short', day: 'numeric' }).toLowerCase()}</span></a>`).join('')}</div>` : '<div class="empty">turn any lecture into notes<br><a class="btn ghost sm" href="#/notes" style="margin-top:12px">open notes</a></div>'}
            </div>`;

    // Put the whole page into el. The HTML has two parts:
    //  1. the page header: a small "kicker" line with today's full date and "N thing(s) due today"
    //     (or "nothing due today"); a big greeting heading that adds ", <your name>" if you set
    //     one in settings; and on the right a quick-add text box (#qa) with an "add" button
    //     (#qa-go) plus a "customize"/"done" button (#customize) that toggles layout editing;
    //  2. the cards area (#home-layout), arranged by layoutHTML() using the saved layout. We pass
    //     it an object mapping each widget id to the card HTML built above.
    // Note: `editing` is a variable declared further down in this file (at module level). That's
    // fine because draw() only runs after the whole file has loaded.
    el.innerHTML = `
      <div class="page-head view-enter">
        <div>
          <div class="kicker">${fmtDate(today, { weekday: 'long', month: 'long', day: 'numeric' }).toLowerCase()} · ${dueToday ? `${dueToday} thing${dueToday > 1 ? 's' : ''} due today` : 'nothing due today'}</div>
          <h1>${greeting()}${s.settings.name ? `, <em>${esc(s.settings.name.toLowerCase())}</em>` : ''}.</h1>
        </div>
        <div class="row" style="gap:10px;justify-content:flex-end"><div class="quick-add" style="min-width:min(320px,100%)"><input id="qa" placeholder="add something… “bio quiz fri 2pm”"><button class="btn" id="qa-go">add</button></div><button class="btn ghost sm" id="customize">${editing ? 'done' : 'customize'}</button></div>
      </div>

      <div class="view-enter" id="home-layout">${layoutHTML({ cover, week: weekCard, countdowns: countdownsCard, soundtrack: soundCard, notes: notesCard })}</div>`;

    // Event handlers. Every element with a data-ev="..." attribute (agenda rows, planets,
    // countdowns) opens that event's editor when clicked.
    // querySelectorAll('[data-ev]') finds all elements that HAVE a data-ev attribute.
    el.querySelectorAll('[data-ev]').forEach((r) => (r.onclick = (ev) => {
      // If the click was on the tick box itself, don't open the editor (the box handles it).
      if (ev.target.matches('input')) return;
      // Find the event whose id matches this element's data-ev, and open the editor for it.
      // r.dataset.ev reads the data-ev attribute.
      openEventModal(store.get().events.find((x) => x.id === r.dataset.ev));
    }));
    // Every tick box (data-done="<event id>"): when ticked/unticked, save done = true/false.
    // store.update gives us the state (st) to change; it then saves and re-draws.
    el.querySelectorAll('[data-done]').forEach((c) => (c.onchange = () =>
      store.update((st) => { const e = st.events.find((x) => x.id === c.dataset.done); if (e) e.done = c.checked; })));
    // qa = "quick add": reads the text box and turns it into a new event.
    const qa = () => {
      // The typed text with spaces trimmed off both ends.
      const v = el.querySelector('#qa').value.trim();
      // Nothing typed? Do nothing.
      if (!v) return;
      // Turn "bio quiz fri 2pm" into { title, date, time, type, courseId }.
      const e = parseQuick(v);
      // Save it. { ...e, source: 'manual' } copies all of e's fields (spread) and adds source.
      // (Saving triggers a re-draw through store.subscribe, which also clears the box.)
      addEvents([{ ...e, source: 'manual' }]);
      // If it's an exam, also schedule study sessions in the days before it.
      if (EXAM_TYPES.includes(e.type)) syncStudyPlans();
      // Confirm with a pop-up, e.g. "added “Bio quiz” · friday 2pm" (adds the time only if one was found).
      toast(`added “${e.title}” · ${relDay(e.date).toLowerCase()}${e.time ? ' ' + fmtTime(e.time) : ''}`);
    };
    // Run quick add when the "add" button is clicked…
    el.querySelector('#qa-go').onclick = qa;
    // …or when Enter is pressed inside the text box.
    el.querySelector('#qa').onkeydown = (e) => { if (e.key === 'Enter') qa(); };
    // The empty Spotify box inside the soundtrack card (may not exist if that widget is hidden).
    const sp = el.querySelector('#spotify');
    // If it exists, fill it with the music panel for the current phase's playlist.
    if (sp) renderSpotify(sp, f.mode.playlist);
    // Clicking a recent note remembers its id in sessionStorage (temporary per-tab storage) so
    // the notes page can open that note straight away. The link's href then goes to #/notes.
    el.querySelectorAll('[data-note]').forEach((a) => (a.onclick = () => sessionStorage.setItem('studyos:open-note', a.dataset.note)));
    // The customize/done button flips editing mode on/off and re-draws.
    el.querySelector('#customize').onclick = () => { editing = !editing; draw(); };
    // Attach the layout-editing buttons and drag-and-drop (does nothing when not editing).
    wireLayout(el, draw);
  };
  // Draw the page for the first time.
  draw();
  // Re-draw whenever the store changes; subscribe returns an "unsubscribe" function, which we
  // hand back to the router as this page's cleanup.
  return store.subscribe(draw);
}

// ---------------- movable home layout ----------------
// Zones: top (full width), left (wide column), right (column). Each widget is full or half width within its zone.
// WIDGETS: each widget id -> the name shown on its bar in customize mode.
const WIDGETS = { cover: 'focus + orbit map', week: 'this week', countdowns: 'countdowns', soundtrack: 'soundtrack', notes: 'recent notes' };
// The starting layout: cover on top; this week on the left; countdowns, then soundtrack and
// notes side by side (half width) on the right; nothing hidden.
const DEFAULT_LAYOUT = { top: [{ id: 'cover' }], left: [{ id: 'week' }], right: [{ id: 'countdowns' }, { id: 'soundtrack', half: true }, { id: 'notes', half: true }], hidden: [] };
// Whether customize mode is on. Module-level (outside render) so it survives re-draws.
let editing = false;

/*
 * getLayout() — returns the layout to use: the saved one if there is one, otherwise the default,
 * cleaned up so it only contains known widgets and every widget appears somewhere.
 * Inputs: none. Returns: { top: [...], left: [...], right: [...], hidden: [ids] }.
 */
export function getLayout() {
  // The layout saved in settings (undefined if the user never customized).
  const saved = store.get().settings.home;
  // Make a deep COPY (JSON.stringify then JSON.parse) so changing L can't accidentally change
  // the stored data or the DEFAULT_LAYOUT constant.
  const L = saved ? JSON.parse(JSON.stringify(saved)) : JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  // In each zone, drop any widget whose id isn't in WIDGETS (e.g. a widget that was removed from the app).
  // (L[z] || []) uses an empty list if the zone is missing.
  for (const z of ['top', 'left', 'right']) L[z] = (L[z] || []).filter((w) => WIDGETS[w.id]);
  // Same clean-up for the hidden list (which holds plain ids, not objects).
  L.hidden = (L.hidden || []).filter((id) => WIDGETS[id]);
  // A Set (a collection with no duplicates and a fast .has()) of every widget id already
  // somewhere: spread all three zones into one array, take their ids, and add the hidden ids.
  const placed = new Set([...L.top, ...L.left, ...L.right].map((w) => w.id).concat(L.hidden));
  // Any widget not placed anywhere (e.g. newly added to the app) is put at the end of the right column.
  for (const id of Object.keys(WIDGETS)) if (!placed.has(id)) L.right.push({ id }); // new widgets appear on the right
  // Hand back the cleaned layout.
  return L;
}
// saveLayout(L) — stores a layout in settings.home (which saves it and triggers a re-draw).
const saveLayout = (L) => store.update((s) => (s.settings.home = L));

/*
 * layoutHTML(cards) — arranges the cards into zones according to the layout.
 * Input: cards = { cover: '<html>', week: '<html>', … } (the card HTML built in render).
 * Returns: an HTML string.
 */
function layoutHTML(cards) {
  // The current layout.
  const L = getLayout();
  // zone(z) builds the HTML for one zone ('top' | 'left' | 'right'):
  //  - a wrapper div with classes "hz hz-<zone>" (+ "editing" in customize mode) and data-zone;
  //  - for each widget w (at index i) in that zone: skip it if its card is empty (e.g. no exams)
  //    unless we're editing; otherwise wrap it in a div.hw (+ "half" if half width; draggable
  //    only in customize mode). In customize mode the wrapper also gets a bar with a grip, the
  //    widget's name, and buttons: up / down (disabled at the first / last position), left /
  //    right (disabled if already in that column), top, a size toggle ("full width"/"half
  //    width") and "hide". Each button's data-act says which action it is. Then comes the card
  //    itself, or a placeholder message if the card is empty;
  //  - in customize mode, a "drop here" area at the end of the zone.
  const zone = (z) => `<div class="hz hz-${z} ${editing ? 'editing' : ''}" data-zone="${z}">${L[z].map((w, i) => {
    const html = cards[w.id];
    if (!html && !editing) return '';
    return `<div class="hw ${w.half ? 'half' : ''}" data-w="${w.id}" ${editing ? 'draggable="true"' : ''}>
      ${editing ? `<div class="hw-bar"><span class="hw-grip" aria-hidden="true"></span><b>${WIDGETS[w.id]}</b>
        <span class="hw-btns">
          <button data-act="up" title="move up" ${i === 0 ? 'disabled' : ''}>↑</button><button data-act="down" title="move down" ${i === L[z].length - 1 ? 'disabled' : ''}>↓</button>
          <button data-act="left" title="move to the left column" ${z === 'left' ? 'disabled' : ''}>←</button><button data-act="right" title="move to the right column" ${z === 'right' ? 'disabled' : ''}>→</button>
          <button data-act="top" title="move to the top, full width" ${z === 'top' ? 'disabled' : ''}>⤒</button>
          <button data-act="size">${w.half ? 'full width' : 'half width'}</button><button data-act="hide">hide</button>
        </span></div>` : ''}
      ${html || `<div class="card empty small">${WIDGETS[w.id]} shows up when there’s something to show</div>`}
    </div>`;
  }).join('')}${editing ? '<div class="hz-drop">drop here</div>' : ''}</div>`;
  // The final HTML: in customize mode, first a banner with instructions, buttons to bring back
  // any hidden widgets ("+ countdowns", each with data-show="<id>"), and a "reset layout"
  // button; then the top zone; then a two-column grid holding the left and right zones.
  return `${editing ? `<div class="edit-banner small">drag cards by their bar to move them, or use the buttons. ${L.hidden.length ? `hidden: ${L.hidden.map((id) => `<button class="link-btn" data-show="${id}">+ ${WIDGETS[id]}</button>`).join(' ')}` : ''} <button class="link-btn" id="reset-layout">reset layout</button></div>` : ''}
    ${zone('top')}
    <div class="grid dash home-cols">${zone('left')}${zone('right')}</div>`;
}

/*
 * wireLayout(el, draw) — attaches the customize-mode buttons and drag and drop.
 * Inputs: el = the page element; draw = the page's re-draw function.
 * Returns: nothing. Does nothing at all when customize mode is off.
 */
function wireLayout(el, draw) {
  // Only needed in customize mode.
  if (!editing) return;
  // find(L, id) — looks through the three zones for a widget id; returns [zoneName, index],
  // or [null, -1] if not found. findIndex returns -1 when nothing matches.
  const find = (L, id) => { for (const z of ['top', 'left', 'right']) { const i = L[z].findIndex((w) => w.id === id); if (i >= 0) return [z, i]; } return [null, -1]; };
  // commit(fn) — a helper for every change: get a fresh layout copy, let fn change it, save it, re-draw.
  const commit = (fn) => { const L = getLayout(); fn(L); saveLayout(L); draw(); };
  // Every button with a data-act inside a widget wrapper (.hw).
  el.querySelectorAll('.hw [data-act]').forEach((b) => (b.onclick = () => {
    // closest('.hw') walks up from the button to its widget wrapper; data-w is the widget id.
    const id = b.closest('.hw').dataset.w;
    commit((L) => {
      // Where the widget currently is. `const [z, i] = ...` is array destructuring: it unpacks
      // the two items of the returned array into two variables.
      const [z, i] = find(L, id);
      // The widget object itself, e.g. { id: 'notes', half: true }.
      const w = L[z][i];
      // Which button was clicked: 'up', 'down', 'left', 'right', 'top', 'size' or 'hide'.
      const act = b.dataset.act;
      // Up: swap with the widget before it. [a, b] = [b, a] is a destructuring trick to swap two values.
      if (act === 'up' && i > 0) [L[z][i - 1], L[z][i]] = [L[z][i], L[z][i - 1]];
      // Down: swap with the widget after it.
      if (act === 'down' && i < L[z].length - 1) [L[z][i + 1], L[z][i]] = [L[z][i], L[z][i + 1]];
      // Move to another zone: remove it here (splice(i, 1) cuts out 1 item at index i) and add it
      // to the end of the target zone. Widgets moved to the top are forced to full width
      // ({ ...w, half: false } = a copy of w with half set to false).
      if (['left', 'right', 'top'].includes(act)) { L[z].splice(i, 1); L[act].push(act === 'top' ? { ...w, half: false } : w); }
      // Size: flip between half and full width.
      if (act === 'size') w.half = !w.half;
      // Hide: remove it from its zone and add its id to the hidden list.
      if (act === 'hide') { L[z].splice(i, 1); L.hidden.push(id); }
    });
  }));
  // "+ widget" buttons in the banner: remove that id from hidden and put it at the START of the
  // right column (unshift adds to the front of an array), at full width.
  el.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => commit((L) => { L.hidden = L.hidden.filter((x) => x !== b.dataset.show); L.right.unshift({ id: b.dataset.show, half: false }); })));
  // "reset layout": delete the saved layout so getLayout falls back to the default, then re-draw.
  el.querySelector('#reset-layout').onclick = () => { store.update((s) => delete s.settings.home); draw(); };

  // drag and drop
  // HTML5 drag and drop works with events: "dragstart" on the thing you pick up, "dragover"
  // repeatedly on whatever you're hovering over, "drop" where you let go, and "dragend" on the
  // picked-up thing when it's all over.
  // The id of the widget currently being dragged (null when nothing is being dragged).
  let dragId = null;
  // Every draggable widget wrapper.
  el.querySelectorAll('.hw[draggable]').forEach((w) => {
    // Picking it up: remember its id, add a "dragging" class (CSS fades it), say this is a
    // "move", and put the id in the drag data (some browsers won't start a drag without data).
    w.addEventListener('dragstart', (e) => { dragId = w.dataset.w; w.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
    // Letting go (anywhere): remove the "dragging" class and clear any drop-position highlights.
    w.addEventListener('dragend', () => { w.classList.remove('dragging'); el.querySelectorAll('.drop-before,.drop-end').forEach((x) => x.classList.remove('drop-before', 'drop-end')); });
  });
  /*
   * targetIndex(zoneEl, x, y) — works out where in a zone the dragged widget would land, based on
   * the mouse position. Inputs: the zone element and mouse x/y (in screen pixels).
   * Returns { i, el }: the index to insert at, and the widget it would go before (el is null if
   * it would go at the end).
   */
  const targetIndex = (zoneEl, x, y) => {
    // The widgets directly inside this zone (':scope >' means direct children only), excluding
    // the one being dragged. [...NodeList] turns the list into a real array so we can .filter it.
    const items = [...zoneEl.querySelectorAll(':scope > .hw')].filter((w) => w.dataset.w !== dragId);
    // Classic for loop: i counts from 0 up to the number of items.
    for (let i = 0; i < items.length; i++) {
      // The widget's rectangle on screen (top, bottom, left, right, width, height).
      const r = items[i].getBoundingClientRect();
      // Is it a half-width widget?
      const half = items[i].classList.contains('half');
      // If the mouse is above the widget's middle (and, for half-width widgets, not past its
      // right edge), the drop goes before this widget.
      if (y < r.top + r.height / 2 && (!half || x < r.right)) return { i, el: items[i] };
      // For half-width widgets sitting side by side: if the mouse is within its height and on
      // its left half, also drop before it.
      if (half && y < r.bottom && x < r.left + r.width / 2) return { i, el: items[i] };
    }
    // Otherwise it goes at the end of the zone.
    return { i: items.length, el: null };
  };
  // Make every zone a drop target.
  el.querySelectorAll('.hz').forEach((zoneEl) => {
    // While dragging over the zone…
    zoneEl.addEventListener('dragover', (e) => {
      // Ignore drags that aren't one of our widgets (e.g. a file from your desktop).
      if (!dragId) return;
      // By default the browser refuses drops; preventDefault() says "yes, you can drop here".
      e.preventDefault();
      // Clear old highlights…
      el.querySelectorAll('.drop-before,.drop-end').forEach((x) => x.classList.remove('drop-before', 'drop-end'));
      // …work out the landing spot…
      const t = targetIndex(zoneEl, e.clientX, e.clientY);
      // …and highlight it: a line before the target widget, or at the end of the zone.
      (t.el || zoneEl).classList.add(t.el ? 'drop-before' : 'drop-end');
    });
    // When the widget is dropped on this zone…
    zoneEl.addEventListener('drop', (e) => {
      // Stop the browser's default drop behaviour (like opening a dropped link).
      e.preventDefault();
      // Not one of our widgets? Ignore.
      if (!dragId) return;
      // The zone's name ('top' / 'left' / 'right').
      const z = zoneEl.dataset.zone;
      // Where to insert. `const { i } = ...` is object destructuring: take just the i property.
      const { i } = targetIndex(zoneEl, e.clientX, e.clientY);
      // Keep the id, then reset dragId so the drag is over.
      const id = dragId;
      dragId = null;
      commit((L) => {
        // Where the widget came from (zone fz, index fi).
        const [fz, fi] = find(L, id);
        // Cut it out of its old zone; splice returns an array of removed items, we take the first.
        const [w] = L[fz].splice(fi, 1);
        // Insert it at position i in the new zone (splice(index, 0, item) inserts without deleting).
        // Math.min keeps the index from going past the end. Widgets in the top zone become full width.
        L[z].splice(Math.min(i, L[z].length), 0, z === 'top' ? { ...w, half: false } : w);
      });
    });
  });
}
