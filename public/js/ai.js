/*
 * ai.js — the browser's "phone line" to the AI.
 *
 * orbit can run two ways, and this file hides the difference from the rest of the app:
 *   1. LOCAL SERVER mode (`node server.js`): the browser calls OUR server, which holds the
 *      secret keys and talks to Kiro/OpenAI/Anthropic/Gemini (see server.js + ai-providers.js).
 *      This is the full-power version (Kiro, job search, file conversion, reading web pages).
 *   2. WEBSITE / "bring your own key" mode (e.g. hosted on GitHub Pages, no server): there is
 *      no /api, so each visitor pastes their own Anthropic/Gemini/OpenAI key in Settings and
 *      the browser calls those companies directly. That path lives in byoai.js.
 *
 * On startup, loadStatus() tries the server once. If the server answers, we use server mode.
 * If it doesn't (static website), we switch to "browser mode" and use byoai.js. Everything
 * below (loadModels, getModel, ask, …) routes to whichever mode is active, so chat.js,
 * notes.js, careers.js and degree.js don't need to know or care which one they're talking to.
 *
 * Beginner terms:
 *   - fetch(): the browser's built-in way to make an HTTP request; returns a Promise.
 *   - localStorage: a tiny key/value store in the browser that survives page reloads.
 *   - pub/sub: other files subscribe a function; when something changes we call them all.
 */
// byoai.js = the "bring your own key" browser-direct AI path (used in website mode).
import * as byo from './byoai.js';

// `status` = what we currently believe about AI. In server mode it comes from /api/status;
// in browser mode we build it from the keys the visitor saved. Starts "off" until we know.
let status = { ai: false, providers: [], provider: null, spotifyClientId: null, mode: 'unknown' };
// `catalog` = the list of available models + any errors + the default model id.
let catalog = { models: [], errors: {}, default: null };
// Remembers the in-flight/finished Promise for loading the catalog, so we only fetch it once.
let catalogLoaded = null;
// The localStorage key under which your chosen model id is saved.
const MODEL_KEY = 'studyos:model';
// Functions that want to be told when the model list or chosen model changes (the "subscribers").
const subs = new Set();

// True when we're in website mode (no server), so AI/models/ask use byoai.js directly.
// It's set by loadStatus(). Other modules can read it via isBrowserMode().
let browserMode = false;
export const isBrowserMode = () => browserMode;

/*
 * refreshBrowserStatus() — rebuild `status` from the keys saved in the browser.
 * Used in website mode (and after the Settings page adds/removes a key). Returns the status.
 */
export function refreshBrowserStatus() {
  const providers = byo.configuredProviders();
  status = {
    ai: providers.length > 0,
    providers,
    provider: providers[0] || null,
    // No server means no Spotify account login (needs a server-side client id) — embed player still works.
    spotifyClientId: null,
    // No server means no built-in job keys; website job search uses the free, no-key sources.
    webJobs: {},
    mode: 'browser',
  };
  return status;
}

/*
 * loadStatus() — work out which mode we're in and whether AI is set up.
 * Tries the server once; if that fails, falls back to browser (bring-your-own-key) mode.
 * Returns (a Promise of) the status object.
 */
export async function loadStatus() {
  try {
    // Try the local server. A short timeout so a static site doesn't hang waiting.
    const r = await fetch('/api/status', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('no server');
    const data = await r.json();
    // The server answered: we're in server mode.
    browserMode = false;
    status = { ...data, mode: 'server' };
  } catch {
    // No server (static website): switch to browser mode and build status from saved keys.
    browserMode = true;
    refreshBrowserStatus();
  }
  return status;
}
// Getter: returns the last-known status object (no network request).
export const getStatus = () => status;
// Shortcut: true if at least one AI provider is usable right now.
export const aiEnabled = () => status.ai;

/*
 * loadModels({ refresh }) — fetch the list of available AI models (once), from whichever
 * mode we're in. Returns a Promise resolving to the catalog { models, errors, default }.
 */
export function loadModels({ refresh = false } = {}) {
  // No AI configured? Nothing to load — return the current (empty) catalog.
  if (!status.ai) return Promise.resolve(catalog);
  // Already loading/loaded and not refreshing? Reuse the same Promise.
  if (catalogLoaded && !refresh) return catalogLoaded;
  // Browser mode: build the catalog with byoai.js (calls the AI companies directly).
  if (browserMode) {
    catalogLoaded = byo.catalog()
      .then((d) => { catalog = { models: d.models || [], errors: d.errors || {}, default: d.default }; subs.forEach((f) => f()); return catalog; })
      .catch(() => catalog);
    return catalogLoaded;
  }
  // Server mode: ask our server for the list.
  catalogLoaded = fetch('/api/models' + (refresh ? '?refresh=1' : ''))
    .then((r) => r.json())
    .then((d) => { catalog = { models: d.models || [], errors: d.errors || {}, default: d.default }; subs.forEach((f) => f()); return catalog; })
    .catch(() => catalog);
  return catalogLoaded;
}
// Getter: the current catalog (no network request).
export const getCatalog = () => catalog;
// Subscribe a function to model changes. Adds fn and returns an "unsubscribe" function.
export const onModelChange = (fn) => (subs.add(fn), () => subs.delete(fn));

/*
 * reloadForKeyChange() — called by Settings after the visitor adds/removes a browser key.
 * Rebuilds the status and the model catalog, and notifies subscribers so the picker updates.
 * Returns (a Promise of) the fresh catalog.
 */
export async function reloadForKeyChange() {
  if (!browserMode) return catalog; // server mode manages its own keys via .env
  refreshBrowserStatus();
  catalogLoaded = null; // force a fresh model fetch
  const c = await loadModels({ refresh: true });
  subs.forEach((f) => f());
  return c;
}

// The saved choice, if it's still available; otherwise the default.
export function getModel() {
  const saved = localStorage.getItem(MODEL_KEY);
  if (saved && (!catalog.models.length || catalog.models.some((m) => m.id === saved))) return saved;
  return catalog.default || saved || null;
}
export function setModel(id) {
  localStorage.setItem(MODEL_KEY, id);
  subs.forEach((f) => f());
}
/*
 * modelInfo(id) — display details for a model: { id, provider, model, label, providerLabel }.
 */
export function modelInfo(id = getModel()) {
  const m = catalog.models.find((x) => x.id === id);
  if (m) return m;
  if (!id) return { id: null, label: 'AI', providerLabel: '' };
  const [provider, ...rest] = id.split(':');
  return { id, provider, model: rest.join(':'), label: rest.join(':') || provider, providerLabel: provider };
}

/*
 * ask({ system, messages, maxTokens, model }) — send a prompt to the AI, via whichever mode
 * is active. Returns (a Promise of) the AI's reply text. Throws an Error if the request failed.
 */
export async function ask({ system, messages, maxTokens, model }) {
  const chosen = model || getModel();
  // Browser mode: call the AI company directly from byoai.js.
  if (browserMode) {
    const data = await byo.callAI({ system, messages, maxTokens, model: chosen });
    lastModel = data.model || null;
    return data.text;
  }
  // Server mode: POST to our server, which holds the keys.
  const r = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system, messages, maxTokens, model: chosen }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `AI request failed (${r.status})`);
  lastModel = data.model || null;
  return data.text;
}
// The model id that answered the most recent ask() call (null until the first one).
let lastModel = null;
// Getter so other files can read lastModel.
export const lastUsedModel = () => lastModel;
