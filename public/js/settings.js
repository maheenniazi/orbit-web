/*
 * settings.js — the Settings page ("make it yours").
 *
 * Like every page in the app, it exports a render(el) function. app.js calls render() with the
 * empty box the page should be drawn into, and keeps the function render() returns so it can
 * "clean up" when you leave the page.
 * How it works, in three steps:
 *   1. draw() builds the whole page as one big HTML string (a template literal) from the saved
 *      data in the store (store.js), and puts it into the page with innerHTML.
 *   2. It then attaches "event handlers" (functions that run on click/change) to the inputs.
 *      Each handler saves the new value with store.update(...), which saves to localStorage.
 *   3. store.subscribe(...) re-runs draw() whenever data changes — except while you're typing in
 *      a text box, because redrawing would wipe out the box you're typing in.
 * Sections: your name + theme, automation switches, integrations (AI model, Spotify),
 * courses, focus playlists, and backup/restore/reset of all data.
 */

// Original note from the author:
// Settings: profile, theme, automation, courses, playlists, integrations, data.

// `import { a, b } from './file.js'` pulls in things another file exported.
// store = the app's saved data; COURSE_COLORS = the palette of course colors.
import { store, COURSE_COLORS } from './store.js';
// getStatus() = what we know about AI (server mode or website "bring your own key" mode).
// isBrowserMode() = true on the hosted website (no server); reloadForKeyChange() refreshes
// models after the visitor adds/removes a key.
import { getStatus, isBrowserMode, reloadForKeyChange } from './ai.js';
// byo = the "bring your own key" settings helpers (read/save keys, which providers are set up).
import * as byo from './byoai.js';
// mountModelPicker draws the "which AI model" dropdown into a box and returns an unmount function.
import { mountModelPicker } from './modelpicker.js';
// esc() makes text safe to put inside HTML (turns < > & " ' into harmless codes).
import { esc } from './util.js';
// toast() shows a small temporary message at the bottom of the screen.
import { toast } from './ui.js';
// Spotify helpers: log in, log out, check login, read a playlist id from a link, load the sidebar player.
import { connect, disconnect, isConnected, parsePlaylistId, loadDock } from './spotify.js';

/*
 * render(el) — draw the Settings page and wire up all its controls.
 * Input: el = the page element to draw into.
 * Returns: a cleanup function that app.js calls when you navigate away (stops listening for changes).
 */
/*
 * byoKeysSection() — HTML for the "bring your own AI key" controls, shown only on the hosted
 * website (browser mode). Each provider gets a password-style input pre-filled with any saved
 * key, plus (for OpenAI) a base-URL input because OpenAI can't be called straight from a
 * browser without a CORS-friendly proxy. Keys live only in this browser.
 */
function byoKeysSection() {
  // The currently saved keys/bases, so inputs show what's already there.
  const saved = byo.readKeys();
  // Help links + placeholders per provider.
  const meta = {
    anthropic: { ph: 'sk-ant-…', get: 'https://console.anthropic.com/settings/keys', note: 'works directly from your browser' },
    gemini: { ph: 'AIza…', get: 'https://aistudio.google.com/app/apikey', note: 'free tier available · works directly from your browser' },
    openai: { ph: 'sk-…', get: 'https://platform.openai.com/api-keys', note: 'needs a proxy base URL (OpenAI blocks direct browser calls)' },
  };
  // One block per provider.
  const block = (p) => {
    const m = meta[p];
    const cur = saved[p] || {};
    return `<div class="byo-row" data-byo="${p}" style="border-top:1px solid var(--line);padding-top:10px;margin-top:4px">
      <div class="row spread" style="margin-bottom:4px"><b>${esc(byo.PROVIDER_LABEL[p])}</b><a class="small" href="${m.get}" target="_blank" rel="noopener">get a key ↗</a></div>
      <input type="password" data-byo-key="${p}" value="${esc(cur.key || '')}" placeholder="${m.ph}" autocomplete="off" style="width:100%">
      ${p === 'openai' ? `<input data-byo-base="${p}" value="${esc(cur.base || '')}" placeholder="proxy base URL, e.g. https://my-proxy/v1" autocomplete="off" style="width:100%;margin-top:6px">` : ''}
      <div class="small muted" style="margin-top:4px">${esc(m.note)}</div>
    </div>`;
  };
  return `<div class="byo-keys" style="margin-top:6px">
    <p class="small muted" style="margin:0 0 2px">You're on the hosted version, so AI runs with <b>your own key</b>, saved only in this browser and sent straight to the AI provider — never to any orbit server.</p>
    ${['anthropic', 'gemini', 'openai'].map(block).join('')}
    <div class="row" style="margin-top:10px"><button class="btn sm" id="byo-save">save keys</button></div>
    <p class="small faint" style="margin:6px 0 0">Tip: use a key with a low spending limit. Anyone with access to this browser profile could read it. Running orbit locally with <code>node server.js</code> keeps keys in a <code>.env</code> file instead and also unlocks Kiro.</p>
  </div>`;
}

export function render(el) {
  // Holds the model picker's own cleanup function, so we can remove the old picker before drawing a new one.
  let unmountPicker = null;
  // draw(): (re)build the whole page. It's an arrow function `() => { ... }` — a compact way to write a function.
  // It's also a closure: it can use `el` and `unmountPicker` from render() above.
  const draw = () => {
    // s = all saved app data (courses, events, settings, …).
    const s = store.get();
    // st = server status, e.g. { ai: true, providers: [...], spotifyClientId: '...' }.
    const st = getStatus();
    // Friendly names for each playlist slot (these match the focus-phase names in focus.js).
    const labels = { chill: 'drift / rising', rampup: 'gravity', lockin: 'eclipse', examday: 'liftoff' };
    // Build the page HTML. This is a template literal (backtick string): `${...}` inserts the result
    // of a JavaScript expression. Walking through the cards in order:
    //  - Header: "settings / make it yours".
    //  - "You" card: a name input pre-filled with your saved name (esc() makes it safe), and a
    //    two-button theme switch (paper/night); the button matching the saved theme gets class "on".
    //  - "Automation" card: three checkboxes. `${cond ? 'checked' : ''}` adds the checked attribute
    //    when the setting is on. autoPrep counts as on unless it's exactly false (so new users get it on).
    //    The number box shows prepDays, and `?? 5` means "use 5 if prepDays is null/undefined"
    //    (`??` is the "nullish coalescing" operator — unlike `||`, it keeps 0).
    //  - "Integrations" card: if AI is set up (st.ai), an empty <div id="set-picker"> where the model
    //    picker gets mounted, plus a line listing the connected providers (joined with commas);
    //    otherwise an "offline" tag. Then Spotify: a Disconnect button if logged in, else a Connect
    //    button that's disabled (with a tooltip) when no SPOTIFY_CLIENT_ID is set. If there's no client
    //    id, a numbered how-to list is shown, including this site's redirect URI and a Copy button.
    //  - "Courses" card: for each course, a row (data-c = course id) with a color picker, code input,
    //    name input and a delete ✕ button; .map(...) builds one row string per course and .join('')
    //    glues them together. With no courses, a placeholder message is shown instead.
    //  - "Focus playlists" card: Object.entries(obj) gives [key, value] pairs; `([k, p]) =>` uses
    //    "destructuring" to unpack each pair into k (e.g. 'chill') and p ({ name, id }). Each becomes
    //    a labelled input holding the full playlist link, with data-pl = the slot key.
    //  - "Data" card: Export button, an Import button (a <label> wrapping a hidden file input — clicking
    //    the label opens the file picker), and a Reset button.
    el.innerHTML = `
      <div class="page-head"><div><div class="kicker">settings</div><h1>make it <em>yours</em></h1></div></div>
      <div class="grid cols-3">
        <div class="card stack">
          <h3>You</h3>
          <label class="field">Your name<input id="name" value="${esc(s.settings.name)}" placeholder="What should we call you?"></label>
          <div class="row spread"><span>Theme</span><div class="seg" id="theme"><button data-t="light" class="${s.settings.theme === 'light' ? 'on' : ''}">paper</button><button data-t="dark" class="${s.settings.theme === 'dark' ? 'on' : ''}">night</button></div></div>
        </div>
        <div class="card stack">
          <h3>Automation</h3>
          <label class="check"><input type="checkbox" id="autoFocus" ${s.settings.autoFocus ? 'checked' : ''}> Auto-escalate focus mode as exams approach</label>
          <label class="check"><input type="checkbox" id="autoPlan" ${s.settings.autoStudyPlan ? 'checked' : ''}> Auto-schedule study sessions before exams</label>
          <label class="check"><input type="checkbox" id="autoPrep" ${s.settings.autoPrep !== false ? 'checked' : ''}> make a cheat sheet + practice test from my notes <input type="number" id="prepDays" min="1" max="21" value="${s.settings.prepDays ?? 5}" style="width:58px;padding:4px 6px;display:inline-block"> days before each exam</label>
          <p class="small muted" style="margin:0">drift → rising (14 days out) → gravity (7) → eclipse (3) → liftoff (exam day).</p>
        </div>
        <div class="card stack">
          <h3>Integrations</h3>
          <div class="row spread"><span>AI model</span>${st.ai ? '<div id="set-picker"></div>' : '<span class="tag" style="--c:#b98a2e">offline</span>'}</div>
          ${st.ai && !isBrowserMode() ? `<p class="small muted" style="margin:0">connected: ${esc((st.providers || []).join(', '))}. add more keys in <code>.env</code> to get more models.</p>` : ''}
          ${isBrowserMode() ? byoKeysSection() : ''}
          <div class="row spread"><span>Spotify</span>${isConnected() ? '<button class="btn danger sm" id="sp-off">Disconnect</button>' : `<button class="btn spotify sm" id="sp-on" ${st.spotifyClientId ? '' : 'disabled title="Set SPOTIFY_CLIENT_ID in .env"'}>Connect</button>`}</div>
          ${st.spotifyClientId ? '' : `<div class="small muted">
            <b style="color:var(--text)">To connect your Spotify account:</b>
            <ol style="margin:6px 0 0;padding-left:18px;line-height:1.7">
              <li>Create an app at <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> (requires Spotify Premium)</li>
              <li>Redirect URI: <code>${esc(location.origin)}/callback</code> <button class="btn ghost sm" id="copy-uri" style="padding:2px 8px">Copy</button></li>
              <li>Tick <b>Web API</b>, save, then copy the <b>Client ID</b></li>
              <li>Add <code>SPOTIFY_CLIENT_ID=…</code> to <code>.env</code> and restart the server</li>
            </ol>
            <p style="margin:6px 0 0">The sidebar player works without any of this.</p></div>`}
        </div>
        <div class="card stack">
          <h3>Courses</h3>
          ${s.courses.length ? s.courses.map((c) => `<div class="row" data-c="${c.id}">
            <input type="color" value="${c.color}" data-color style="width:36px;height:36px;padding:2px;flex:none">
            <input value="${esc(c.code)}" data-code placeholder="Code" style="width:100px;flex:none">
            <input value="${esc(c.name)}" data-name placeholder="Name" style="flex:1;width:auto">
            <button class="icon-btn" data-del title="Delete course and its events">✕</button></div>`).join('') : '<div class="empty">Courses appear when you import a syllabus.</div>'}
        </div>
        <div class="card stack">
          <h3>Focus playlists</h3>
          ${Object.entries(s.settings.playlists).map(([k, p]) => `<label class="field">${labels[k] || k}<input data-pl="${k}" value="https://open.spotify.com/playlist/${esc(p.id)}" placeholder="Spotify playlist link"></label>`).join('')}
          <p class="small muted" style="margin:0">Paste any Spotify playlist link.</p>
        </div>
        <div class="card stack">
          <h3>Data</h3>
          <p class="small muted" style="margin:0">Everything is stored locally in this browser.</p>
          <div class="row"><button class="btn ghost sm" id="export">Export backup</button><label class="btn ghost sm">Import backup<input type="file" id="import" accept=".json" hidden></label></div>
          <button class="btn danger sm" id="reset" style="align-self:flex-start">Reset everything</button>
        </div>
      </div>`;

    // `$` is just a short helper name: $('#name') finds the first element inside this page matching the CSS selector.
    const $ = (q) => el.querySelector(q);
    // If the AI picker box exists: run the old picker's cleanup first (`?.()` = call it only if it exists),
    // then mount a fresh compact picker and remember its new cleanup function.
    if ($('#set-picker')) { unmountPicker?.(); unmountPicker = mountModelPicker($('#set-picker'), { compact: true }); }
    // "save keys" button (website / bring-your-own-key mode only): read each provider's input,
    // save it to this browser, then rebuild the model list so the picker shows the new models.
    $('#byo-save')?.addEventListener('click', async () => {
      // For each provider block, save the typed key (and base URL for OpenAI).
      el.querySelectorAll('[data-byo]').forEach((row) => {
        const p = row.dataset.byo;
        const keyVal = row.querySelector(`[data-byo-key="${p}"]`)?.value || '';
        const baseVal = row.querySelector(`[data-byo-base="${p}"]`)?.value || '';
        byo.setProviderKey(p, { key: keyVal, base: baseVal });
      });
      // Rebuild AI status + model catalog from the new keys.
      await reloadForKeyChange();
      // How many providers are set up now, for the confirmation message.
      const n = byo.configuredProviders().length;
      toast(n ? `AI keys saved · ${n} provider${n === 1 ? '' : 's'} ready` : 'keys cleared');
      // Redraw so the model picker appears/updates.
      draw();
    });
    // Name box: when it changes (on blur/Enter), save the trimmed text as settings.name.
    // `(x) => (x.settings.name = ...)`: the parentheses let an assignment be the arrow function's body.
    $('#name').onchange = (e) => store.update((x) => (x.settings.name = e.target.value.trim()));
    // Theme buttons: each has data-t="light" or "dark"; clicking saves that theme (app.js applies it).
    el.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => store.update((x) => (x.settings.theme = b.dataset.t))));
    // Checkbox: auto-escalate focus mode. e.target is the checkbox; .checked is true/false.
    $('#autoFocus').onchange = (e) => store.update((x) => (x.settings.autoFocus = e.target.checked));
    // Checkbox: automatically make exam prep (cheat sheet + practice test).
    $('#autoPrep').onchange = (e) => store.update((x) => (x.settings.autoPrep = e.target.checked));
    // Number box: how many days before an exam to make prep. Number(...) turns the text into a number;
    // `|| 5` falls back to 5 if it's empty/invalid (NaN or 0); Math.min/Math.max clamp it between 1 and 21.
    $('#prepDays').onchange = (e) => store.update((x) => (x.settings.prepDays = Math.max(1, Math.min(21, Number(e.target.value) || 5))));
    // Checkbox: auto-schedule study sessions before exams (used by syncStudyPlans in focus.js).
    $('#autoPlan').onchange = (e) => store.update((x) => (x.settings.autoStudyPlan = e.target.checked));
    // Spotify Connect button (only exists when not connected): start the Spotify login.
    // `?.` means: if the button isn't on the page, skip this instead of crashing.
    $('#sp-on')?.addEventListener('click', connect);
    // Disconnect button: forget the Spotify login, then redraw so the Connect button appears.
    $('#sp-off')?.addEventListener('click', () => { disconnect(); draw(); });
    // Copy button: put "<this site>/callback" on the clipboard; writeText returns a Promise, and
    // .then(...) runs the toast once copying has finished.
    $('#copy-uri')?.addEventListener('click', () => navigator.clipboard.writeText(`${location.origin}/callback`).then(() => toast('Redirect URI copied')));
    // Course rows: wire up each row's inputs.
    el.querySelectorAll('[data-c]').forEach((row) => {
      // The course id stored on the row (data-c="...").
      const id = row.dataset.c;
      // upd(patch): find this course in the saved data and copy the fields in `patch` onto it.
      // Object.assign(target, patch) overwrites target's fields with patch's, e.g. { color: '#fff' }.
      const upd = (patch) => store.update((x) => Object.assign(x.courses.find((c) => c.id === id), patch));
      // Color picker changed: save the new color.
      row.querySelector('[data-color]').onchange = (e) => upd({ color: e.target.value });
      // Code input changed: save the trimmed code.
      row.querySelector('[data-code]').onchange = (e) => upd({ code: e.target.value.trim() });
      // Name input changed: save the trimmed name.
      row.querySelector('[data-name]').onchange = (e) => upd({ name: e.target.value.trim() });
      // Delete button:
      row.querySelector('[data-del]').onclick = () => {
        // Ask first; if the user presses Cancel, confirm() returns false and we stop.
        if (!confirm('Delete this course and all of its events?')) return;
        // Keep every course except this one, and every event that doesn't belong to this course.
        // .filter(fn) makes a new array of only the items where fn returns true.
        store.update((x) => { x.courses = x.courses.filter((c) => c.id !== id); x.events = x.events.filter((e) => e.courseId !== id); });
      };
    });
    // Playlist link inputs: when one changes…
    el.querySelectorAll('[data-pl]').forEach((inp) => (inp.onchange = () => {
      // …pull the 22-character playlist id out of the pasted link (null if it isn't a playlist link).
      const pid = parsePlaylistId(inp.value);
      // Not a valid link: show a message and stop (return toast(...) both shows it and exits).
      if (!pid) return toast('That doesn’t look like a Spotify playlist link');
      // Save it into the slot named by data-pl (e.g. 'lockin') as { name, id }.
      // The name: if it's still one of the four built-in default names, rename it to 'Custom';
      // otherwise keep the existing name. The regex /^(Lofi Beats|Deep Focus|Brain Food|Peaceful Piano)$/
      // matches only text that is EXACTLY one of those four names (^ = start, $ = end, | = "or").
      store.update((x) => (x.settings.playlists[inp.dataset.pl] = { name: x.settings.playlists[inp.dataset.pl].name.replace(/^(Lofi Beats|Deep Focus|Brain Food|Peaceful Piano)$/, 'Custom') , id: pid }));
      // Start playing the new playlist in the sidebar player.
      loadDock(pid);
      // Confirm to the user.
      toast('Playlist saved');
    }));
    // Export button: download all data as a .json file.
    $('#export').onclick = () => {
      // Make an invisible link element…
      const a = document.createElement('a');
      // …pointing at a temporary in-memory file (a Blob) containing store.export() — the data as JSON text.
      // URL.createObjectURL gives that Blob a URL the browser can "download".
      a.href = URL.createObjectURL(new Blob([store.export()], { type: 'application/json' }));
      // File name like orbit-backup-2025-01-31.json. toISOString() gives "2025-01-31T12:00:00.000Z";
      // .slice(0, 10) keeps just the first 10 characters (the date).
      a.download = `orbit-backup-${new Date().toISOString().slice(0, 10)}.json`;
      // "Click" it from code to start the download.
      a.click();
    };
    // Import: when a file is chosen in the hidden file input…
    // `async` lets us use `await`, which pauses this function until a Promise finishes (here: reading the file).
    $('#import').onchange = async (e) => {
      // Read the first chosen file as text, hand it to store.import() (which replaces all data), and confirm.
      // If anything throws (e.g. the file isn't valid JSON), catch shows an error message instead.
      try { store.import(await e.target.files[0].text()); toast('Backup restored'); } catch { toast('Invalid backup file'); }
    };
    // Reset: ask for confirmation; `&&` only runs the right side if confirm() returned true.
    // `(store.reset(), toast(...))` uses the comma operator to run two things in a row.
    $('#reset').onclick = () => confirm('Erase all courses, events, notes and chats?') && (store.reset(), toast('fresh start'));
  };
  // Draw the page for the first time.
  draw();
  // Only re-render on non-text changes to avoid stealing input focus
  // Redraw when data changes, but only if: the focused element isn't on this page, OR it's a checkbox,
  // OR it's a button. (If you're typing in a text box here, a redraw would replace the box under your cursor.)
  // document.activeElement = whichever element currently has keyboard focus.
  // store.subscribe returns an "unsubscribe" function, kept in offStore.
  const offStore = store.subscribe(() => { if (!el.contains(document.activeElement) || document.activeElement.type === 'checkbox' || document.activeElement.tagName === 'BUTTON') draw(); });
  // The cleanup function app.js runs when leaving the page: stop listening for changes, and remove the model picker.
  return () => { offStore(); unmountPicker?.(); };
}

// Re-export COURSE_COLORS so other files could import it from settings.js too.
export { COURSE_COLORS };
