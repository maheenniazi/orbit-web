/*
 * spotify.js — music for studying. There are two separate ways Spotify is used:
 *
 * 1. The EMBED player (no login needed). Spotify lets any website show a small player inside an
 *    <iframe> (a "page inside the page"). We put one in the sidebar ("the dock") and just change
 *    which playlist it shows. Anyone can use this; nothing to set up.
 *
 * 2. Optional ACCOUNT CONNECT (login), for "now playing", play/pause/skip, and your own playlists.
 *    This uses OAuth, the standard "Log in with…" system: we send you to Spotify's site, you click
 *    "Agree", and Spotify sends you back to our /callback page with a one-time "code". We trade that
 *    code for tokens:
 *      - an ACCESS token: a temporary pass (about 1 hour) that we attach to every API request;
 *      - a REFRESH token: a longer-lived pass used to get a new access token when the old one expires.
 *    The flavour used is PKCE ("pixie"). Normally apps prove who they are with a secret password,
 *    but anything in browser code is public, so instead: before leaving, we make a random secret
 *    (the "verifier"), send Spotify only a scrambled fingerprint of it (the "challenge", a SHA-256
 *    hash), and when trading the code we reveal the original verifier. Spotify checks they match, so
 *    a stolen code alone is useless. Tokens are saved in localStorage (the browser's storage).
 */

// Original note from the author:
// Spotify: persistent embed player (no login needed) + optional account connect (PKCE OAuth)
// for now-playing, playback controls and your own playlists.

// store = the app's saved data (we read the playlist settings from it).
import { store } from './store.js';
// getStatus() = info from our server, including spotifyClientId (the public id of the Spotify app from .env).
import { getStatus } from './ai.js';
// esc() makes text safe to insert into HTML.
import { esc } from './util.js';
// toast() shows a small popup message.
import { toast } from './ui.js';

// The localStorage key ("label") under which we save the Spotify tokens.
const TK = 'studyos:spotify';
// The permissions ("scopes") we ask the user for, separated by spaces: see what's playing,
// control playback, see the current song, and read their private playlists.
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private';
// Where Spotify should send the user back after login: this same site + "/callback".
// location.origin is e.g. "http://localhost:3000". It's a function (arrow function `() => ...`) so it's
// computed when needed. The backticks make a template literal: ${...} inserts a value into the text.
const redirectUri = () => `${location.origin}/callback`;
// The start of every Spotify Web API address.
const API = 'https://api.spotify.com/v1';

/*
 * parsePlaylistId(input) — pull a Spotify playlist id out of whatever the user pasted.
 * Input: a link like "https://open.spotify.com/playlist/37i9dQZF1DWWQRwui0ExPn?si=…",
 *        a URI like "spotify:playlist:37i9…", or just the bare id. Defaults to '' if nothing is passed.
 * Returns: the 22-character id, or null if none is found.
 */
export function parsePlaylistId(input = '') {
  // Try two regular expressions (text patterns):
  //  1. /playlist[/:]([A-Za-z0-9]{22})/ = the word "playlist", then a "/" or ":", then exactly 22 letters
  //     or digits — the parentheses "capture" those 22 characters so we can read them out.
  //  2. If that fails (`||`), trim spaces and try /^([A-Za-z0-9]{22})$/ = the WHOLE text is exactly
  //     22 letters/digits (^ = start, $ = end) — i.e. the user pasted only the id.
  // .match returns an array (m[0] = full match, m[1] = the captured part) or null if no match.
  const m = input.match(/playlist[/:]([A-Za-z0-9]{22})/) || input.trim().match(/^([A-Za-z0-9]{22})$/);
  // Return the captured id, or null.
  return m ? m[1] : null;
}

// ---- Persistent dock (lives in the sidebar, never re-rendered by views) ----
// The id of the playlist currently loaded in the sidebar player (null = nothing loaded yet).
let dockId = null;
/*
 * loadDock(playlistId) — show a playlist in the sidebar's embedded Spotify player.
 * Input: a playlist id. Returns: nothing.
 */
export function loadDock(playlistId) {
  // Find the sidebar box that holds the player (it's in index.html).
  const dock = document.getElementById('player-dock');
  // Stop if: there's no dock, no id was given, or that playlist is already loaded
  // (re-creating the iframe would restart the music).
  if (!dock || !playlistId || dockId === playlistId) return;
  // Remember what's loaded now.
  dockId = playlistId;
  // Put Spotify's embed iframe into the dock. The template builds:
  //  - src: Spotify's embed page for this playlist (id escaped for safety); theme=0 = dark player;
  //  - height 152px = Spotify's compact player size;
  //  - allow="...": permissions the iframe needs (autoplay, encrypted media for DRM audio, fullscreen…);
  //  - loading="lazy": the browser can delay loading it until needed.
  dock.innerHTML = `<iframe class="spotify-embed" title="Spotify player" src="https://open.spotify.com/embed/playlist/${esc(playlistId)}?utm_source=generator&theme=0" height="152" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
}
// dockPlaylist(): tells other files which playlist is in the sidebar player right now.
export const dockPlaylist = () => dockId;

// ---- OAuth (PKCE, no client secret needed) ----
// tokens(): read the saved tokens. localStorage only stores text, so JSON.parse turns it back into
// an object. If nothing is saved, getItem gives null, `|| 'null'` turns that into the text 'null',
// and JSON.parse('null') gives null.
const tokens = () => JSON.parse(localStorage.getItem(TK) || 'null');
// saveTokens(d, prev): save what Spotify's token endpoint returned (d) as { access, refresh, exp }.
//  - access: the new access token;
//  - refresh: the new refresh token — but Spotify doesn't always send a new one when refreshing,
//    so `|| prev.refresh` keeps the previous one (prev defaults to {} when not given);
//  - exp: the moment it expires, in milliseconds since 1970. Date.now() is "now" in ms;
//    expires_in is in seconds, so ×1000 converts it to ms.
const saveTokens = (d, prev = {}) =>
  localStorage.setItem(TK, JSON.stringify({ access: d.access_token, refresh: d.refresh_token || prev.refresh, exp: Date.now() + d.expires_in * 1000 }));
// isConnected(): true if any tokens are saved. Boolean(x) turns any value into true/false.
export const isConnected = () => Boolean(tokens());
/*
 * disconnect() — log out of Spotify by forgetting the saved tokens. Inputs/returns: none.
 */
export function disconnect() {
  // Delete the saved tokens.
  localStorage.removeItem(TK);
  // Tell the user.
  toast('Spotify disconnected');
}

// b64url(buf): turn raw bytes into "base64url" text (the format PKCE requires).
//  - new Uint8Array(buf): view the bytes as a list of numbers 0–255;
//  - ...spread passes them all as separate arguments to String.fromCharCode, making one character per byte;
//  - btoa(...) encodes that as normal base64 text (uses A–Z, a–z, 0–9, +, / and = padding);
//  - then make it URL-safe: .replace(/\+/g, '-') turns every "+" into "-",
//    .replace(/\//g, '_') turns every "/" into "_", and .replace(/=+$/, '') removes the "=" padding
//    at the end (=+$ means "one or more = signs at the very end"). The g flag means "replace all".
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/*
 * connect() — start the Spotify login by sending the browser to Spotify's authorize page.
 * Inputs: none. Returns: a Promise (it's async); the page navigates away so nothing useful is returned.
 * `async` lets the function use `await` to wait for slow operations (here: hashing).
 */
export async function connect() {
  // Our Spotify app's public client id (from SPOTIFY_CLIENT_ID in the server's .env).
  const clientId = getStatus().spotifyClientId;
  // Not configured: explain what to do (message stays for 7 seconds) and stop.
  if (!clientId) return toast('Add SPOTIFY_CLIENT_ID to your .env to connect an account (see README)', { timeout: 7000 });
  // The PKCE secret: 48 cryptographically random bytes, as base64url text.
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  // The challenge: SHA-256 hash ("fingerprint") of the verifier text, as base64url.
  // TextEncoder turns the text into bytes; crypto.subtle.digest hashes them and returns a Promise,
  // so `await` waits for the result.
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  // Save the verifier — we'll need it after Spotify sends us back (the page reloads, so memory is lost).
  localStorage.setItem(TK + ':verifier', verifier);
  // Go to Spotify's login page. URLSearchParams turns the object into "?client_id=…&response_type=code&…":
  //  - response_type 'code': we want a one-time code back;
  //  - redirect_uri: where to return; scope: the permissions;
  //  - code_challenge_method 'S256' + code_challenge: the PKCE fingerprint.
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge,
  });
}

/*
 * handleCallback() — runs when Spotify sends the user back to /callback (app.js calls it at startup).
 * Trades the one-time code (+ our saved verifier) for tokens and saves them.
 * Inputs: none (reads the URL). Returns: a Promise; nothing useful inside.
 */
export async function handleCallback() {
  // Read the "?code=…" or "?error=…" part of the URL.
  const p = new URLSearchParams(location.search);
  // Change the address bar to the Settings page without reloading, so the code isn't left in the URL
  // (and refreshing won't try to reuse it).
  history.replaceState(null, '', '/#/settings');
  // Spotify reported an error: 'access_denied' means the user clicked Cancel; otherwise show the error.
  if (p.get('error')) return toast(p.get('error') === 'access_denied' ? 'Spotify connect was cancelled' : `Spotify: ${p.get('error')}`, { timeout: 8000 });
  // The one-time code from Spotify.
  const code = p.get('code');
  // The secret we saved in connect().
  const verifier = localStorage.getItem(TK + ':verifier');
  // Without both, we can't finish — quietly stop.
  if (!code || !verifier) return;
  // try/catch: if anything inside throws an error, jump to catch instead of crashing.
  try {
    // Ask Spotify's token endpoint to swap the code for tokens. `await` waits for the reply.
    const r = await fetch('https://accounts.spotify.com/api/token', {
      // POST = we're sending data.
      method: 'POST',
      // Spotify expects form-style data (like an HTML form), not JSON.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // The form fields. `code,` is shorthand for `code: code`. code_verifier proves we started this login.
      body: new URLSearchParams({ client_id: getStatus().spotifyClientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier }),
    });
    // Read the reply body as JSON (contains the tokens, or an error).
    const d = await r.json();
    // r.ok is false for HTTP errors (status 400+).
    if (!r.ok) {
      // Spotify's explanation, if any.
      const why = d.error_description || d.error || '';
      // Turn common problems into helpful messages:
      //  - /redirect/i matches the word "redirect" anywhere, ignoring upper/lower case (the i flag)
      //    -> the redirect URI in the Spotify dashboard doesn't match;
      //  - /client/i matches "client" (any case) -> wrong client id;
      //  - otherwise just use Spotify's text.
      // `throw` jumps to the catch block below.
      throw new Error(/redirect/i.test(why)
        ? `redirect URI mismatch. In the Spotify dashboard it must be exactly ${redirectUri()}`
        : /client/i.test(why) ? 'wrong SPOTIFY_CLIENT_ID. Copy it again from the Spotify dashboard' : why);
    }
    // Success: save the tokens…
    saveTokens(d);
    // …the verifier is single-use, so delete it…
    localStorage.removeItem(TK + ':verifier');
    // …and celebrate.
    toast('spotify connected');
  } catch (e) {
    // Network failure or one of the errors thrown above.
    toast(`Spotify connect failed: ${e.message}`);
  }
}

/*
 * accessToken() — get a valid access token, refreshing it first if it's (about to be) expired.
 * Inputs: none. Returns: a Promise of the token text, or null if not connected / refresh failed.
 */
async function accessToken() {
  // The saved tokens.
  const t = tokens();
  // Not logged in.
  if (!t) return null;
  // Still valid for more than 60 seconds? Use it as is. (60_000 = 60,000 ms; the _ is just a
  // readability separator in numbers.) The 1-minute margin avoids it expiring mid-request.
  if (Date.now() < t.exp - 60_000) return t.access;
  // Otherwise ask Spotify for a new access token using the refresh token.
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: getStatus().spotifyClientId }),
  });
  // Refresh refused (e.g. user revoked access): forget the tokens so the app shows "connect" again.
  if (!r.ok) { localStorage.removeItem(TK); return null; }
  // Read the new tokens…
  const d = await r.json();
  // …save them (passing t so the old refresh token is kept if no new one was sent)…
  saveTokens(d, t);
  // …and return the fresh access token.
  return d.access_token;
}

/*
 * api(path, options) — call the Spotify Web API.
 * Inputs: path like '/me/player'; an options object with method (default 'GET') and an optional body.
 *   `{ method = 'GET', body } = {}` is destructuring with defaults: it unpacks those two fields from the
 *   object, and `= {}` means the whole object is optional.
 * Returns: a Promise of the parsed JSON reply, or null for "no content" replies. Throws an Error
 * (with .status = the HTTP status code) on failure.
 */
export async function api(path, { method = 'GET', body } = {}) {
  // Get a valid token (refreshing if needed).
  const token = await accessToken();
  // No token = not logged in.
  if (!token) throw new Error('Not connected');
  // Send the request.
  const r = await fetch(API + path, {
    // `method,` is shorthand for method: method.
    method,
    // Authorization header: "Bearer <token>" is how OAuth APIs expect the access token.
    // `...(body ? {...} : {})` spreads in a Content-Type header only when we're sending a body.
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    // Turn the body object into JSON text, or send nothing.
    body: body ? JSON.stringify(body) : undefined,
  });
  // 204 "No Content" / 202 "Accepted" = success with no reply body (common for play/pause).
  if (r.status === 204 || r.status === 202) return null;
  // Read the reply as text first (it might be empty).
  const text = await r.text();
  // Parse it as JSON only if there's something there.
  const data = text ? JSON.parse(text) : null;
  // HTTP error:
  if (!r.ok) {
    // Use Spotify's error message if present (`?.` avoids crashing if data or data.error is missing),
    // otherwise a generic "Spotify 403" style message.
    const err = new Error(data?.error?.message || `Spotify ${r.status}`);
    // Attach the status code so callers can react to specific errors (403, 404…).
    err.status = r.status;
    // Hand the error to whoever called api().
    throw err;
  }
  // Success: return the data.
  return data;
}

/*
 * playOnDevice(playlistId) — play a playlist on the user's active Spotify app (phone/desktop),
 * falling back to the sidebar embed if that isn't possible.
 * Input: a playlist id. Returns: a Promise; nothing useful inside.
 */
async function playOnDevice(playlistId) {
  try {
    // Ask Spotify to start this playlist. context_uri is Spotify's own address format: "spotify:playlist:<id>".
    await api('/me/player/play', { method: 'PUT', body: { context_uri: `spotify:playlist:${playlistId}` } });
    // It worked.
    toast('Playing on your Spotify device');
  } catch (e) {
    // It failed, so load it in the sidebar player instead…
    loadDock(playlistId);
    // …and explain why: 404 = no Spotify app is open/active; 403 = remote control needs Premium;
    // anything else = show the raw message. (\' is an escaped apostrophe inside a single-quoted string.)
    toast(e.status === 404 ? 'No active Spotify device, so it\'s loaded in the sidebar player instead' : e.status === 403 ? 'Remote control needs Spotify Premium, so it\'s loaded in the sidebar player' : e.message);
  }
}

// ---- Panel used on Focus + Home ----
/*
 * renderSpotify(el, modeKey) — draw the "soundtrack" panel: playlist buttons for each focus phase,
 * and (if logged in) now-playing info, play controls and your own playlists.
 * Inputs: el = the box to draw into; modeKey = the current focus phase's playlist key (default 'chill').
 * Returns: nothing.
 */
export function renderSpotify(el, modeKey = 'chill') {
  // The saved playlists per phase, e.g. { chill: { name, id }, rampup: {...}, ... }.
  const pls = store.get().settings.playlists;
  // If the sidebar player is empty, load this phase's playlist into it.
  // `pls[modeKey]?.id`: the id, or undefined if there's no playlist for this key.
  if (!dockId) loadDock(pls[modeKey]?.id);
  // Remember whether we're logged in (used many times below).
  const connected = isConnected();
  // Friendly phase names to show under each playlist (chill is used by both drift and rising).
  const modeLabels = { chill: 'drift / rising', rampup: 'gravity', lockin: 'eclipse', examday: 'liftoff' };

  // Build the panel HTML (template literal; ${...} inserts values):
  //  - If connected: a "now playing" row (empty image + "Loading…" text, filled in by poll() below)
  //    and three control buttons; data-c says which command each sends (previous / toggle / next).
  //  - A small caption; its top margin is 14px when the controls are shown, 0 otherwise, and it adds
  //    "· plays in the sidebar" when not connected.
  //  - A grid of playlist buttons: Object.entries(pls) gives [key, playlist] pairs, unpacked with
  //    destructuring `([k, p])`. Each button has data-pl = the playlist id, class "on" if it's the one
  //    in the sidebar now, the playlist name, the phase label, and " · now" for the current phase.
  //  - An empty <div id="mine"> that will hold "Your playlists" later (if connected).
  //  - If NOT connected: a line inviting you to connect plus a "connect spotify" button.
  el.innerHTML = `
    ${connected ? `<div class="now-playing" id="np"><img alt=""><div><div class="t muted">Loading…</div><div class="small muted"></div></div></div>
      <div class="player-controls"><button class="icon-btn" data-c="previous" title="Previous">⏮</button><button class="icon-btn" data-c="toggle" title="Play/Pause">⏯</button><button class="icon-btn" data-c="next" title="Next">⏭</button></div>` : ''}
    <div class="small muted" style="margin:${connected ? '14px' : '0'} 0 8px">one playlist per phase ${connected ? '' : '· plays in the sidebar'}</div>
    <div class="playlist-grid">
      ${Object.entries(pls).map(([k, p]) => `<button class="pl-btn ${dockId === p.id ? 'on' : ''}" data-pl="${esc(p.id)}"><b>${esc(p.name)}</b><small>${modeLabels[k] || k}${k === modeKey ? ' · now' : ''}</small></button>`).join('')}
    </div>
    <div id="mine"></div>
    ${connected ? '' : `<div class="row spread" style="margin-top:14px"><span class="small muted">connect to see what’s playing and use your own playlists.</span><button class="btn spotify sm" id="sp-connect">connect spotify</button></div>`}
  `;

  // Playlist buttons: when clicked…
  el.querySelectorAll('[data-pl]').forEach((b) => (b.onclick = () => {
    // …play it on the user's device if logged in…
    if (connected) playOnDevice(b.dataset.pl);
    // …otherwise in the sidebar player.
    else loadDock(b.dataset.pl);
    // Highlight only the clicked button (toggle 'on' = true for b, false for the others).
    el.querySelectorAll('.pl-btn').forEach((x) => x.classList.toggle('on', x === b));
  }));
  // The connect button (only exists when not connected; `?.` skips it otherwise) starts the login.
  el.querySelector('#sp-connect')?.addEventListener('click', connect);
  // Everything below needs a login, so stop here if not connected.
  if (!connected) return;

  // Control buttons (previous / play-pause / next):
  el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = async () => {
    try {
      // Which command this button sends.
      const c = b.dataset.c;
      if (c === 'toggle') {
        // Play/pause: first ask whether something is playing…
        const st = await api('/me/player');
        // …then pause if playing, play if not.
        await api(st?.is_playing ? '/me/player/pause' : '/me/player/play', { method: 'PUT' });
      // previous/next: POST to /me/player/previous or /me/player/next.
      } else await api(`/me/player/${c}`, { method: 'POST' });
      // Refresh the now-playing info shortly after (0.4 s), giving Spotify time to switch songs.
      setTimeout(poll, 400);
    } catch (e) {
      // Friendly explanations for the common errors.
      toast(e.status === 403 ? 'Playback control requires Spotify Premium' : e.status === 404 ? 'Open Spotify on a device first' : e.message);
    }
  }));

  // poll(): fetch "what's playing now" and update the now-playing row.
  // Returns (a Promise of) false if the panel is gone from the page (so polling can stop), else true.
  const poll = async () => {
    // The now-playing row.
    const np = el.querySelector('#np');
    // If it's missing or no longer attached to the page (user left the page), report false.
    if (!np || !np.isConnected) return false;
    try {
      // Ask Spotify for the current track.
      const d = await api('/me/player/currently-playing');
      // The track object, if anything is playing (`?.` = undefined if d is null).
      const item = d?.item;
      // Album art: try the medium image (index 1), then the large one (index 0), else no image.
      np.querySelector('img').src = item?.album?.images?.[1]?.url || item?.album?.images?.[0]?.url || '';
      // Song name, or "Nothing playing".
      np.querySelector('.t').textContent = item ? item.name : 'Nothing playing';
      // Grey the text out when nothing is playing.
      np.querySelector('.t').classList.toggle('muted', !item);
      // Artist names joined with commas, plus " · paused" if it's paused; or a hint if nothing's playing.
      np.querySelector('.small').textContent = item ? item.artists.map((a) => a.name).join(', ') + (d.is_playing ? '' : ' · paused') : 'Start something on any device';
    } catch (e) {
      // Show what went wrong in the row: 403 = Spotify app restrictions, 401 = login expired, else the message.
      np.querySelector('.t').textContent = e.status === 403
        ? 'Spotify blocked access: the app owner needs Premium, and your account must be added under User Management in the Spotify dashboard'
        : e.status === 401 ? 'Session expired, reconnect in Settings' : e.message;
    }
    // The panel is still on screen.
    return true;
  };
  // Check right away…
  poll();
  // …then every 6 seconds. If poll() says the panel is gone, stop the repeating timer with clearInterval.
  const iv = setInterval(async () => { if (!(await poll())) clearInterval(iv); }, 6000);

  // Load up to 12 of the user's own playlists. This uses .then/.catch instead of await:
  // .then(fn) runs fn with the result when the request finishes; .catch(fn) runs if it fails.
  api('/me/playlists?limit=12')
    .then((d) => {
      // The box to put them in.
      const mine = el.querySelector('#mine');
      // Stop if the box is gone or there are no playlists (`?.` guards against missing data).
      if (!mine || !d?.items?.length) return;
      // Build a heading plus a grid of buttons. .filter(Boolean) drops empty (null) entries Spotify
      // sometimes returns; each button has data-mine = playlist id, the name, and the track count
      // (`?? ''` shows nothing if the count is missing).
      mine.innerHTML = `<div class="small muted" style="margin:14px 0 8px">Your playlists</div><div class="playlist-grid">${d.items.filter(Boolean).map((p) => `<button class="pl-btn" data-mine="${esc(p.id)}"><b>${esc(p.name)}</b><small>${p.tracks?.total ?? ''} tracks</small></button>`).join('')}</div>`;
      // Clicking one plays it on the user's device.
      mine.querySelectorAll('[data-mine]').forEach((b) => (b.onclick = () => playOnDevice(b.dataset.mine)));
    })
    // Ignore errors here — the "your playlists" section is just a bonus.
    .catch(() => {});
}
