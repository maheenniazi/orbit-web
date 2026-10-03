/*
 * store.js — the app's memory. ALL your data (courses, calendar events, notes, chat, careers,
 * degree plan, settings) lives in one big JavaScript object called `state`.
 *
 * "Local-first": there is no database or account. The state is saved in the browser's
 * localStorage (a small key/value storage that survives reloads) as one JSON string.
 *
 * How other files use it:
 *   - store.get()            -> read the current state.
 *   - store.update(fn)       -> change the state: fn receives the state and edits it; then we save
 *                               it and notify everyone.
 *   - store.subscribe(fn)    -> "call fn whenever the state changes" (this is pub/sub:
 *                               publish/subscribe). Screens use it to redraw themselves.
 *   - plus helpers: getCourse, ensureCourse, courseColor, addEvents, removeEvents.
 *
 * Beginner terms:
 *   - JSON.stringify(obj) turns an object into text; JSON.parse(text) turns it back.
 *   - Spread `...obj` copies all properties of obj into a new object; later ones win on conflicts.
 *   - Set: a list without duplicates (here: the subscriber functions).
 */
// Local-first state persisted to localStorage, with pub/sub.
// Import the random-id generator from util.js.
import { uid } from './util.js';

// The localStorage key the whole state is saved under. "v1" = version 1 of the data format.
const KEY = 'studyos:v1';

// Earthy "vintage" palette: terracotta, sage, dusty navy, mustard, mauve, cocoa, teal, rose
// New courses get the next color from this list (see ensureCourse below).
export const COURSE_COLORS = ['#c0582f', '#6f7f4f', '#3f5a78', '#b98a2e', '#a0526b', '#7a5c45', '#4f7d74', '#c27c86'];
// Canadian employers with public job boards (verified slugs): Cohere, Ada, Faire (Waterloo/Toronto), U of T PEY co-op board
// Format "system:company", comma-separated — jobs.js (fetchBoard) understands this.
const CA_BOARDS = 'ashby:cohere, greenhouse:ada18, greenhouse:faire, greenhouse:uoft';
// The old default board list. If saved data still has exactly this, load() swaps in CA_BOARDS.
const OLD_BOARDS = 'greenhouse:figma, greenhouse:airbnb, lever:palantir, ashby:ramp';
// The old neon course colors. load() replaces each with the color at the same position in COURSE_COLORS.
const OLD_COLORS = ['#a78bfa', '#f472b6', '#60a5fa', '#34d399', '#fbbf24', '#fb7185', '#22d3ee', '#c084fc'];

// Default Spotify playlists for each focus mode (the id is the playlist's id from its Spotify URL).
export const DEFAULT_PLAYLISTS = {
  chill: { name: 'Lofi Beats', id: '37i9dQZF1DWWQRwui0ExPn' },
  rampup: { name: 'Deep Focus', id: '37i9dQZF1DWZeKCadgRdKQ' },
  lockin: { name: 'Brain Food', id: '37i9dQZF1DWXLeA8Omikj7' },
  examday: { name: 'Peaceful Piano', id: '37i9dQZF1DX4sWSpwq3LiO' },
};

/*
 * defaults() — builds a brand-new, empty state object (what a first-time user starts with).
 * Input: none. Returns: a fresh object.
 * It's a function (not a constant) so every call gives a NEW object — editing one copy
 * can't accidentally change another. `() => ({ ... })`: the parentheses around { } tell
 * JavaScript we're returning an object, not starting a function body.
 * The comments after each field show what one item in that list looks like.
 */
const defaults = () => ({
  courses: [], // {id, name, code, color}
  events: [], // {id, title, courseId, type, date, time, notes, source, examId, done}
  notes: [], // {id, title, courseId, body, createdAt, updatedAt}
  chat: [], // {role, content, ts}
  focusLog: [], // {date, minutes}
  // Everything for the careers section.
  careers: {
    // Your info used to fill in resumes/cover letters and filter jobs (workAuth = work authorization).
    profile: { name: '', email: '', phone: '', location: '', links: '', school: '', degree: '', gradDate: '', gpa: '', workAuth: 'citizen', targetRoles: '', skills: '', locations: '', extra: '' },
    resume: '', // default resume, plain text/markdown
    saved: [], // {id, company, title, url, locations, terms, type, status, deadline, notes, savedAt}
    docs: [], // {id, kind, company, title, body, notes, jobUrl, createdAt}
    // Which company job boards to search (see CA_BOARDS above).
    boards: CA_BOARDS,
    // Last-used job search filters (null = none yet).
    filters: null,
  },
  // Everything for the degree planner.
  degree: {
    school: '',
    program: '', // e.g. "Honours BSc, Psychology Major"
    totalCredits: 0, // credits needed to graduate
    unit: 'credits', // what the school calls them: credits / units / FCEs
    defaultCredit: 0.5, // credit value of a typical one-term course
    links: '', // program requirement pages, one per line
    requirements: [], // {id, name, type: total|courses|choose|manual, min, unit: credits|courses, courses: [], note, overlap, done}
    years: [], // {id, label, open, courses: [{id, code, title, credits, term, grade, status: completed|in-progress|planned|failed|dropped}]}
    stream: '', // chosen stream / admission category, e.g. "CMP1"
    streams: [], // [{name, description, totalCredits, requirements}] when a program has several
    questions: [], // [{question, options}] follow-ups that change requirements
    // Your answers to those questions.
    answers: {},
    // When requirements were last checked (a timestamp in ms; 0 = never).
    checkedAt: 0,
    sources: [], // where requirements came from
  },
  // App preferences.
  settings: {
    // Color theme.
    theme: 'light',
    // Marks that this data already uses the newer "orbit" look (see the migration in load()).
    orbitTheme: true,
    // Your name (for greetings).
    name: '',
    // Automatically pick a focus mode based on what's coming up.
    autoFocus: true,
    focusOverride: null, // null = automatic, or a mode key
    // Automatically schedule study sessions on the calendar before exams.
    autoStudyPlan: true,
    autoPrep: true, // make a cheat sheet + practice test before exams
    // How many days before an exam the cheat sheet + practice test are made.
    prepDays: 5,
    // Playlists per focus mode.
    playlists: DEFAULT_PLAYLISTS,
  },
});

/*
 * load() — read the saved state from localStorage (or start fresh).
 * Input: none. Returns: a complete state object.
 * It also "migrates" old saved data (updates old formats/colors) and fills in any fields
 * that were added to defaults() after the data was saved.
 */
function load() {
  // try/catch: if anything goes wrong (e.g. the saved text is corrupted), we jump to `catch`.
  try {
    // Get the saved text and parse it. If nothing was saved, getItem gives null and JSON.parse(null) is null.
    const raw = JSON.parse(localStorage.getItem(KEY));
    // Nothing saved yet -> start with defaults.
    if (!raw) return defaults();
    // A fresh default object to merge with, so missing fields get default values.
    const d = defaults();
    // One-time switch to the new paper theme for data saved before the orbit redesign
    // Object.assign copies the given properties onto raw.settings.
    if (raw.settings && !raw.settings.orbitTheme) Object.assign(raw.settings, { theme: 'light', orbitTheme: true });
    // If the job boards are still the old default list, replace them with the Canadian list.
    // `?.` = optional chaining: if raw.careers is missing, this just gives undefined instead of crashing.
    if (raw.careers?.boards === OLD_BOARDS) raw.careers.boards = CA_BOARDS;
    // Swap neon course colors from the old theme for the new palette
    // `(raw.courses || [])` uses an empty list if there are no courses.
    (raw.courses || []).forEach((c) => {
      // Where this course's color is in the old list (-1 if it's not an old color).
      const i = OLD_COLORS.indexOf(c.color);
      // If it was an old color, use the new color at the same position.
      if (i >= 0) c.color = COURSE_COLORS[i];
    });
    // Build the final state by merging defaults with saved data using spread (`...`).
    // Saved values override defaults because they come later.
    return {
      // Start with all default top-level fields…
      ...d,
      // …then overwrite with everything that was saved.
      ...raw,
      // Nested objects need their own merge, or a saved `settings` would fully replace the defaults
      // (losing any newly added setting). Same for playlists inside settings.
      settings: { ...d.settings, ...raw.settings, playlists: { ...d.settings.playlists, ...(raw.settings?.playlists || {}) } },
      // Same idea for careers and its profile.
      careers: { ...d.careers, ...(raw.careers || {}), profile: { ...d.careers.profile, ...(raw.careers?.profile || {}) } },
      // And the degree planner.
      degree: { ...d.degree, ...(raw.degree || {}) },
    };
  } catch {
    // Corrupted/unreadable data: start fresh rather than breaking the app.
    return defaults();
  }
}

// The live state, loaded once when this file first runs. `let` because reset/import replace it.
let state = load();
// The set of subscriber functions to call after every change.
const subs = new Set();

// The public "store" object other files import. Each property is a function (method).
export const store = {
  // get(): return the current state object.
  get: () => state,
  /*
   * update(mutator) — the ONE way screens should change data.
   * Input: a function that receives the state and changes it directly.
   * Then: save to localStorage and tell every subscriber. Returns nothing.
   * Example: store.update((s) => { s.notes.push(newNote); });
   */
  update(mutator) {
    // Let the caller make their changes.
    mutator(state);
    // Save the whole state as JSON text.
    localStorage.setItem(KEY, JSON.stringify(state));
    // Notify every subscriber, passing the new state.
    subs.forEach((fn) => fn(state));
  },
  /*
   * subscribe(fn) — ask to be called on every change.
   * Input: a function. Returns: an "unsubscribe" function that stops the notifications.
   */
  subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  // reset(): erase everything and go back to defaults (saved and broadcast like update).
  reset() {
    state = defaults();
    localStorage.setItem(KEY, JSON.stringify(state));
    subs.forEach((fn) => fn(state));
  },
  // export(): the state as nicely indented JSON text (2 spaces) — used for backup downloads.
  export: () => JSON.stringify(state, null, 2),
  /*
   * import(json) — replace the state with data from a backup file.
   * Input: JSON text. Merges it with defaults (like load() does) so missing fields are filled in.
   * Throws if the text isn't valid JSON.
   */
  import(json) {
    // Fresh defaults to merge with.
    const d = defaults();
    // Turn the text into an object.
    const parsed = JSON.parse(json);
    // Merge top-level fields, then settings, careers (+ profile) and degree separately, same as load().
    state = { ...d, ...parsed, settings: { ...d.settings, ...parsed.settings }, careers: { ...d.careers, ...(parsed.careers || {}), profile: { ...d.careers.profile, ...(parsed.careers?.profile || {}) } }, degree: { ...d.degree, ...(parsed.degree || {}) } };
    // Save and notify.
    localStorage.setItem(KEY, JSON.stringify(state));
    subs.forEach((fn) => fn(state));
  },
};

// ---- domain helpers ----
/*
 * getCourse(id) — find a course by its id.
 * Returns: the course object, or undefined if not found.
 */
export function getCourse(id) {
  // .find returns the first item where the arrow function returns true.
  return state.courses.find((c) => c.id === id);
}

/*
 * ensureCourse(name, code) — get the id of a course, creating it if it doesn't exist yet.
 * Inputs: course name (e.g. "Intro Psychology") and optional code (e.g. "PSY100").
 * Returns: the course id, or null if both name and code are empty.
 * Used e.g. when importing a syllabus, so the same course isn't added twice.
 */
export function ensureCourse(name, code = '') {
  // The text we'll match on: prefer the code, else the name; lowercase so "PSY100" equals "psy100".
  const key = (code || name || '').trim().toLowerCase();
  // Nothing to match on -> can't make a course.
  if (!key) return null;
  // Look for an existing course that matches: its code equals the key, OR its name equals the key,
  // OR (if a code was given) its code equals that code.
  let c = state.courses.find(
    (x) => (x.code && x.code.toLowerCase() === key) || x.name.toLowerCase() === key || (code && x.code.toLowerCase() === code.toLowerCase())
  );
  // Found one -> just return its id.
  if (c) return c.id;
  // Otherwise make a new id…
  const id = uid();
  // …and add the course. Color: cycle through COURSE_COLORS using the remainder (%)
  // of the course count, so the 9th course reuses the 1st color.
  store.update((s) => {
    s.courses.push({ id, name: name || code, code: code || '', color: COURSE_COLORS[s.courses.length % COURSE_COLORS.length] });
  });
  return id;
}

/*
 * courseColor(id) — the color for a course.
 * Returns: the course's color, or the CSS accent color variable if the course doesn't exist.
 */
export function courseColor(id) {
  return getCourse(id)?.color || 'var(--accent)';
}

/*
 * addEvents(list) — add several calendar events at once (one save + one notification).
 * Input: an array of partial event objects. Returns: an array of their ids.
 */
export function addEvents(list) {
  // Collect the ids to return.
  const ids = [];
  store.update((s) => {
    for (const e of list) {
      // Keep an existing id, or make a new one.
      const id = e.id || uid();
      ids.push(id);
      // Default values first, then `...e` copies the given fields over them (so given values win).
      s.events.push({ id, title: 'Untitled', type: 'other', time: '', notes: '', source: 'manual', done: false, ...e });
    }
  });
  return ids;
}

/*
 * removeEvents(ids) — delete events by id, and also any events linked to them via examId
 * (e.g. study sessions created for an exam get removed with that exam).
 * Input: an array of ids. Returns: nothing.
 */
export function removeEvents(ids) {
  // A Set makes "is this id in the list?" checks fast.
  const set = new Set(ids);
  store.update((s) => {
    // Keep only events whose own id AND examId are not in the set.
    s.events = s.events.filter((e) => !set.has(e.id) && !set.has(e.examId));
  });
}
