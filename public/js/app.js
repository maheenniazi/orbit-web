/*
 * app.js — the "shell" and router of orbit. This is the first file the browser runs
 * (index.html loads it with <script type="module">), and it decides which page to show.
 *
 * How it fits in:
 *  - Every page of the app (dashboard, calendar, syllabus import, notes, …) lives in its own
 *    file and exports a render(el) function. This file imports them all and keeps a lookup
 *    table ("routes") from a page name to its module.
 *  - Hash routing: the part of the URL after "#" (e.g. "#/calendar") never reloads the page.
 *    When it changes the browser fires a "hashchange" event; we listen for it, clear the
 *    <main id="view"> box and ask the right module to draw itself inside it.
 *  - "Chrome" = the parts around the page (theme colours, the focus-phase pill, the mini timer).
 *    These are refreshed whenever the saved data (the store) changes.
 *  - DOM = the browser's live tree of HTML elements. We grab elements with
 *    document.getElementById / querySelector and change them (e.g. .innerHTML = new HTML).
 */
// App shell: routing, theme, focus-mode palette, sidebar widgets.
// "import" pulls named things out of other files (ES modules). store = the app's saved data.
import { store } from './store.js';
// loadStatus asks the server (/api/status) what features are available (e.g. whether AI is set up).
import { loadStatus } from './ai.js';
// APP_NAME is the string 'orbit'; esc() makes text safe to put inside HTML (turns < into &lt; etc.).
import { APP_NAME, esc } from './util.js';
// Focus-mode helpers: current phase, auto study plans, and the pomodoro timer.
import { getFocusState, syncStudyPlans, onTimer, getTimer, fmtClock } from './focus.js';
// Spotify: finish the login redirect, and load a playlist into the little player dock.
import { handleCallback, loadDock } from './spotify.js';
// "import * as X" grabs EVERYTHING a file exports as one object, so X.render is that page's render function.
import * as dashboard from './dashboard.js';
import * as calendar from './calendar.js';
import * as syllabus from './syllabus.js';
import * as notes from './notes.js';
import * as chat from './chat.js';
import * as focus from './focus.js';
import * as settings from './settings.js';
import * as careers from './careers.js';
import * as degree from './degree.js';
// autoPrep builds cheat sheets / practice tests for exams that are coming up soon.
import { autoPrep } from './examprep.js';
// startSelects swaps plain <select> dropdowns for nicer themed ones across the whole app.
import { startSelects } from './cselect.js';

// The route table: page name in the URL -> page module.
// `{ dashboard, calendar }` is shorthand for `{ dashboard: dashboard, calendar: calendar }`.
// "import: syllabus" means the URL "#/import" shows the syllabus module.
const routes = { dashboard, calendar, import: syllabus, notes, chat, focus, degree, careers, settings };
// The <main id="view"> element in index.html — every page is drawn inside this box.
const viewEl = document.getElementById('view');
// Some pages return a "cleanup" function from render() (e.g. to stop timers). We remember it
// here so we can call it before switching to a different page. `let` = a variable we can reassign.
let cleanup = null;

/*
 * route() — shows the page that matches the current URL hash.
 * Inputs: none (reads location.hash, e.g. "#/calendar").
 * Returns: nothing; it replaces the contents of viewEl.
 */
function route() {
  // Work out the page name from the hash:
  //  - regex /^#\/?/ means "at the very start (^), a '#' optionally followed by a '/'" — we remove it,
  //    so "#/calendar/xyz" becomes "calendar/xyz";
  //  - .split('/')[0] keeps only the first piece ("calendar");
  //  - `|| 'dashboard'` uses dashboard when the hash is empty.
  const name = (location.hash.replace(/^#\/?/, '').split('/')[0] || 'dashboard');
  // Look up the module; if the name is unknown (a typo in the URL), fall back to the dashboard.
  const mod = routes[name] || dashboard;
  // If the previous page left a cleanup function, run it so it stops whatever it was doing.
  if (typeof cleanup === 'function') cleanup();
  // Empty the view box (setting innerHTML to '' deletes all the old page's elements).
  viewEl.innerHTML = '';
  // "zen" is a distraction-free look used only by the focus page; remove it on every other page.
  if (name !== 'focus') document.body.classList.remove('zen');
  // Draw the new page inside the view box, and store whatever cleanup function it hands back.
  cleanup = mod.render(viewEl);
  // Highlight the matching sidebar link: for every <a> in .nav, add the "active" class if its
  // data-route="..." attribute equals the page name, otherwise remove it.
  // `(a) => ...` is an arrow function: a short way to write function (a) { return ...; }.
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  // Jump back to the top of the window, like a normal page load would.
  window.scrollTo(0, 0);
}

// Remembers the last focus mode we saw, so we only change the music when the mode actually changes.
let lastFocusKey = null;
/*
 * applyChrome() — refreshes the parts around the page: colour theme, focus-phase colours,
 * the "phase" pill in the sidebar, and the Spotify playlist for the current phase.
 * Inputs: none (reads the store and the focus state). Returns: nothing.
 * It is called on startup and every time the store changes (see store.subscribe in boot()).
 */
function applyChrome() {
  // s = the whole saved app state (courses, events, settings, …).
  const s = store.get();
  // f = { mode, exam, days, … } — which focus phase we're in and the next exam that caused it.
  const f = getFocusState();
  // Setting dataset.theme writes data-theme="light"/"dark" on <html>; the CSS uses it to pick colours.
  document.documentElement.dataset.theme = s.settings.theme;
  // Same idea for the focus phase: data-focus="chill"/"lockin"/… on <body> lets CSS restyle the app.
  document.body.dataset.focus = f.mode.key;
  // Fill the sidebar "focus pill" with HTML built from a template literal (a `backtick` string
  // where ${...} inserts a value). It shows:
  //  - a small "phase" label and the mode's name in bold (e.g. "eclipse");
  //  - only if there IS a next exam (f.exam ? ... : ''): a small line with the exam title and
  //    either "today" (0 days left) or e.g. "3d" (3 days left). The inner `${f.days}d` is a
  //    template literal nested inside another one.
  // esc() is used on text so a title like "<b>" can't break the HTML.
  document.getElementById('focus-pill').innerHTML =
    `<small>phase</small><b>${esc(f.mode.label)}</b>${f.exam ? `<small>${esc(f.exam.title)} · ${f.days === 0 ? 'today' : `${f.days}d`}</small>` : ''}`;
  // When the mode escalates, switch the soundtrack to match.
  // Only do this if the mode is different from last time (avoids reloading the player constantly).
  if (f.mode.key !== lastFocusKey) {
    // Remember the new mode.
    lastFocusKey = f.mode.key;
    // Each mode names a playlist slot (e.g. 'lockin'); look up its Spotify id in settings and load it.
    // `?.` is optional chaining: if that playlist slot doesn't exist, give undefined instead of crashing.
    loadDock(s.settings.playlists[f.mode.playlist]?.id);
  }
}

/*
 * paintMiniTimer(t) — updates the small pomodoro timer in the sidebar and the browser tab title.
 * Input: t = the timer object from focus.js ({ phase, running, remaining, total, … }; times in seconds).
 * Returns: nothing.
 */
function paintMiniTimer(t) {
  // The sidebar element <div id="mini-timer">.
  const el = document.getElementById('mini-timer');
  // The timer counts as "active" if it is running, OR it was started and paused part-way
  // (there is a total length and less than that is remaining).
  const active = t.running || (t.total && t.remaining < t.total);
  // Hide the mini timer if it isn't active, or if we're already on the focus page (which shows the big timer).
  el.hidden = !active || location.hash.startsWith('#/focus');
  // If it's visible, write e.g. "focus · 24:13" or "break · 04:59 · paused".
  // fmtClock turns seconds into "mm:ss".
  if (!el.hidden) el.innerHTML = `${t.phase === 'work' ? 'focus' : 'break'} · ${fmtClock(t.remaining)}${t.running ? '' : ' · paused'}`;
  // While running, show the countdown in the browser tab title ("24:13 · orbit"); otherwise just "orbit".
  document.title = t.running ? `${fmtClock(t.remaining)} · ${APP_NAME}` : APP_NAME;
}

/*
 * boot() — starts the whole app once: sets up widgets, loads server status, wires up events,
 * and shows the first page.
 * Inputs: none. Returns: a Promise (because it is `async`), which nobody waits for.
 * `async` lets us use `await`, which pauses this function until a slow task (like a network request) finishes.
 */
async function boot() {
  // Spotify rejects "localhost" redirect URIs, and data is stored per address,
  // so always use 127.0.0.1.
  // (localStorage is separate for "localhost" and "127.0.0.1", so mixing them would "lose" your data.)
  if (location.hostname === 'localhost') {
    // Reload the same URL but with 127.0.0.1; replace() means the Back button won't return to the localhost version.
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    // Stop here — the page is about to reload anyway.
    return;
  }
  startSelects(); // themed dropdowns everywhere
  // Put the app name ("orbit") into the sidebar brand. textContent sets plain text (no HTML).
  document.getElementById('brand-name').textContent = APP_NAME;
  // Clicking the mini timer takes you to the focus page (changing the hash triggers route()).
  document.getElementById('mini-timer').onclick = () => (location.hash = '#/focus');
  // Ask the server what's available (AI etc.) and wait for the answer before continuing.
  await loadStatus();
  // If Spotify just sent us back to /callback after logging in, finish the login first.
  if (location.pathname === '/callback') await handleCallback();
  // Create study-session events before each exam, without showing a popup message.
  // `{ silent: true }` passes an "options object" — a common way to give named settings.
  syncStudyPlans({ silent: true });
  // Draw the theme / focus pill once now…
  applyChrome();
  // …and again every time the saved data changes (store calls applyChrome after each update).
  store.subscribe(applyChrome);
  // Every time the pomodoro timer ticks or changes, repaint the mini timer.
  onTimer(paintMiniTimer);
  // When the URL hash changes (user clicked a nav link, or pressed Back), show the new page
  // and update the mini timer (it hides itself on the focus page).
  window.addEventListener('hashchange', () => { route(); paintMiniTimer(getTimer()); });
  // Re-evaluate focus mode at midnight / when returning to the tab
  // "visibilitychange" fires when you switch tabs; if the tab is visible again, refresh the
  // chrome (the day may have changed) and build any exam prep that's now due.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { applyChrome(); autoPrep(); } });
  // Show the first page, based on whatever hash the URL started with.
  route();
  setTimeout(autoPrep, 1500); // build exam prep for exams coming up (after the page is ready)
  // Also check for exam prep once every hour (60 min × 60 s × 1000 ms).
  setInterval(autoPrep, 60 * 60 * 1000);
}

// Start the app.
boot();
