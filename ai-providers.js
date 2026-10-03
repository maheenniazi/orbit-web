/*
 * ai-providers.js — everything about talking to AI models.
 *
 * Where it fits: the browser never talks to an AI company directly. It calls our server
 * (POST /api/ai, GET /api/models in server.js), and server.js uses this file to:
 *   - work out which AI "providers" are set up (Kiro, Anthropic, OpenAI, Google Gemini),
 *   - fetch the list of models each provider offers (the "catalog"),
 *   - send a conversation to the chosen model and return its reply as text.
 * Key terms:
 *   - API: a way for programs to talk to a service over the web, usually by sending and
 *     receiving JSON (text-formatted objects).
 *   - API key: a secret password for an API, kept in the .env file. It stays on the server.
 *   - CLI: a command-line program. Kiro is used through its CLI ("kiro-cli"), which we run
 *     as a separate program instead of calling a web API.
 *   - async/await and Promises: network calls take time; `await` waits for the result.
 */
// AI providers + model catalog (zero dependencies).
// Every provider with a key/CLI in .env is enabled at once; the browser picks a model per request.
// Model ids are "provider:modelId", e.g. "kiro:claude-opus-4.8", "gemini:gemini-2.5-pro".
// Built-in Node modules: fs = files, path = file paths.
const fs = require('fs');
const path = require('path');
// execFile runs another program (here, the Kiro CLI). { } pulls just that one function out
// of the module ("destructuring").
const { execFile } = require('child_process');

// Short name for the environment variables (settings loaded from .env by server.js).
const env = process.env;
// The command used to run Kiro: a custom path from .env, or just 'kiro-cli'.
const KIRO_CLI = env.KIRO_CLI_PATH || 'kiro-cli';
// The folder Kiro runs in; it contains .kiro/agents/study-os.json (the agent settings).
const KIRO_DIR = path.join(__dirname, 'kiro-agent');
// Name of the Kiro agent (a saved set of instructions/settings) to use.
const KIRO_AGENT = env.KIRO_AGENT || 'study-os';
const MAX_PROMPT = 100_000; // stay under the OS argument-length limit
// How long a fetched model list stays fresh: 10 minutes, in milliseconds.
const LIST_TTL = 10 * 60 * 1000;

// Base web address for each provider's API. Each can be overridden in .env (e.g. to use
// a compatible service). .replace(/\/$/, '') removes one trailing "/" if there is one,
// so later we can safely add "/models" without getting "//models".
const BASE = {
  anthropic: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  openai: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  gemini: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
};
// The API key for each provider ('' if not set). Gemini accepts either of two variable names.
const KEYS = { anthropic: env.ANTHROPIC_API_KEY || '', openai: env.OPENAI_API_KEY || '', gemini: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '' };

// Fallback default model per provider, used only when the model list can't be fetched.
const FALLBACK = { kiro: 'default', anthropic: 'claude-sonnet-4-5', openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash' };
// Human-friendly names for each provider, shown in the UI and the startup message.
const LABEL = { kiro: 'Kiro', anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini' };

// Whether the Kiro CLI was found: true, false, or null (not checked yet). probeKiro() sets it.
let kiroReady = null; // null = not probed yet
/*
 * enabled()
 * What it does: works out which AI providers can be used right now.
 * Inputs: none (reads env and KEYS).
 * Returns: an array like ['kiro', 'gemini'], with the preferred provider first.
 * Written as an arrow function: `const name = () => { ... }` is a short function syntax.
 */
const enabled = () => {
  // Start with an empty list and add providers that are ready.
  const list = [];
  // AI_PROVIDER in .env can force a preferred provider; lowercase it so "Kiro" = "kiro".
  const forced = (env.AI_PROVIDER || '').toLowerCase();
  // Kiro counts if it has a key OR was forced, and it hasn't been found missing (false).
  if ((env.KIRO_API_KEY || forced === 'kiro') && kiroReady !== false) list.push('kiro');
  // The other three count if their API key is set.
  for (const p of ['anthropic', 'openai', 'gemini']) if (KEYS[p]) list.push(p);
  // AI_PROVIDER picks which provider's default comes first
  // .sort() with a compare function: returning -1 puts a before b, 1 puts b before a,
  // 0 keeps them. So the forced provider moves to the front and others keep their order.
  if (forced && list.includes(forced)) list.sort((a, b) => (a === forced ? -1 : b === forced ? 1 : 0));
  return list;
};

// stripAnsi(s): removes "ANSI escape codes" — invisible control characters that terminal
// programs print to make text coloured/bold. Kiro CLI output contains them, so we clean
// them out. Input: any value (made into a string). Returns: the cleaned string.
// The regex has two alternatives (separated by |), with the g flag to remove all matches:
//  1. \x1b\[ ... : the ESC character, "[", optional digits/semicolons/question marks,
//     optional extra characters in the range space to "/", then one final character
//     between "@" and "~" (that's how colour codes like ESC[31m are built).
//  2. \x1b\] ... \x07 : ESC, "]", any text up to the BEL character (used for e.g. window titles).
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
// run(cmd, args, opts): runs a program and returns a Promise of its text output.
// Default options: pass our environment variables along, time out after 3 minutes
// (180_000 ms), allow 10 MB of output, no window on Windows. `...opts` (spread) copies
// any options the caller passed in AFTER the defaults, so the caller's values win.
// On failure, attach what the program printed (stdout/stderr) to the error, so callers
// can show a helpful message, then reject. On success, resolve with the output as text.
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve(stdout.toString());
  }));

/*
 * prettify(id)
 * What it does: turns a raw model id into a nicer display name,
 * e.g. "claude-sonnet-4-5-20250929" becomes "Claude Sonnet 4.5", "gpt-4o-mini" becomes "GPT-4o Mini".
 * Input: id — the model id string. Returns: the display name string.
 */
function prettify(id) {
  // Two special Kiro ids get fixed names.
  if (id === 'default') return 'Kiro default';
  if (id === 'auto') return 'Auto';
  // A chain of steps; each .something() works on the result of the line before.
  return id
    // Remove a leading "models/" (Gemini ids sometimes start with it).
    .replace(/^models\//, '')
    // Remove a date or "latest" at the end: "-" then either 8 digits (20250929),
    // a date like 2024-08-06, or the word latest.
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '')
    // Split into words at every "-" or "_".
    .split(/[-_]/)
    // Fix the capitalisation of each word w:
    //  - "o" followed by one digit (o1, o3) → keep lowercase (OpenAI's o-series),
    //  - gpt / glm / ai / ml → ALL CAPS,
    //  - words starting with a digit (4o, 2.5) → unchanged,
    //  - anything else → first letter uppercase (w[0].toUpperCase()) + the rest (w.slice(1)).
    .map((w) => (/^o\d$/i.test(w) ? w.toLowerCase() : /^(gpt|glm|ai|ml)$/i.test(w) ? w.toUpperCase() : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    // Put the words back together with spaces.
    .join(' ')
    // Find a digit, a space, and another digit, and join them with a dot. $1 and $2 are
    // the two captured digits; (?=\b) checks a word boundary follows.
    .replace(/(\d) (\d)(?=\b)/g, '$1.$2') // "4 5" → "4.5" (Anthropic ids use dashes)
    // "GPT 4o" → "GPT-4o" (OpenAI's own style keeps the dash).
    .replace(/^GPT /, 'GPT-');
}

// ---------------- Model lists ----------------
/*
 * getJSON(url, headers)
 * What it does: makes a GET request and parses the JSON reply.
 * Inputs: url — address to fetch; headers — extra request headers (e.g. the API key).
 * Returns (a Promise of): the parsed object. Throws if the server reports an error.
 */
async function getJSON(url, headers) {
  // Download, giving up after 15 seconds.
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  // Parse the body as JSON. If it isn't valid JSON, .catch() gives an empty object instead
  // of crashing. `() => ({})` is an arrow function returning an empty object (the extra
  // brackets stop JS reading {} as an empty function body).
  const d = await r.json().catch(() => ({}));
  // Not a success status? Use the API's own error message if it sent one, otherwise "HTTP 401" etc.
  // `?.` is optional chaining: d?.error?.message is undefined (not a crash) if error is missing.
  if (!r.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
  return d;
}

// `kiro-cli chat --list-models --format json`: the output shape isn't documented, so accept any
// reasonable JSON (array of strings/objects, or an object wrapping one) and fall back to plain text.
/*
 * parseKiroModels(out)
 * Input: out — the raw text the Kiro CLI printed.
 * Returns: an array of { id, name } model entries (possibly empty).
 */
function parseKiroModels(out) {
  // Remove colour codes and surrounding whitespace.
  const text = stripAnsi(out).trim();
  // idOf(x): get a model's id. If x is a plain string, it IS the id; otherwise try a
  // series of likely property names, using the first that has a value.
  const idOf = (x) => (typeof x === 'string' ? x : x?.id || x?.model_id || x?.modelId || x?.model || x?.name);
  // nameOf(x): get a display name, only for objects. Try display_name/displayName/label,
  // or name if it's different from the id. If nothing is found, return ''.
  const nameOf = (x) => (typeof x === 'object' && (x.display_name || x.displayName || x.label || (x.name !== idOf(x) && x.name))) || '';
  // findArray(v, depth): search inside some JSON for the list of models.
  // If v is already an array, that's it. If it's an object, first check common key names
  // (models, data, items...), then look inside each value — calling itself ("recursion"),
  // going at most 3 levels deep. Returns the array or null if none found.
  const findArray = (v, depth = 0) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object' && depth < 3) {
      for (const k of ['models', 'data', 'items', 'availableModels', 'available_models']) if (Array.isArray(v[k])) return v[k];
      // Object.values(v) gives all the values of the object as an array.
      for (const val of Object.values(v)) { const a = findArray(val, depth + 1); if (a) return a; }
    }
    return null;
  };
  // Try to read the output as JSON.
  let json = null;
  try { json = JSON.parse(text); } catch {
    // Not pure JSON — maybe there's extra text around it. This regex grabs from the first
    // "[" or "{" to the last "]" or "}" ([\s\S]* = any characters, including new lines).
    const m = text.match(/[[{][\s\S]*[\]}]/);
    // If found, try parsing just that part; if that fails too, ignore it.
    if (m) try { json = JSON.parse(m[0]); } catch { /* not JSON */ }
  }
  // If we have JSON, look for the model list inside it.
  const arr = json && findArray(json);
  if (arr) {
    // Turn each entry into { id, name } strings, then keep only ids that look sensible:
    // 2–80 characters made of letters, digits, "_", ".", ":", "/" or "-".
    return arr.map((x) => ({ id: String(idOf(x) || ''), name: String(nameOf(x) || '') })).filter((m) => /^[\w.:/-]{2,80}$/.test(m.id));
  }
  // Plain text: one model per line, e.g. "* claude-opus-4.8  (current)" or "claude-sonnet-4.5 - Claude Sonnet 4.5"
  const out2 = [];
  for (const line of text.split('\n')) {
    // In plain words: optional spaces, an optional bullet (- * • >) or list number ("1." or "1)"),
    // optional spaces, then capture a word that starts with a letter and contains at least
    // one digit (like claude-opus-4.8), OR the word auto. \b means the word ends there.
    const m = line.match(/^\s*(?:[-*•>]|\d+[.)])?\s*([a-z][\w.-]*\d[\w.-]*|auto)\b/i);
    // Skip heading words like "Available", "Models", "Name", "ID".
    if (m && !/^(available|models?|name|id)$/i.test(m[1])) out2.push({ id: m[1], name: '' });
  }
  return out2;
}

// listers: one function per provider that fetches that provider's model list.
// Each returns (a Promise of) an array of { id, name }. `async kiro() {...}` inside an
// object is "method shorthand" for kiro: async function () {...}.
const listers = {
  // Kiro: ask the CLI for its models.
  async kiro() {
    let models = [];
    try {
      // First try asking for JSON output (30-second limit, run inside the kiro-agent folder).
      models = parseKiroModels(await run(KIRO_CLI, ['chat', '--list-models', '--format', 'json'], { timeout: 30_000, cwd: KIRO_DIR }));
    } catch {
      // Older CLI versions may not support --format json; retry with plain text output.
      models = parseKiroModels(await run(KIRO_CLI, ['chat', '--list-models'], { timeout: 30_000, cwd: KIRO_DIR }));
    }
    // Always put "Kiro default" first, then the rest (spread `...` unpacks the array),
    // filtering out any duplicate 'default' entry.
    return [{ id: 'default', name: 'Kiro default' }, ...models.filter((m) => m.id !== 'default')];
  },
  // Anthropic: GET /v1/models with the API key and the required API version header.
  async anthropic() {
    const d = await getJSON(`${BASE.anthropic}/v1/models?limit=1000`, { 'x-api-key': KEYS.anthropic, 'anthropic-version': '2023-06-01' });
    // The list is in d.data; keep the id and the display name.
    return (d.data || []).map((m) => ({ id: m.id, name: m.display_name || '' }));
  },
  // OpenAI: GET /models with a "Bearer" token (the standard way to send an API key).
  async openai() {
    const d = await getJSON(`${BASE.openai}/models`, { authorization: `Bearer ${KEYS.openai}` });
    // Model ids containing any of these words are not chat models (audio, images,
    // embeddings, old models...), so we'll hide them. The i flag ignores case.
    const notChat = /audio|realtime|transcribe|tts|image|embed|search|moderation|instruct|codex|dall|whisper|davinci|babbage|rerank/i;
    // True if the base URL is the real OpenAI address (dots escaped with \. to mean a literal ".").
    const official = /^https:\/\/api\.openai\.com/.test(BASE.openai);
    // Official API: only GPT/o-series chat models. Custom base URLs (OpenRouter, Ollama…) keep any chat-capable model.
    // Keep a model if it's not in notChat AND (we're not on official OpenAI OR its id starts
    // with gpt, o + digit, or chatgpt).
    const models = (d.data || []).filter((m) => !notChat.test(m.id) && (!official || /^(gpt|o\d|chatgpt)/i.test(m.id)));
    // Sort newest first (by the "created" timestamp; b - a gives descending order), then
    // keep only the id (OpenAI gives no display name).
    return models.sort((a, b) => (b.created || 0) - (a.created || 0)).map((m) => ({ id: m.id, name: '' }));
  },
  // Google Gemini: GET /models with the key in the x-goog-api-key header.
  async gemini() {
    const d = await getJSON(`${BASE.gemini}/models?pageSize=1000`, { 'x-goog-api-key': KEYS.gemini });
    return (d.models || [])
      // Keep only models that can generate text ("generateContent"), whose name contains
      // gemini or gemma, and that aren't special-purpose (embedding, image, speech, live...).
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini|gemma/i.test(m.name) && !/embedding|image|tts|live|aqa|vision|native-audio/i.test(m.name))
      // Names come as "models/gemini-2.5-pro"; strip the "models/" prefix for the id.
      .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || '' }));
  },
};

// A Map is a key → value store (like an object, but any key type and handy .get/.set/.clear).
// Here: provider name → { at: time fetched, models, error }.
const listCache = new Map();
/*
 * listProvider(p)
 * What it does: gets one provider's model list, using the cache if it's under 10 minutes old.
 * Input: p — provider name ('kiro', 'openai'...).
 * Returns (a Promise of): { at, models, error } — error is null on success or a short message.
 * It never throws: on failure it still returns a usable fallback model.
 */
async function listProvider(p) {
  // Look in the cache.
  const hit = listCache.get(p);
  // Cached and still fresh? Use it (Date.now() is the current time in milliseconds).
  if (hit && Date.now() - hit.at < LIST_TTL) return hit;
  try {
    // Fetch a fresh list using the matching lister function (listers[p] picks it by name).
    const entry = { at: Date.now(), models: await listers[p](), error: null };
    // An empty list counts as a failure.
    if (!entry.models.length) throw new Error('no models returned');
    // Save it in the cache and return it.
    listCache.set(p, entry);
    return entry;
  } catch (e) {
    // Build a short error message: ENOENT ("no such file") means the Kiro program wasn't
    // found. Otherwise take stderr or the message, clean it, keep only its last line,
    // and cut it to 160 characters.
    const msg = e.code === 'ENOENT' ? 'Kiro CLI not found' : stripAnsi(e.stderr || e.message || '').trim().split('\n').pop().slice(0, 160);
    // Keep the provider usable with its default model even if listing fails
    // Use the old cached models if we had some (hit?.models), else just the fallback model.
    return { at: Date.now(), models: hit?.models || [{ id: FALLBACK[p], name: '' }], error: msg || 'couldn’t load models' };
  }
}

/*
 * catalog({ refresh })
 * What it does: builds the full model list for the model picker, across all providers.
 * Input: an options object; refresh: true empties the cache first.
 * Returns (a Promise of): { models, errors, default } — models is a flat list of entries,
 * errors maps provider → message, default is the id of the default model.
 */
async function catalog({ refresh = false } = {}) {
  // Forget cached lists if a refresh was asked for.
  if (refresh) listCache.clear();
  const providers = enabled();
  // Promise.all runs all providers' lookups at the same time (in parallel) and waits until
  // every one finishes. Each gives back a pair [providerName, result].
  const results = await Promise.all(providers.map(async (p) => [p, await listProvider(p)]));
  const models = [];
  const errors = {};
  // `const [p, r] of results` destructures each pair into p (name) and r (result).
  for (const [p, r] of results) {
    // Remember any error for this provider.
    if (r.error) errors[p] = r.error;
    // Add each model as an entry with a combined id like "gemini:gemini-2.5-pro", the
    // provider, its label, the raw model id, and a display label (its own name or prettify()).
    for (const m of r.models) models.push({ id: `${p}:${m.id}`, provider: p, providerLabel: LABEL[p], model: m.id, label: m.name || prettify(m.id) });
  }
  // `default` is a property name here (allowed in objects even though it's a keyword).
  return { models, errors, default: defaultModel(models) };
}

/*
 * defaultModel(models)
 * What it does: picks which model should be selected by default.
 * Input: the list of model entries from catalog() (defaults to an empty array).
 * Returns: a model id like "kiro:default", or null if no AI is configured.
 */
function defaultModel(models = []) {
  // AI_MODEL in .env can name the preferred model.
  const want = env.AI_MODEL;
  if (want) {
    // Accept either the full id ("openai:gpt-4o") or just the model part ("gpt-4o").
    const hit = models.find((m) => m.id === want || m.model === want);
    if (hit) return hit.id;
  }
  // Otherwise use the first enabled provider.
  const first = enabled()[0];
  if (!first) return null;
  // Its first model from the list, or "provider:fallbackModel" if the list has none.
  return models.find((m) => m.provider === first)?.id || `${first}:${FALLBACK[first]}`;
}

// ---------------- Calling a model ----------------
/*
 * resolve(modelId)
 * What it does: splits a "provider:model" id into its two parts and checks it's usable.
 * Input: modelId — e.g. "gemini:gemini-2.5-pro" (may be missing or invalid).
 * Returns: { provider, model }. Throws a 503 error if no AI is configured at all.
 * (Note: this is our own function named resolve, unrelated to a Promise's resolve.)
 */
function resolve(modelId) {
  const providers = enabled();
  // No providers: error with status 503 ("service unavailable") and setup instructions.
  if (!providers.length) throw Object.assign(new Error('AI not configured. Add KIRO_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY to .env'), { status: 503 });
  // Split at ":". p gets the first part; `...rest` (a "rest" pattern) collects the remaining
  // parts into an array. `let` because we may change them below.
  let [p, ...rest] = String(modelId || '').split(':');
  // Re-join the rest with ":" in case the model id itself contains colons.
  let model = rest.join(':');
  if (!providers.includes(p)) {
    // Unknown/removed choice: fall back to the default provider
    p = providers[0];
    // Pick the model: if AI_MODEL is set without a provider prefix, use it as-is; if it
    // starts with "thisProvider:", use the part after the prefix; otherwise the fallback.
    model = env.AI_MODEL && !env.AI_MODEL.includes(':') ? env.AI_MODEL : env.AI_MODEL?.startsWith(p + ':') ? env.AI_MODEL.slice(p.length + 1) : FALLBACK[p];
  }
  // If the model part was empty, use the provider's fallback.
  return { provider: p, model: model || FALLBACK[p] };
}

/*
 * callAI({ system, messages, maxTokens, model })
 * What it does: the main entry point for /api/ai — sends a conversation to the chosen
 * model and returns its reply.
 * Inputs (one object, destructured): system — instructions for the AI; messages — the
 * chat so far as [{ role: 'user'|'assistant', content }]; maxTokens — reply length limit
 * (a "token" is roughly ¾ of a word); model — the "provider:model" id (renamed modelId here).
 * Returns (a Promise of): { text, model } — the reply and which model actually answered.
 */
async function callAI({ system = '', messages = [], maxTokens = 2048, model: modelId }) {
  // Clean the messages: keep only real user/assistant messages that have content, and make
  // sure each has only role and content, with content as a string.
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));
  // Nothing left to send? That's an error.
  if (!clean.length) throw new Error('No messages');
  // Work out the provider and model to use.
  const { provider, model } = resolve(modelId);
  // Call the matching function in `callers` (below) and wait for the reply text.
  const text = await callers[provider]({ system, messages: clean, maxTokens, model });
  return { text, model: `${provider}:${model}` };
}

/*
 * postJSON(url, headers, body, label)
 * What it does: sends a POST request with a JSON body and parses the JSON reply.
 * Inputs: url; headers — extra headers (API key); body — object to send; label — provider
 * name used in error messages. Returns (a Promise of): the parsed reply object.
 */
async function postJSON(url, headers, body, label) {
  // POST with Content-Type JSON plus the extra headers (spread in), the body turned into
  // JSON text, and a 3-minute timeout (AI replies can be slow).
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  // Parse the reply; use {} if it isn't valid JSON.
  const d = await r.json().catch(() => ({}));
  // On failure, use the API's error message or e.g. "OpenAI error 429".
  if (!r.ok) throw new Error(d?.error?.message || `${label} error ${r.status}`);
  return d;
}

// callers: one function per provider that actually sends the conversation and returns the
// reply text. Each provider's API wants the data in a slightly different shape.
const callers = {
  // Anthropic (Claude) Messages API.
  async anthropic({ system, messages, maxTokens, model }) {
    // `{ model, max_tokens: maxTokens, system, messages }` uses "shorthand properties":
    // writing `model` alone means `model: model`.
    const d = await postJSON(`${BASE.anthropic}/v1/messages`, { 'x-api-key': KEYS.anthropic, 'anthropic-version': '2023-06-01' }, { model, max_tokens: maxTokens, system, messages }, 'Anthropic');
    // The reply is a list of content blocks; join the text of all of them.
    return (d.content || []).map((b) => b.text || '').join('');
  },
  // OpenAI Chat Completions API (also works with OpenAI-compatible services).
  async openai({ system, messages, maxTokens, model }) {
    // Are we talking to the real OpenAI?
    const official = /^https:\/\/api\.openai\.com/.test(BASE.openai);
    // OpenAI puts the system instructions as the first message with role 'system',
    // followed by the conversation (spread in with ...messages).
    const body = { model, messages: [{ role: 'system', content: system }, ...messages] };
    // Newer OpenAI models only accept max_completion_tokens (and reasoning models use some for thinking)
    // For reasoning models (ids starting o1/o3... or gpt-5) allow at least 8000 tokens,
    // since part of the budget goes to hidden "thinking". Math.max picks the bigger number.
    if (official) body.max_completion_tokens = Math.max(maxTokens, /^(o\d|gpt-5)/.test(model) ? 8000 : 0);
    // Other compatible services use the older name max_tokens.
    else body.max_tokens = maxTokens;
    const d = await postJSON(`${BASE.openai}/chat/completions`, { authorization: `Bearer ${KEYS.openai}` }, body, 'OpenAI');
    // The reply text is in the first "choice". `?.[0]` safely reads item 0 if choices exists.
    return d.choices?.[0]?.message?.content || '';
  },
  // Google Gemini generateContent API. encodeURIComponent makes the model name safe to put in a URL.
  async gemini({ system, messages, maxTokens, model }) {
    const d = await postJSON(`${BASE.gemini}/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': KEYS.gemini }, {
      // Gemini's name for the system prompt, given as a list of "parts".
      systemInstruction: { parts: [{ text: system }] },
      // Gemini calls the assistant role 'model', so convert each message to its format.
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      // Reply length limit; "thinking" models (pro, thinking, 2.5, 3) get at least 8192 tokens.
      generationConfig: { maxOutputTokens: Math.max(maxTokens, /pro|thinking|2\.5|3/.test(model) ? 8192 : 0) },
    }, 'Gemini');
    // The first candidate answer.
    const cand = d.candidates?.[0];
    // Join the text of its parts, skipping parts marked as "thought" (the model's internal reasoning).
    const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    // No text and it stopped for a reason other than finishing normally (e.g. MAX_TOKENS, SAFETY)?
    if (!text && cand?.finishReason && cand.finishReason !== 'STOP') throw new Error(`Gemini stopped early (${cand.finishReason.toLowerCase()})`);
    // No text because Google blocked the prompt?
    if (!text && d.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${d.promptFeedback.blockReason.toLowerCase()})`);
    return text;
  },
  // Kiro: run the CLI as a separate program. (maxTokens isn't used; the CLI has no such option.)
  async kiro({ system, messages, model }) {
    // Pick (or create) the agent that is pinned to the chosen model.
    const agent = kiroAgentFor(model);
    try {
      // Run: kiro-cli chat --no-interactive --agent <agent> "<whole prompt>" inside the
      // kiro-agent folder. --no-interactive means answer once and exit.
      const out = await run(KIRO_CLI, ['chat', '--no-interactive', '--agent', agent, flattenPrompt(system, messages)], { cwd: KIRO_DIR });
      // Remove colour codes and status lines from the output.
      const text = cleanKiroOutput(out);
      if (!text) throw new Error('Kiro returned an empty response');
      return text;
    } catch (err) {
      // Program not found.
      if (err.code === 'ENOENT') throw new Error('Kiro CLI not found. Install it (https://kiro.dev/cli) or set KIRO_CLI_PATH.');
      // err.killed means our timeout stopped it (3 minutes, from run()'s defaults).
      if (err.killed) throw new Error('Kiro took too long to respond (3 min timeout).');
      // No program output at all (e.g. our own "empty response" error): pass it on unchanged.
      if (!err.stderr && !err.stdout) throw err;
      // Otherwise show the last 3 lines the CLI printed, joined with spaces.
      const msg = cleanKiroOutput(err.stderr || err.stdout || '').split('\n').slice(-3).join(' ');
      throw new Error(`Kiro CLI error: ${msg || err.message}`);
    }
  },
};

// Kiro CLI has no per-run --model flag, but an agent can pin a model (documented `model` field).
// So each chosen model gets its own text-only copy of the study-os agent (no tools, no MCP).
/*
 * kiroAgentFor(model)
 * Input: model — the Kiro model id (or 'default').
 * Returns: the agent name to pass to --agent. It writes an agent JSON file if needed.
 */
function kiroAgentFor(model) {
  // The default model just uses the normal agent.
  if (!model || model === 'default') return KIRO_AGENT;
  // Make a "slug" (safe file-name piece) from the model id: lowercase, turn every run of
  // characters that aren't a–z or 0–9 into one "-", remove a "-" at the start or end,
  // and keep at most 60 characters. e.g. "claude-opus-4.8" → "claude-opus-4-8".
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  // Agent name like "study-os-m-claude-opus-4-8".
  const name = `${KIRO_AGENT}-m-${slug}`;
  // Folder where Kiro keeps agent files: kiro-agent/.kiro/agents
  const dir = path.join(KIRO_DIR, '.kiro', 'agents');
  // This model's agent file.
  const file = path.join(dir, `${name}.json`);
  // Read the base agent (study-os.json) and parse it into an object.
  const base = JSON.parse(fs.readFileSync(path.join(dir, `${KIRO_AGENT}.json`), 'utf8'));
  // Copy everything from the base agent (spread), then override: new name, pinned model,
  // and no tools/MCP servers so it only writes text. JSON.stringify(..., null, 2) makes
  // nicely indented JSON (2 spaces).
  const cfg = JSON.stringify({ ...base, name, model, tools: [], allowedTools: [], mcpServers: {} }, null, 2);
  // Only write the file if it's missing or different (avoids rewriting it on every message).
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== cfg) fs.writeFileSync(file, cfg);
  return name;
}

/*
 * cleanKiroOutput(out)
 * What it does: removes terminal clutter from Kiro's output so only the reply remains.
 * Input: raw CLI output. Returns: the cleaned reply text.
 */
function cleanKiroOutput(out) {
  // Remove colour codes, remove carriage returns (\r), and split into lines.
  const lines = stripAnsi(out).replace(/\r/g, '').split('\n');
  // Drop status lines. First regex: optional spaces, an optional ▸ or • symbol, then a
  // label like "Credits:", "Time:", "Token(s):", "Model:" or "Agent:". Second regex: any
  // line mentioning "falling back to (the) default model".
  const kept = lines.filter((l) => !/^\s*[▸•]?\s*(Credits|Time|Tokens?|Model|Agent)\s*:/i.test(l) && !/falling back to (the )?default model/i.test(l));
  // Join the lines back, remove a leading ">" prompt marker (and one space after it), trim.
  return kept.join('\n').replace(/^\s*>\s?/, '').trim();
}

/*
 * flattenPrompt(system, messages)
 * What it does: the Kiro CLI takes a single text prompt, not a list of messages, so this
 * turns the system instructions plus the conversation into one string.
 * Returns: the prompt string, cut to MAX_PROMPT characters if it's too long.
 */
function flattenPrompt(system, messages) {
  // Each message becomes "Student: ..." or "Assistant: ...", separated by blank lines.
  const convo = messages.map((m) => `${m.role === 'user' ? 'Student' : 'Assistant'}: ${m.content}`).join('\n\n');
  // The full prompt: the system instructions, a "# Conversation" heading, the conversation,
  // then a final instruction to reply only as the assistant and not use any tools.
  const prompt = `${system}\n\n# Conversation\n${convo}\n\nReply as the Assistant to the student's last message. Output only the reply itself: no preamble, and do not use any tools.`;
  // Too long for a command-line argument? Cut it and add a note that it was truncated.
  return prompt.length > MAX_PROMPT ? prompt.slice(0, MAX_PROMPT) + '\n\n[input truncated]' : prompt;
}

/*
 * probeKiro()
 * What it does: at startup, checks whether the Kiro CLI is installed by running
 * `kiro-cli --version`, sets kiroReady, and prints the result. Called by server.js.
 * Inputs: none. Returns: nothing (the check finishes later, in the callback).
 */
function probeKiro() {
  // Only check if Kiro is configured (has a key, or AI_PROVIDER is 'kiro').
  if (!(env.KIRO_API_KEY || (env.AI_PROVIDER || '').toLowerCase() === 'kiro')) return;
  // Run "kiro-cli --version" with a 15-second limit; the arrow function runs when it's done.
  execFile(KIRO_CLI, ['--version'], { timeout: 15_000, windowsHide: true }, (err, out) => {
    // No error means the CLI exists. (This function "closes over" kiroReady — a closure:
    // it can still change that outer variable even though it runs later.)
    kiroReady = !err;
    // Print the version, or a warning if it wasn't found.
    console.log(kiroReady ? `  Kiro CLI: ${stripAnsi(out).trim()}` : `  ⚠ Kiro CLI not found at "${KIRO_CLI}". Install it or set KIRO_CLI_PATH`);
  });
}

// Export the functions other files use (server.js mainly uses enabled, catalog, callAI,
// probeKiro and LABEL; parseKiroModels and prettify are exported so they can be tested).
module.exports = { enabled, catalog, callAI, probeKiro, defaultModel, parseKiroModels, prettify, LABEL };
