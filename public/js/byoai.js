/*
 * byoai.js — "bring your own AI" for the no-server (website) version of orbit.
 *
 * Why this file exists:
 *   Normally the browser never talks to an AI company directly — it calls OUR server
 *   (server.js + ai-providers.js), which holds the secret keys. But when orbit is hosted
 *   as a plain website (e.g. GitHub Pages) there IS no server. So instead, each visitor
 *   can paste THEIR OWN api key in Settings; it is saved only in their browser
 *   (localStorage, never sent anywhere except straight to the AI company), and this file
 *   calls the AI company's API directly from the browser.
 *
 * What works directly from a browser (this is a real-world limitation, not a choice):
 *   - Anthropic (Claude): YES, if we send the special header
 *     `anthropic-dangerous-direct-browser-access: true`.
 *   - Google Gemini: YES (its API allows browser calls with the key in a header).
 *   - OpenAI: usually NOT allowed directly from a browser (its servers block cross-origin
 *     browser requests). We still let you paste an OpenAI key, but you must also give a
 *     "base URL" that points at a proxy that adds the right CORS headers. Clearly labelled.
 *   - Kiro: needs the Kiro CLI on your computer, which a website can't run. Kiro therefore
 *     only works in the local `node server.js` version, not on the website.
 *
 * Security note we surface in the UI: a key saved in a browser can be read by anything with
 * access to that browser profile. These are the visitor's OWN keys on their OWN device, and
 * we recommend keys with low spending limits. Nothing is stored on any orbit server (there
 * isn't one in website mode).
 *
 * This module mirrors the shape of ai-providers.js's callers so ai.js can use either path.
 */

// Where each provider's keys/settings live in localStorage. One JSON object under this key.
const KEYS_STORE = 'studyos:byokeys';

// Default API base URLs. OpenAI's can be overridden to point at a CORS-friendly proxy.
const DEFAULT_BASE = {
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openai: 'https://api.openai.com/v1',
};

// Which providers can realistically be called straight from a browser with just a key.
// (OpenAI is intentionally not here: it needs a proxy base URL, handled separately.)
export const BROWSER_PROVIDERS = ['anthropic', 'gemini', 'openai'];
// Friendly names shown in the UI.
export const PROVIDER_LABEL = { anthropic: 'Anthropic (Claude)', gemini: 'Google Gemini', openai: 'OpenAI' };

/*
 * readKeys() — load the saved per-provider settings from localStorage.
 * Returns an object like { anthropic: { key, base }, gemini: { key }, openai: { key, base } }.
 * Always returns an object (never throws) so callers can use it safely.
 */
export function readKeys() {
  try {
    // JSON.parse turns the saved text back into an object; `|| '{}'` guards a missing value.
    return JSON.parse(localStorage.getItem(KEYS_STORE) || '{}') || {};
  } catch {
    // Corrupt/old value → start fresh rather than crash.
    return {};
  }
}

/*
 * writeKeys(obj) — save the per-provider settings object to localStorage.
 * Input: the whole settings object (as returned by readKeys()). Returns nothing.
 */
export function writeKeys(obj) {
  localStorage.setItem(KEYS_STORE, JSON.stringify(obj || {}));
}

/*
 * setProviderKey(provider, { key, base }) — update one provider's saved key/base.
 * Passing an empty key removes that provider entirely. Returns the new settings object.
 */
export function setProviderKey(provider, { key = '', base = '' } = {}) {
  const all = readKeys();
  const k = key.trim();
  if (!k) {
    // Empty key = forget this provider.
    delete all[provider];
  } else {
    // Save the trimmed key, and the trimmed base URL only if one was given.
    all[provider] = { key: k };
    if (base.trim()) all[provider].base = base.trim();
  }
  writeKeys(all);
  return all;
}

/*
 * configuredProviders() — which providers have a usable key saved right now.
 * Returns an array like ['anthropic', 'gemini']. OpenAI is only included if it also has a
 * base URL (because the default OpenAI endpoint won't work from a browser).
 */
export function configuredProviders() {
  const all = readKeys();
  return BROWSER_PROVIDERS.filter((p) => {
    const c = all[p];
    if (!c || !c.key) return false;
    // OpenAI needs a custom base (a proxy) to work from a browser; without one, don't claim it.
    if (p === 'openai' && !c.base) return false;
    return true;
  });
}

// True when any provider is set up for browser use.
export const byoEnabled = () => configuredProviders().length > 0;

// ---------------- model lists ----------------
// A small, hand-picked default model per provider, used when we can't fetch a live list
// (keeps the picker working offline / without an extra request). These are safe, current ids.
const FALLBACK_MODELS = {
  anthropic: [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'claude-opus-4-1', name: 'Claude Opus 4.1' },
    { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  ],
  openai: [
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4o', name: 'GPT-4o' },
  ],
};

// base(provider): the API base URL to use for a provider (saved custom one, or the default).
const base = (provider) => (readKeys()[provider]?.base || DEFAULT_BASE[provider]).replace(/\/$/, '');
// key(provider): the saved api key for a provider ('' if none).
const key = (provider) => readKeys()[provider]?.key || '';

/*
 * listModels(provider) — fetch the live model list for a provider from the browser.
 * Returns (a Promise of) an array of { id, name }. On any failure it returns the fallback list,
 * so the picker always has something usable.
 */
async function listModels(provider) {
  try {
    if (provider === 'anthropic') {
      const r = await fetch(`${base('anthropic')}/v1/models?limit=1000`, {
        headers: { 'x-api-key': key('anthropic'), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        signal: AbortSignal.timeout(15000),
      });
      const d = await r.json();
      if (!r.ok) throw new Error('list failed');
      return (d.data || []).map((m) => ({ id: m.id, name: m.display_name || '' }));
    }
    if (provider === 'gemini') {
      const r = await fetch(`${base('gemini')}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key('gemini') }, signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      if (!r.ok) throw new Error('list failed');
      return (d.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini|gemma/i.test(m.name) && !/embedding|image|tts|live|aqa|vision|native-audio/i.test(m.name))
        .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || '' }));
    }
    if (provider === 'openai') {
      const r = await fetch(`${base('openai')}/models`, { headers: { authorization: `Bearer ${key('openai')}` }, signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      if (!r.ok) throw new Error('list failed');
      const notChat = /audio|realtime|transcribe|tts|image|embed|search|moderation|instruct|codex|dall|whisper|davinci|babbage|rerank/i;
      return (d.data || [])
        .filter((m) => !notChat.test(m.id) && /^(gpt|o\d|chatgpt)/i.test(m.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((m) => ({ id: m.id, name: '' }));
    }
  } catch {
    /* fall through to fallback */
  }
  return FALLBACK_MODELS[provider] || [];
}

/*
 * catalog() — build the model picker list across every configured browser provider.
 * Returns (a Promise of) { models, errors, default } with the SAME shape ai.js expects from
 * the server's /api/models, so the rest of the app doesn't care which path it came from.
 * Model ids are "provider:modelId" (e.g. "anthropic:claude-sonnet-4-5").
 */
export async function catalog() {
  const providers = configuredProviders();
  const models = [];
  const errors = {};
  // Fetch every provider's list in parallel.
  const lists = await Promise.all(providers.map(async (p) => [p, await listModels(p)]));
  for (const [p, list] of lists) {
    for (const m of list) models.push({ id: `${p}:${m.id}`, provider: p, providerLabel: PROVIDER_LABEL[p], model: m.id, label: m.name || m.id });
  }
  // Default: first model of the first configured provider.
  const def = models[0]?.id || null;
  return { models, errors, default: def };
}

// ---------------- calling a model ----------------
/*
 * callAI({ system, messages, maxTokens, model }) — send a conversation to the chosen model,
 * directly from the browser. Returns (a Promise of) { text, model } — the same shape as the
 * server's POST /api/ai response. Throws an Error with a readable message on failure.
 */
export async function callAI({ system = '', messages = [], maxTokens = 2048, model: modelId }) {
  // Split "provider:model" into its two parts (model names can contain ':').
  const [provider, ...rest] = String(modelId || '').split(':');
  const model = rest.join(':');
  // Make sure this provider is actually set up.
  if (!configuredProviders().includes(provider)) throw new Error('No API key set for this model. Add one in Settings.');
  // Keep only valid user/assistant messages with string content.
  const clean = messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content).map((m) => ({ role: m.role, content: String(m.content) }));
  if (!clean.length) throw new Error('No messages');
  const text = await callers[provider]({ system, messages: clean, maxTokens, model });
  return { text, model: `${provider}:${model}` };
}

// postJSON(url, headers, body): POST a JSON body, parse the JSON reply, throw a clean error on failure.
async function postJSON(url, headers, body, label) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  } catch (e) {
    // A network/CORS failure throws before we get a response. Give a useful hint.
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`${label} took too long to respond`);
    throw new Error(`Couldn’t reach ${label} from the browser (this can be a CORS block). ${label === 'OpenAI' ? 'OpenAI usually needs a proxy base URL.' : 'Check your key and connection.'}`);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `${label} error ${r.status}`);
  return d;
}

// One function per provider that actually sends the conversation and returns the reply text.
const callers = {
  // Anthropic (Claude) Messages API — the browser header is what makes direct calls allowed.
  async anthropic({ system, messages, maxTokens, model }) {
    const d = await postJSON(`${base('anthropic')}/v1/messages`, {
      'x-api-key': key('anthropic'),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }, { model, max_tokens: maxTokens, system, messages }, 'Anthropic');
    return (d.content || []).map((b) => b.text || '').join('');
  },
  // Google Gemini generateContent API.
  async gemini({ system, messages, maxTokens, model }) {
    const d = await postJSON(`${base('gemini')}/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': key('gemini') }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: Math.max(maxTokens, /pro|thinking|2\.5|3/.test(model) ? 8192 : 0) },
    }, 'Gemini');
    const cand = d.candidates?.[0];
    const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (!text && cand?.finishReason && cand.finishReason !== 'STOP') throw new Error(`Gemini stopped early (${cand.finishReason.toLowerCase()})`);
    if (!text && d.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${d.promptFeedback.blockReason.toLowerCase()})`);
    return text;
  },
  // OpenAI Chat Completions API (works from a browser only through a CORS-friendly base URL/proxy).
  async openai({ system, messages, maxTokens, model }) {
    const official = /^https:\/\/api\.openai\.com/.test(base('openai'));
    const body = { model, messages: [{ role: 'system', content: system }, ...messages] };
    // Newer OpenAI models use max_completion_tokens; reasoning models need headroom for hidden thinking.
    if (official) body.max_completion_tokens = Math.max(maxTokens, /^(o\d|gpt-5)/.test(model) ? 8000 : 0);
    else body.max_tokens = maxTokens;
    const d = await postJSON(`${base('openai')}/chat/completions`, { authorization: `Bearer ${key('openai')}` }, body, 'OpenAI');
    return d.choices?.[0]?.message?.content || '';
  },
};
