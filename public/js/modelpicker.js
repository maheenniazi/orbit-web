/*
 * modelpicker.js — the little "which AI model?" button.
 *
 * What you see: a pill-shaped button showing the AI model currently in use (e.g. "Claude Sonnet").
 * Clicking it opens a floating menu with a search box and every available model, grouped by
 * provider (Anthropic, OpenAI, Google, Kiro…). Picking one makes it the model used everywhere
 * (chat, notes, syllabus and careers all call ask() in ai.js, which reads the chosen model).
 *
 * Main ideas for a beginner:
 *   - The list of models comes from ai.js (which asks our server's /api/models endpoint).
 *   - The picker redraws itself from scratch (re-sets innerHTML) whenever something changes.
 *   - "Closures": the inner functions remember the variables `open` and `query` of the picker
 *     they were created in, so each picker on the page keeps its own open/closed state.
 *   - mountModelPicker returns a "cleanup" function that removes the page-wide listeners again.
 */
// Model picker: a pill showing the current model that opens a searchable menu grouped by provider.
// Import helpers from ai.js: is AI on? load/read the model list, read/set the chosen model,
// get a model's display info, and subscribe to "model changed" notifications.
import { aiEnabled, loadModels, getCatalog, getModel, setModel, modelInfo, onModelChange } from './ai.js';
// esc() makes text safe to put inside HTML (turns < > & " ' into harmless codes).
import { esc } from './util.js';
// toast() shows a small temporary message at the bottom of the screen.
import { toast } from './ui.js';

// Put popular picks first within each provider
/*
 * rank(m) — gives a model a sort number; SMALLER numbers are shown FIRST.
 * Input: m = a model object from the catalog (we use m.model, the raw model name).
 * Returns: a number. Big/flagship models get pulled up, previews pushed down,
 * and newer version numbers come before older ones.
 */
function rank(m) {
  // Lowercase the model name so the checks below don't care about capital letters.
  const id = m.model.toLowerCase();
  // The special "default"/"auto" entries always go to the very top.
  if (id === 'default' || id === 'auto') return -100;
  // Start at 0 and adjust up/down. `let` because we change it below (`const` can't be changed).
  let r = 0;
  // Flagship models: -30. The regex matches "opus", "pro" at the end of a word, "-pro",
  // "gpt-5" as long as "mini" or "nano" doesn't appear later ((?!...) means "not followed by"),
  // or "sol" at the end of a word. (\b = a word boundary.)
  if (/opus|pro\b|-pro|gpt-5(?!.*(mini|nano))|sol\b/.test(id)) r -= 30;
  // Mid-tier models: -20. Matches "sonnet", "flash" (but not "flash-lite"), "gpt-4.1"
  // (\. = a literal dot), "gpt-4o" (but not "gpt-4o-mini"), or "terra".
  if (/sonnet|flash(?!-lite)|gpt-4\.1|gpt-4o(?!-mini)|terra/.test(id)) r -= 20;
  // Small/fast models: -10. Matches "haiku", "mini", "lite", "nano" or "luna" anywhere in the name.
  if (/haiku|mini|lite|nano|luna/.test(id)) r -= 10;
  // Preview/experimental models get pushed down a bit (+5). Matches "preview", "exp" or "experimental".
  if (/preview|exp|experimental/.test(id)) r += 5;
  // Find the first number in the name, like "4" or "3.5": (\d+(?:\.\d+)?) = digits, optionally
  // followed by a dot and more digits. match() returns null if there's no number, so `|| []`
  // gives an empty array; [1] is the captured number (or undefined), and `|| 0` falls back to 0.
  // parseFloat turns the text "3.5" into the number 3.5.
  const v = parseFloat((id.match(/(\d+(?:\.\d+)?)/) || [])[1] || 0);
  // Subtract the version so a bigger version number gives a smaller rank (shown earlier).
  return r - v; // newer versions first
}

/*
 * mountModelPicker(host, { compact }) — builds the picker inside an element and keeps it updated.
 * Inputs:
 *   host    — the HTML element to draw the picker into.
 *   compact — optional; true = smaller pill without the provider name. Default false.
 *   `{ compact = false } = {}` is "destructuring with defaults": it pulls `compact` out of the
 *   options object, uses false if it's missing, and `= {}` means the whole object is optional.
 * Returns: a cleanup function. Call it when the picker is removed from the page so its
 *   document/window listeners don't keep running.
 */
export function mountModelPicker(host, { compact = false } = {}) {
  // No AI configured? Show nothing and return a cleanup function that does nothing.
  // `() => {}` is an arrow function (a short way to write a function) with an empty body.
  if (!aiEnabled()) { host.innerHTML = ''; return () => {}; }
  // Is the menu currently open? Starts closed.
  let open = false;
  // What's typed in the search box (starts empty).
  let query = '';

  /*
   * draw() — (re)build the whole picker's HTML from the current state, then attach click handlers.
   * Inputs: none (it uses `open`, `query`, `host`, `compact` from the surrounding function — a closure).
   * Returns: nothing.
   */
  const draw = () => {
    // The current list of models (plus per-provider errors).
    const cat = getCatalog();
    // Display info about the model currently in use: { id, label, provider, providerLabel, ... }.
    const cur = modelInfo();
    // Replace the host's contents with a template literal (a backtick string where ${...}
    // inserts a value). It builds:
    //   - an outer <div class="mp"> (plus class "compact" when compact is true),
    //   - the pill <button>: aria-haspopup/aria-expanded tell screen readers it opens a list and whether it's open,
    //     a colored dot (data-p = provider, used by CSS to pick the color), the model label,
    //     the provider name (only when not compact), and a little caret arrow,
    //   - and, only when open, the dropdown menu built by menu().
    // Every piece of text is passed through esc() so odd characters can't break the HTML.
    // `cur.provider || ''` means "use the provider, or an empty string if there is none".
    host.innerHTML = `
      <div class="mp ${compact ? 'compact' : ''}">
        <button class="mp-btn" type="button" aria-haspopup="listbox" aria-expanded="${open}">
          <span class="mp-dot" data-p="${esc(cur.provider || '')}"></span>
          <span class="mp-cur">${esc(cur.label)}</span>
          ${compact ? '' : `<span class="mp-prov">${esc(cur.providerLabel || '')}</span>`}
          <span class="mp-caret"></span>
        </button>
        ${open ? menu(cat, cur.id) : ''}
      </div>`;
    // Grab the pill button we just created.
    const btn = host.querySelector('.mp-btn');
    // Clicking the pill: stopPropagation() stops the click from reaching the document-wide
    // "click outside closes the menu" listener (below), which would close it right away.
    // Then flip open/closed, clear the search, redraw, and if it's now open put the cursor in the search box.
    // `?.` (optional chaining) = only call focus() if the search box was found.
    btn.onclick = (e) => { e.stopPropagation(); open = !open; query = ''; draw(); if (open) host.querySelector('.mp-search')?.focus(); };
    // If the menu is closed there's nothing else to wire up, so stop here.
    if (!open) return;
    // Position the floating menu next to the button (see placeMenu below).
    placeMenu(btn, host.querySelector('.mp-menu'));
    // The search box inside the menu.
    const search = host.querySelector('.mp-search');
    // Every keystroke in the search box: remember the text, and replace ONLY the list part
    // (outerHTML swaps the element itself) with a freshly filtered list. We don't redraw everything,
    // because that would recreate the search box and the cursor would lose its place.
    // Then wire click handlers onto the new list buttons.
    search.oninput = () => { query = search.value; const list = host.querySelector('.mp-list'); list.outerHTML = listHTML(getCatalog(), getModel(), query); wireList(); };
    // Keyboard shortcuts in the search box.
    search.onkeydown = (e) => {
      // Escape: close the menu, redraw, and put keyboard focus back on the pill button.
      if (e.key === 'Escape') { open = false; draw(); btn.focus(); }
      // Enter: pick the first model shown in the (filtered) list, if there is one.
      // [data-model] finds elements that have a data-model attribute; .dataset.model reads it.
      if (e.key === 'Enter') { const first = host.querySelector('[data-model]'); if (first) choose(first.dataset.model); }
    };
    // The "refresh list" button. `async` lets us use `await` inside: it pauses until the Promise finishes.
    host.querySelector('.mp-refresh').onclick = async (e) => {
      // Don't let this click close the menu.
      e.stopPropagation();
      // Show feedback on the button while we wait.
      e.target.textContent = 'refreshing…';
      // Ask ai.js to re-download the model list from the server (skipping caches).
      await loadModels({ refresh: true });
      // Redraw with the new list.
      draw();
    };
    // Any click inside the menu (search box, empty space…) shouldn't reach the document and close it.
    host.querySelector('.mp-menu').onclick = (e) => e.stopPropagation();
    // Attach click handlers to each model button in the list.
    wireList();
  };

  // wireList(): find every model button (anything with data-model) and make clicking it choose that model.
  // (It's defined after draw, which is fine: draw only runs it later, after this line has run.)
  const wireList = () => host.querySelectorAll('[data-model]').forEach((b) => (b.onclick = () => choose(b.dataset.model)));
  /*
   * choose(id) — switch to a model.
   * Input: the model id string (e.g. "anthropic:claude-..."). Returns: nothing.
   */
  const choose = (id) => {
    // Mark the menu closed FIRST: setModel notifies subscribers, which calls draw(), and we want that redraw closed.
    open = false; // before setModel, which redraws
    // Save the choice (ai.js stores it in localStorage and tells everyone).
    setModel(id);
    // Confirm with a toast; `${...}` in backticks inserts the model's friendly label.
    toast(`now using ${modelInfo(id).label}`);
  };

  // Clicking anywhere on the page closes the menu (clicks on the picker itself were stopped above).
  const closeOnOutside = () => { if (open) { open = false; draw(); } };
  // Listen for clicks on the whole document.
  document.addEventListener('click', closeOnOutside);
  // When the window resizes or anything scrolls, the floating menu would be in the wrong spot, so close it —
  // except when the scroll is happening inside the menu itself (scrolling the model list).
  // `.contains(e.target)` checks whether the scrolled element is inside the menu.
  const closeOnMove = (e) => { if (open && !host.querySelector('.mp-menu')?.contains(e.target)) { open = false; draw(); } };
  // Close on window resize.
  window.addEventListener('resize', closeOnMove);
  // Close on scroll. Scroll events don't "bubble" up, so `true` (capture mode) is needed to hear
  // scrolls of ANY element on the page, not just the document itself.
  document.addEventListener('scroll', closeOnMove, true);
  // Redraw whenever the model list or chosen model changes. onModelChange returns an "unsubscribe" function; we keep it in `off`.
  const off = onModelChange(draw);
  // Start loading the model list; when it arrives (.then), redraw so the real names show.
  loadModels().then(draw);
  // Draw right away (it may show a placeholder label until the list arrives).
  draw();
  // Return the cleanup function: remove every listener we added and unsubscribe from model changes.
  return () => { document.removeEventListener('click', closeOnOutside); window.removeEventListener('resize', closeOnMove); document.removeEventListener('scroll', closeOnMove, true); off(); };
}

// Float the menu above everything (so pop-up windows and cards can't clip it),
// opening downward if there's room, otherwise upward, and staying on screen.
/*
 * placeMenu(btn, m) — positions the dropdown menu on screen.
 * Inputs: btn = the pill button element; m = the menu element (may be null).
 * Returns: nothing (it changes m's inline styles).
 */
function placeMenu(btn, m) {
  // No menu element? Nothing to place.
  if (!m) return;
  // The button's position and size on screen (top, bottom, left, right in pixels).
  const r = btn.getBoundingClientRect();
  // Keep at least 8px of space from the window edges.
  const pad = 8;
  // Menu width: 330px, but never wider than the window minus the padding on both sides.
  const width = Math.min(330, window.innerWidth - pad * 2);
  // How much room there is under the button.
  const below = window.innerHeight - r.bottom - pad;
  // How much room there is above the button.
  const above = r.top - pad;
  // Open upward only if there's not much room below (< 300px) AND there's more room above.
  const up = below < 300 && above > below;
  // Max height: use the available room (minus a 6px gap), capped at 440px, but at least 200px.
  // `(up ? above : below)` is the ternary operator: "if up then above else below".
  const maxH = Math.max(200, Math.min(440, (up ? above : below) - 6));
  // Object.assign copies all these properties onto m.style at once (setting inline CSS).
  Object.assign(m.style, {
    // "fixed" = positioned relative to the browser window, so no parent box can clip it.
    position: 'fixed',
    // CSS needs units, so add "px".
    width: `${width}px`,
    maxHeight: `${maxH}px`,
    // Line the menu's right edge up with the button's right edge (r.right - width),
    // but clamp it so it never goes past the right edge or left edge of the window.
    left: `${Math.max(pad, Math.min(r.right - width, window.innerWidth - width - pad))}px`,
    // Opening down: start 6px below the button. Opening up: don't set top.
    top: up ? 'auto' : `${r.bottom + 6}px`,
    // Opening up: anchor the menu's bottom 6px above the button (measured from the window's bottom).
    bottom: up ? `${window.innerHeight - r.top + 6}px` : 'auto',
    // Clear any right value from the stylesheet so it doesn't fight with `left`.
    right: 'auto',
  });
}

/*
 * menu(cat, currentId) — builds the HTML for the whole dropdown menu.
 * Inputs: cat = the model catalog { models, errors }; currentId = id of the model in use.
 * Returns: an HTML string.
 */
function menu(cat, currentId) {
  // Turn the errors object { provider: message } into a list of [provider, message] pairs.
  // `cat.errors || {}` uses an empty object if there are no errors.
  const errs = Object.entries(cat.errors || {});
  // The template below builds:
  //   - the menu <div> (role="listbox" helps screen readers),
  //   - a search <input>,
  //   - the model list (from listHTML, with an empty search so everything shows),
  //   - if some providers failed to load, a box listing "provider: error" for each
  //     (map turns each [p, e] pair into a <div>, join('') glues them together),
  //   - a footer saying where the model is used, plus the "refresh list" button.
  //   (&amp; is how you write a literal "&" in HTML.)
  return `<div class="mp-menu" role="listbox">
    <input class="mp-search" placeholder="search models…" value="">
    ${listHTML(cat, currentId, '')}
    ${errs.length ? `<div class="mp-err">${errs.map(([p, e]) => `<div><b>${esc(p)}:</b> ${esc(e)}</div>`).join('')}</div>` : ''}
    <div class="mp-foot"><span>used for chat, notes, syllabus &amp; careers</span><button class="mp-refresh" type="button">refresh list</button></div>
  </div>`;
}

/*
 * listHTML(cat, currentId, q) — builds the scrollable list of models, filtered by a search.
 * Inputs: cat = the catalog; currentId = model in use (gets highlighted); q = the search text.
 * Returns: an HTML string for <div class="mp-list">.
 */
function listHTML(cat, currentId, q) {
  // Split the search into words: lowercase, split on any whitespace (\s+), and drop empty strings
  // (filter(Boolean) keeps only "truthy" values, so "" disappears).
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  // Keep only models whose label + raw name + provider name contain EVERY search word.
  // ("hay" as in "haystack" — the text we search in.)
  const models = cat.models.filter((m) => { const hay = `${m.label} ${m.model} ${m.providerLabel}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  // No models at all yet: the list is still loading.
  if (!cat.models.length) return '<div class="mp-list"><div class="mp-empty">loading models…</div></div>';
  // Models exist, but none match the search.
  if (!models.length) return '<div class="mp-list"><div class="mp-empty">no models match</div></div>';
  // Group the models by provider name: { 'Anthropic': [...], 'OpenAI': [...] }.
  const groups = {};
  // For each model: `groups[x] ||= []` creates an empty array the first time we see that provider
  // (||= means "assign only if it's currently empty/undefined"), then push the model into it.
  for (const m of models) (groups[m.providerLabel] ||= []).push(m);
  // Build the list. For each [providerLabel, listOfModels] pair:
  //   - a group heading <div class="mp-group"> with the provider name,
  //   - the models sorted by rank() (smaller first), each as a <button>:
  //       class "on" + aria-selected="true" for the current model,
  //       data-model = its id (read by wireList / Enter to choose it),
  //       its friendly label, plus the raw model name in <small> when it differs from the label,
  //       and an empty <i> (styled by CSS as a marker) on the current model.
  // The inner .join('') glues the buttons together; the outer .join('') glues the groups together.
  return `<div class="mp-list">${Object.entries(groups).map(([label, list]) => `
    <div class="mp-group">${esc(label)}</div>
    ${list.sort((a, b) => rank(a) - rank(b)).map((m) => `<button class="mp-item ${m.id === currentId ? 'on' : ''}" data-model="${esc(m.id)}" role="option" aria-selected="${m.id === currentId}">
      <span>${esc(m.label)}</span>${m.label.toLowerCase() !== m.model.toLowerCase() ? `<small>${esc(m.model)}</small>` : ''}${m.id === currentId ? '<i></i>' : ''}
    </button>`).join('')}`).join('')}</div>`;
}
