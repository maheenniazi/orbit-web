/*
 * focus.js — the Focus page and the "brain" behind focus phases and the pomodoro timer.
 *
 * 1. FOCUS PHASES. The app looks at your next exam and counts the days until it. The closer it is,
 *    the more intense the phase: drift (no exam within 2 weeks) → rising (≤14 days) → gravity (≤7)
 *    → eclipse (≤3) → liftoff (exam day). Each phase has its own timer lengths, playlist and message.
 *    You can also pick a phase by hand ("manual override"). app.js uses getFocusState() to recolour
 *    the whole app per phase.
 * 2. STUDY PLANS. For each upcoming exam, syncStudyPlans() can add study sessions to the calendar
 *    10, 7, 5, 3, 2 and 1 day(s) before it.
 * 3. POMODORO TIMER. Work for N minutes, break for M, repeat. setInterval(fn, 500) runs tick()
 *    every half second. But we don't trust those ticks to count time (browsers slow timers down in
 *    background tabs), so instead we store the exact end moment (endAt = Date.now() + time left)
 *    and each tick computes "time left = endAt − now". Date.now() = milliseconds since 1970.
 *    The timer lives at the top level of this file (not inside the page), so it keeps running
 *    when you switch pages; app.js shows a mini timer in the sidebar via onTimer().
 * 4. render(el) draws the Focus page: the ring timer, phase picker, next exam, today's tasks,
 *    focus-time stats and the Spotify panel.
 */

// Original note from the author:
// Focus modes: automatic escalation as exams approach, study-plan generation, pomodoro timer.

// store = saved app data; addEvents = add calendar events; courseColor/getCourse = course lookups.
import { store, addEvents, courseColor, getCourse } from './store.js';
// Date and text helpers: EXAM_TYPES = ['exam', 'midterm', 'final']; todayISO() = today as "YYYY-MM-DD";
// addDays(date, n); daysUntil(date); fmtDate = pretty date; esc = HTML-safe text; pad(5) = "05".
// (TYPE_META is imported but not used in this file.)
import { EXAM_TYPES, todayISO, addDays, daysUntil, fmtDate, esc, pad, TYPE_META } from './util.js';
// toast() shows a small popup message.
import { toast } from './ui.js';
// renderSpotify draws the music panel.
import { renderSpotify } from './spotify.js';
// Exam-prep helpers: makePrep builds a cheat sheet + practice test; prepFor(examId) lists the prep notes
// already made for an exam; courseNotes(courseId) lists a course's normal (non-prep) notes.
import { makePrep, prepFor, courseNotes } from './examprep.js';

// The five focus phases. Each has: key (its id), label (name shown to the user), work and brk
// (pomodoro minutes for focus and break), playlist (which saved playlist slot to play), and blurb (the advice text).
export const MODES = {
  // No exam within two weeks: 25 min work / 5 min break (the classic pomodoro).
  chill: { key: 'chill', label: 'drift', work: 25, brk: 5, playlist: 'chill',
    blurb: 'no exams in sight. stay on top of readings and assignments, and keep it soft.' },
  // Exam within 14 days.
  warmup: { key: 'warmup', label: 'rising', work: 30, brk: 5, playlist: 'chill',
    blurb: 'an exam is coming up within two weeks. gather your notes and list every topic.' },
  // Exam within 7 days.
  rampup: { key: 'rampup', label: 'gravity', work: 45, brk: 10, playlist: 'rampup',
    blurb: 'under a week out. daily sessions, practice problems, flashcards. main character energy.' },
  // Exam within 3 days.
  lockin: { key: 'lockin', label: 'eclipse', work: 50, brk: 10, playlist: 'lockin',
    blurb: '1–3 days left. the lights go down, distractions go away. long deep-work blocks and timed past exams.' },
  // Exam today: short, light sessions.
  examday: { key: 'examday', label: 'liftoff', work: 20, brk: 10, playlist: 'examday',
    blurb: 'light review only. eat something, drink water, breathe. you prepared for this.' },
};

/*
 * nextExam() — find the soonest exam that isn't over or marked done.
 * Inputs: none. Returns: that event object, or undefined if there are no upcoming exams.
 */
export function nextExam() {
  // Today as "YYYY-MM-DD". This format sorts correctly as plain text, so we can compare dates with >= and <.
  const today = todayISO();
  return store
    .get()
    // Keep only events that are an exam type, dated today or later, and not ticked off.
    // `(e) => ...` is an arrow function: a short function taking e (one event) and returning true/false.
    .events.filter((e) => EXAM_TYPES.includes(e.type) && e.date >= today && !e.done)
    // Sort by date + time (text like "2025-05-0109:00"); events with no time use ''. localeCompare
    // compares two strings and returns negative/zero/positive, which is what sort() needs.
    // [0] then takes the first (soonest) one.
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))[0];
}

/*
 * autoMode(days) — choose the phase key for a given number of days until the next exam.
 * Input: days (a number, or null/undefined when there's no exam). Returns: a key of MODES.
 */
export function autoMode(days) {
  // `== null` is true for both null and undefined: no exam -> drift.
  if (days == null) return 'chill';
  // Exam is today (or the date already passed today) -> liftoff.
  if (days <= 0) return 'examday';
  // 1–3 days -> eclipse.
  if (days <= 3) return 'lockin';
  // 4–7 days -> gravity.
  if (days <= 7) return 'rampup';
  // 8–14 days -> rising.
  if (days <= 14) return 'warmup';
  // Further away -> drift.
  return 'chill';
}

/*
 * getFocusState() — everything about the current focus phase in one object.
 * Inputs: none. Returns: { mode, auto, autoKey, exam, days }:
 *   mode = the active MODES entry; auto = true if chosen automatically (no manual override);
 *   autoKey = what automatic mode WOULD pick; exam = next exam (or undefined); days = days until it (or null).
 */
export function getFocusState() {
  // Destructuring: `const { settings } = obj` is short for `const settings = obj.settings`.
  const { settings } = store.get();
  // The soonest exam.
  const exam = nextExam();
  // Days until it, or null if there isn't one.
  const days = exam ? daysUntil(exam.date) : null;
  // If the "auto-escalate" setting is on, pick by days; if it's off, always drift.
  const auto = settings.autoFocus ? autoMode(days) : 'chill';
  // A manual choice (focusOverride) wins; otherwise use the automatic one.
  const key = settings.focusOverride || auto;
  // `exam, days` inside { } is shorthand for exam: exam, days: days.
  return { mode: MODES[key], auto: !settings.focusOverride, autoKey: auto, exam, days };
}

// ---- Study plan generation ----
// The study plan template: [days relative to the exam (negative = before), what to do that day].
const PLAN = [
  [-10, 'Gather materials & list every topic'],
  [-7, 'First-pass review of lectures & notes'],
  [-5, 'Practice problems on core topics'],
  [-3, 'Timed practice / past exam'],
  [-2, 'Weak spots + flashcards'],
  [-1, 'Light review, pack bag, sleep early'],
];

/*
 * syncStudyPlans({ silent }) — add PLAN study sessions to the calendar for every upcoming exam
 * that doesn't have any yet.
 * Input: an options object; silent = true means "don't show a popup". `{ silent = false } = {}` is
 *   destructuring with a default, and the `= {}` lets you call syncStudyPlans() with nothing at all.
 * Returns: how many sessions were added.
 */
export function syncStudyPlans({ silent = false } = {}) {
  // All saved data.
  const s = store.get();
  // Feature switched off in Settings -> add nothing.
  if (!s.settings.autoStudyPlan) return 0;
  // Today's date text.
  const today = todayISO();
  // A Set (a list with no duplicates and fast lookups) of exam ids that already have study sessions:
  // take events that have an examId (they were made for an exam), and keep just that examId.
  const planned = new Set(s.events.filter((e) => e.examId).map((e) => e.examId));
  // New events will be collected here and added all at once.
  const toAdd = [];
  // Look at every event…
  for (const ex of s.events) {
    // …skip it if it isn't an exam, is in the past, or already has a plan (`continue` = go to the next one).
    if (!EXAM_TYPES.includes(ex.type) || ex.date < today || planned.has(ex.id)) continue;
    // For each PLAN step, destructure the pair into off (day offset) and task (description).
    for (const [off, task] of PLAN) {
      // The study day's date, e.g. 7 days before the exam.
      const date = addDays(ex.date, off);
      // Don't schedule sessions in the past (e.g. the exam is only 3 days away).
      if (date < today) continue;
      // Queue a new calendar event:
      toAdd.push({
        // Title like "Study: Midterm 1" (template literal inserts the exam title).
        title: `Study: ${ex.title}`,
        // Event type "study".
        type: 'study',
        // Same course as the exam (so it gets the course colour).
        courseId: ex.courseId,
        // `date,` is shorthand for date: date.
        date,
        // The plan step's task goes in the notes.
        notes: task,
        // Marks it as made automatically.
        source: 'auto-plan',
        // Links it to the exam, so we know this exam is planned (and deleting the exam deletes these).
        examId: ex.id,
      });
    }
  }
  // If anything was queued…
  if (toAdd.length) {
    // …save them all in one go…
    addEvents(toAdd);
    // …and tell the user, unless asked to be silent.
    if (!silent) toast(`Scheduled ${toAdd.length} study sessions before your exams`);
  }
  // Report how many were added.
  return toAdd.length;
}

// ---- Pomodoro (module-level so it survives navigation) ----
// The one shared timer. phase: 'work' or 'brk' (break); running: counting down?;
// endAt: the moment (ms since 1970) it will hit zero; remaining: seconds left; total: the phase's
// full length in seconds; task: what you said you're working on; int: the setInterval id (to stop it).
const timer = { phase: 'work', running: false, endAt: 0, remaining: 0, total: 0, task: '', int: null };
// Functions that want to hear about every timer update (the Focus page, the sidebar mini timer).
const timerSubs = new Set();
// onTimer(fn): subscribe fn to timer updates. Uses the comma operator: (a, b) runs a, then gives b.
// So it adds fn, then returns an "unsubscribe" function that removes it again.
export const onTimer = (fn) => (timerSubs.add(fn), () => timerSubs.delete(fn));
// emit(): call every subscriber with the timer object.
const emit = () => timerSubs.forEach((fn) => fn(timer));

/*
 * lengths() — the current phase's pomodoro lengths, converted from minutes to seconds.
 * Inputs: none. Returns: { work, brk } in seconds.
 */
function lengths() {
  // The active focus mode, e.g. MODES.rampup.
  const m = getFocusState().mode;
  // Minutes × 60 = seconds.
  return { work: m.work * 60, brk: m.brk * 60 };
}
/*
 * resetTimer(phase) — stop the timer and set it back to the full length of a phase.
 * Input: phase = 'work' (default) or 'brk'. Returns: nothing.
 */
export function resetTimer(phase = 'work') {
  // Stop any running interval (does nothing if none).
  clearInterval(timer.int);
  // Lengths for the current focus mode.
  const L = lengths();
  // Object.assign copies these fields onto timer: the new phase, paused, and the full time for that phase.
  Object.assign(timer, { phase, running: false, remaining: phase === 'work' ? L.work : L.brk });
  // The full length is what we're starting from.
  timer.total = timer.remaining;
  // Tell subscribers (so the screen updates).
  emit();
}
/*
 * toggleTimer() — start the timer if it's paused, pause it if it's running.
 * Inputs: none. Returns: nothing.
 */
export function toggleTimer() {
  // Never set up yet (total is 0)? Set it up first.
  if (!timer.total) resetTimer();
  // Currently running -> pause:
  if (timer.running) {
    timer.running = false;
    // Freeze the time left: (end moment − now) in ms, ÷1000 for seconds, rounded, never below 0.
    timer.remaining = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
    // Stop ticking.
    clearInterval(timer.int);
  // Currently paused -> start:
  } else {
    timer.running = true;
    // Work out when it should end: now + the seconds left (×1000 for ms).
    timer.endAt = Date.now() + timer.remaining * 1000;
    // If the browser supports notifications and the user hasn't answered yet, ask permission
    // (so we can notify when a session ends, even if the tab is in the background).
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    // Run tick() every 500 ms. setInterval returns an id we keep so we can stop it later.
    timer.int = setInterval(tick, 500);
  }
  // Update the screen.
  emit();
}
/*
 * tick() — runs every half second while the timer runs: updates the time left and handles
 * the end of a phase. Inputs/returns: none.
 */
function tick() {
  // Seconds left, computed from the end moment (accurate even if ticks were delayed).
  timer.remaining = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
  // Time's up:
  if (timer.remaining <= 0) {
    // Which phase just ended.
    const finished = timer.phase;
    // A finished focus session gets logged for the stats.
    if (finished === 'work') {
      // Length in whole minutes.
      const mins = Math.round(timer.total / 60);
      // Save { date, minutes, task } into focusLog.
      store.update((s) => s.focusLog.push({ date: todayISO(), minutes: mins, task: timer.task }));
    }
    // Popup + system notification + beep.
    notify(finished === 'work' ? 'session done. go take a break' : 'break’s over. back to it');
    // Switch to the other phase (paused, ready to start).
    resetTimer(finished === 'work' ? 'brk' : 'work');
    // resetTimer already told subscribers, so we're done.
    return;
  }
  // Still counting: update the screen.
  emit();
}
/*
 * notify(msg) — tell the user a phase ended: a toast, a system notification (if allowed), and two beeps.
 * Input: msg = the message text. Returns: nothing.
 */
function notify(msg) {
  // In-app popup.
  toast(msg);
  // Sound/notifications can fail (unsupported browser, blocked audio), so wrap them in try/catch.
  try {
    // Show a system notification titled "orbit" if the user allowed them.
    if ('Notification' in window && Notification.permission === 'granted') new Notification('orbit', { body: msg });
    // Create a Web Audio context (the browser's sound engine). Older Safari calls it webkitAudioContext.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Two beeps: the first starts at 0 s, the second 0.18 s later. i is 0 for the first and 1 for the second.
    [0, 0.18].forEach((delay, i) => {
      // An oscillator generates a pure tone.
      const o = ctx.createOscillator();
      // A gain node controls volume.
      const g = ctx.createGain();
      // First beep 660 Hz, second 880 Hz (higher) — `i ? a : b` because 0 counts as false.
      o.frequency.value = i ? 880 : 660;
      // Start almost silent (exponential ramps can't start from exactly 0).
      g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
      // Quickly (20 ms) fade up to volume 0.2 — avoids a harsh click.
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + delay + 0.02);
      // Then fade back down to near-silent by 0.5 s.
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.5);
      // Wire it up: tone -> volume -> speakers. (connect returns its target, so the calls can chain.)
      o.connect(g).connect(ctx.destination);
      // Start the tone at its scheduled time…
      o.start(ctx.currentTime + delay);
      // …and stop it just after the fade-out.
      o.stop(ctx.currentTime + delay + 0.55);
    });
  // If anything failed, just skip the sound.
  } catch { /* ignore */ }
}
// getTimer(): lets other files (app.js's mini timer) read the timer object.
export const getTimer = () => timer;
// fmtClock(s): seconds -> "MM:SS". Math.floor(s / 60) = whole minutes; s % 60 = leftover seconds
// (% is remainder); pad() adds a leading zero, e.g. 5 -> "05". So 125 -> "02:05".
export const fmtClock = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;

// ---- Stats ----
/*
 * focusStats() — total focus minutes today and over the last 7 days.
 * Inputs: none. Returns: { today, week } in minutes.
 */
export function focusStats() {
  // All logged focus sessions.
  const log = store.get().focusLog;
  // Today's date.
  const today = todayISO();
  // 6 days ago — together with today, that's a 7-day window.
  const weekAgo = addDays(today, -6);
  // sum(arr): add up the minutes of a list of sessions. reduce starts at 0 (a) and adds each b.minutes.
  const sum = (arr) => arr.reduce((a, b) => a + b.minutes, 0);
  // Sessions dated today, and sessions dated within the last 7 days.
  return { today: sum(log.filter((l) => l.date === today)), week: sum(log.filter((l) => l.date >= weekAgo)) };
}

// ---- View ----
/*
 * render(el) — draw the Focus page and keep it updated.
 * Input: el = the page box to draw into (given by app.js).
 * Returns: a cleanup function app.js calls when leaving the page (stops listening to the timer and store).
 */
export function render(el) {
  // draw(): rebuild the whole page. Arrow function + closure: it can use `el` from render().
  const draw = () => {
    // Saved data.
    const s = store.get();
    // Current phase info.
    const f = getFocusState();
    // Today's date.
    const today = todayISO();
    // Today's to-dos: events dated today, except regular classes.
    const tasks = s.events.filter((e) => e.date === today && e.type !== 'class');
    // Minutes focused today / this week.
    const stats = focusStats();
    // The timer object.
    const t = getTimer();
    // The ring's radius in SVG units (the drawing is 300×300, so the centre is at 150,150).
    const R = 132;
    // Build the page HTML (template literal; ${...} inserts values). Section by section:
    //  HEADER: "focus · set automatically/manual override", the phase name and blurb (escaped with esc),
    //    and a "zen mode" checkbox, pre-ticked if <body> already has the "zen" class.
    //  TIMER CARD: an SVG drawing with
    //    - a faint full circle ("track") of radius R;
    //    - the progress circle ("prog"). Trick: stroke-dasharray = the circle's circumference (2·π·R),
    //      so the outline is ONE dash as long as the whole circle; stroke-dashoffset then slides that
    //      dash along. paint() below changes the offset to show how much is done;
    //    - a "moon" group (glow + dot) placed at the circle's right edge (x = 150 + R), which paint()
    //      rotates around the centre (transform-origin 150px 150px);
    //    then the clock text ("MM:SS" — the time left, or the full work length if not started),
    //    and "focus"/"break" plus the work/break minutes.
    //    Below: the "what are you working on?" input, and start/pause, reset and skip buttons.
    //  PHASES CARD: one button per mode (Object.values gives the MODES objects); the active one gets
    //    class "on", and the one auto mode would pick says " · auto". If in manual mode, a
    //    "back to automatic" button.
    //  NEXT EXAM CARD (only if there is one): title, course name (getCourse(...)?.name, or '' if
    //    missing), long date in lowercase, and a big "N days" in the course colour. Then:
    //    - if prep notes exist: "open cheat sheet" (the cheatsheet note's id, or the first prep note's)
    //      and "practice test" (the practice note's id, or '' if missing) buttons;
    //    - else if the course has notes: a "make cheat sheet + practice test" button;
    //    - else: a hint to add notes.
    //  TODAY CARD: a checkbox row per task (course colour via --c, title, optional notes), or an
    //    "empty" message.
    //  FOCUS TIME CARD: minutes today; hours this week = Math.round(minutes / 6) / 10, which is
    //    minutes ÷ 60 rounded to one decimal; a progress bar = today's minutes out of a 180-minute
    //    (3 hour) goal, capped at 100%.
    //  SOUNDTRACK CARD: an empty <div id="spotify"> filled by renderSpotify() below.
    el.innerHTML = `
      <div class="page-head view-enter">
        <div>
          <div class="kicker">focus · ${f.auto ? 'set automatically' : 'manual override'}</div>
          <h1>phase: <em>${esc(f.mode.label)}</em></h1>
          <p>${esc(f.mode.blurb)}</p>
        </div>
        <label class="check small"><input type="checkbox" id="zen" ${document.body.classList.contains('zen') ? 'checked' : ''}> zen mode (hide sidebar)</label>
      </div>
      <div class="focus-layout view-enter">
        <div class="stack">
          <div class="card timer-card">
            <div class="ring">
              <svg width="300" height="300" viewBox="0 0 300 300">
                <circle class="track" cx="150" cy="150" r="${R}" fill="none" stroke-width="2"/>
                <circle class="prog" id="prog" cx="150" cy="150" r="${R}" fill="none" stroke-width="2.5" stroke-dasharray="${2 * Math.PI * R}" stroke-dashoffset="0"/>
                <g id="moon" style="transform-origin:150px 150px"><circle class="moon-halo" cx="${150 + R}" cy="150" r="13"/><circle class="moon" cx="${150 + R}" cy="150" r="7"/></g>
              </svg>
              <div class="label"><div><div class="time" id="clock">${fmtClock(t.remaining || f.mode.work * 60)}</div><div class="phase" id="phase">${t.phase === 'work' ? 'focus' : 'break'} · ${f.mode.work}/${f.mode.brk}</div></div></div>
            </div>
            <input id="task" placeholder="what are you working on?" value="${esc(t.task)}" style="max-width:360px;text-align:center;border-radius:99px">
            <div class="row">
              <button class="btn" id="toggle">${t.running ? 'pause' : 'start'}</button>
              <button class="btn ghost" id="reset">reset</button>
              <button class="btn ghost" id="skip">skip to ${t.phase === 'work' ? 'break' : 'focus'}</button>
            </div>
          </div>
          <div class="card">
            <h3>phases <span>${f.auto ? 'auto' : 'manual'}</span></h3>
            <div class="modes">
              ${Object.values(MODES).map((m) => `<button class="mode-opt ${m.key === f.mode.key ? 'on' : ''}" data-mode="${m.key}"><b>${m.label}</b><small>${m.work}/${m.brk} min${m.key === f.autoKey ? ' · auto' : ''}</small></button>`).join('')}
            </div>
            ${f.auto ? '' : '<button class="btn ghost sm" id="auto" style="margin-top:12px">back to automatic</button>'}
          </div>
        </div>
        <div class="stack">
          ${f.exam ? `<div class="card taped">
            <h3>next exam</h3>
            <div class="row spread"><div><div style="font-family:var(--serif);font-size:26px;line-height:1.1">${esc(f.exam.title)}</div><div class="muted small" style="margin-top:4px">${esc(getCourse(f.exam.courseId)?.name || '')} · ${fmtDate(f.exam.date, { weekday: 'long', month: 'long', day: 'numeric' }).toLowerCase()}</div></div>
            <div class="stat" style="color:${courseColor(f.exam.courseId)}">${f.days}<span class="small muted" style="font-family:var(--mono)"> days</span></div></div>
            <div class="row" style="margin-top:14px">${prepFor(f.exam.id).length
              ? `<button class="btn sm" data-open-prep="${prepFor(f.exam.id).find((n) => n.prep.kind === 'cheatsheet')?.id || prepFor(f.exam.id)[0].id}">open cheat sheet</button><button class="btn ghost sm" data-open-prep="${prepFor(f.exam.id).find((n) => n.prep.kind === 'practice')?.id || ''}">practice test</button>`
              : courseNotes(f.exam.courseId).length ? '<button class="btn sm" id="make-prep">make cheat sheet + practice test</button>' : '<span class="small muted">add notes for this course and you’ll get a cheat sheet + practice test</span>'}</div>
          </div>` : ''}
          <div class="card">
            <h3>today</h3>
            ${tasks.length ? `<div class="ev-list">${tasks.map((e) => `<label class="ev ${e.done ? 'done' : ''}" style="--c:${courseColor(e.courseId)}"><input type="checkbox" data-done="${e.id}" ${e.done ? 'checked' : ''}><span class="bar"></span><div><div class="t">${esc(e.title)}</div>${e.notes ? `<div class="s">${esc(e.notes)}</div>` : ''}</div><span></span></label>`).join('')}</div>` : '<div class="empty">nothing scheduled today. pick something from your calendar.</div>'}
          </div>
          <div class="card">
            <h3>focus time</h3>
            <div class="row" style="gap:34px"><div><div class="stat">${stats.today}</div><div class="small muted">min today</div></div><div><div class="stat">${Math.round(stats.week / 6) / 10}</div><div class="small muted">hrs this week</div></div></div>
            <div class="progress" style="margin-top:16px"><span style="width:${Math.min(100, (stats.today / 180) * 100)}%"></span></div>
            <div class="hand" style="margin-top:8px;font-size:19px">goal: 3 hrs a day</div>
          </div>
          <div class="card"><h3>soundtrack</h3><div id="spotify"></div></div>
        </div>
      </div>`;

    // Start/pause: first save what's typed in the task box, then toggle.
    el.querySelector('#toggle').onclick = () => { timer.task = el.querySelector('#task').value; toggleTimer(); };
    // Reset: back to the full length of the current phase.
    el.querySelector('#reset').onclick = () => resetTimer(t.phase);
    // Skip: jump to the other phase.
    el.querySelector('#skip').onclick = () => resetTimer(t.phase === 'work' ? 'brk' : 'work');
    // Typing in the task box saves it on the timer immediately (so it survives redraws).
    el.querySelector('#task').oninput = (e) => (timer.task = e.target.value);
    // Zen checkbox: add/remove the "zen" class on <body> (CSS hides the sidebar when it's there).
    el.querySelector('#zen').onchange = (e) => document.body.classList.toggle('zen', e.target.checked);
    // Phase buttons:
    el.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
      // The clicked phase's key (from data-mode="...").
      const k = b.dataset.mode;
      // Picking the phase auto mode would choose anyway clears the override (back to automatic);
      // anything else becomes the manual override.
      store.update((s) => (s.settings.focusOverride = k === f.autoKey ? null : k));
      // If the timer isn't running, reset it so it uses the new phase's lengths.
      if (!timer.running) resetTimer();
    }));
    // "back to automatic" button (only present in manual mode, hence `?.`): clear the override.
    el.querySelector('#auto')?.addEventListener('click', () => store.update((s) => (s.settings.focusOverride = null)));
    // Today's task checkboxes: find the matching event by id and save whether it's done.
    el.querySelectorAll('[data-done]').forEach((c) => (c.onchange = () =>
      store.update((s) => { const e = s.events.find((x) => x.id === c.dataset.done); if (e) e.done = c.checked; })));
    // Cheat sheet / practice test buttons: remember which note to open (sessionStorage lasts for this tab),
    // then go to the Notes page, which reads that value and opens the note.
    el.querySelectorAll('[data-open-prep]').forEach((b) => (b.onclick = () => { sessionStorage.setItem('studyos:open-note', b.dataset.openPrep); location.hash = '#/notes'; }));
    // "make cheat sheet + practice test": disable the button and show progress text, wait (`await`)
    // for makePrep to finish (it may call the AI, which takes a while), then redraw.
    el.querySelector('#make-prep')?.addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = 'making your prep…'; await makePrep(f.exam); draw(); });
    // Fill the soundtrack card with this phase's playlist.
    renderSpotify(el.querySelector('#spotify'), f.mode.playlist);
    // Set the ring and clock to the current timer state.
    paint(getTimer());
  };

  // paint(t): update ONLY the clock, ring, moon and start/pause label — cheap, so it can run every tick
  // without rebuilding the page (which would also wipe what you're typing in the task box).
  // Input: t = the timer object.
  const paint = (t) => {
    // The clock element.
    const clock = el.querySelector('#clock');
    // Page not drawn (or gone)? Nothing to paint.
    if (!clock) return;
    // Full phase length in seconds (fallback: the current mode's work length if the timer isn't set up).
    const total = t.total || getFocusState().mode.work * 60;
    // Seconds left (if not set up, show the full length).
    const rem = t.total ? t.remaining : total;
    // Show "MM:SS".
    clock.textContent = fmtClock(rem);
    // The ring's circumference: 2·π·132 (132 = R in draw()).
    const c = 2 * Math.PI * 132;
    // Fraction finished, from 0 (just started) to 1 (done).
    const done = 1 - rem / total;
    // Slide the dash: offset = c hides the whole stroke, offset = 0 shows all of it,
    // so c × (1 − done) makes the ring fill in as time passes.
    el.querySelector('#prog').style.strokeDashoffset = String(c * (1 - done));
    // Spin the moon around the centre: 0° at the start, 360° (a full lap) at the end.
    el.querySelector('#moon').style.transform = `rotate(${done * 360}deg)`;
    // Button label matches the state.
    el.querySelector('#toggle').textContent = t.running ? 'pause' : 'start';
  };

  // First visit and the timer was never set up: set it to a fresh work session.
  if (!timer.total) resetTimer();
  // Draw the page.
  draw();
  // Remember the timer's phase and running state, so we can tell when they change.
  let lastPhase = timer.phase;
  let lastRunning = timer.running;
  // Listen to the timer: if the phase or running state changed, rebuild the page (labels change);
  // otherwise just repaint the clock/ring. offT = the "stop listening" function.
  const offT = onTimer((t) => {
    if (t.phase !== lastPhase || t.running !== lastRunning) { lastPhase = t.phase; lastRunning = t.running; draw(); }
    else paint(t);
  });
  // Also redraw whenever saved data changes (e.g. a task ticked, a phase picked).
  const offS = store.subscribe(draw);
  // Cleanup for app.js: stop both subscriptions. (The timer itself keeps running.)
  return () => { offT(); offS(); };
}
