/*
 * ui.js — small reusable "UI building blocks" used all over the app.
 *
 * What lives here:
 *   - h(): turns a string of HTML into a real DOM element you can insert into the page.
 *   - toast(): the little pop-up message that appears at the bottom of the screen for a few seconds.
 *   - modal(): a pop-up dialog box (with a dark backdrop) that can be closed with ✕, Escape, or a click outside.
 *   - spinner(): the "Thinking…" animated dots shown while waiting for the AI.
 *   - It also re-exports the file-reading helpers from fileread.js so other files can import them from here.
 *
 * Beginner terms:
 *   - ES modules: `import { x } from './file.js'` pulls in something another file `export`ed.
 *   - DOM: the browser's live tree of elements that make up the page. We create/insert/remove elements in it.
 *   - Template literal: a string in backticks `like ${this}` where ${...} inserts a value into the string.
 *   - esc(): escapes characters like < and > so user text is shown as text, not run as HTML (prevents XSS attacks).
 */
// Import the HTML-escaping helper from util.js (see util.js for how it works).
import { esc } from './util.js';

/*
 * h(html) — "HTML to element".
 * Input: a string of HTML, e.g. '<div class="x">hi</div>'.
 * Returns: the first real DOM element built from that string (not yet on the page).
 */
export function h(html) {
  // A <template> element is a safe "scratch pad": HTML put inside it is parsed but not shown or run.
  const t = document.createElement('template');
  // Let the browser parse our string into elements. .trim() removes leading/trailing spaces/newlines
  // so the first child is the element itself, not a blank text node.
  t.innerHTML = html.trim();
  // Hand back the first element that was created from the string.
  return t.content.firstElementChild;
}

/*
 * toast(msg, options) — show a short pop-up notification.
 * Inputs:
 *   msg: the text to show.
 *   options (optional object): { action, onAction, timeout }
 *     action   — text for an optional button (e.g. "Undo").
 *     onAction — function to run when that button is clicked.
 *     timeout  — how many milliseconds before it disappears (default 5000 = 5 seconds).
 * Returns: nothing.
 * Note: `{ action, onAction, timeout = 5000 } = {}` is "destructuring" — it pulls those named
 * properties out of the object passed in. `= 5000` is a default value, and `= {}` means the
 * whole options object is optional.
 */
export function toast(msg, { action, onAction, timeout = 5000 } = {}) {
  // Find the container in index.html (<div id="toasts">) where all toasts are stacked.
  const root = document.getElementById('toasts');
  // Build the toast element: a <div class="toast"> with the escaped message in a <span>.
  // The `action ? ... : ''` part is a ternary (if/else in one line): if an action label was given,
  // add a small button with that (escaped) label; otherwise add nothing ('').
  const el = h(`<div class="toast"><span>${esc(msg)}</span>${action ? `<button class="btn ghost sm">${esc(action)}</button>` : ''}</div>`);
  // Put the toast on the page.
  root.appendChild(el);
  // Wait one animation frame, then add the "show" class. Doing it a frame later lets the CSS
  // transition (fade/slide in) actually animate instead of appearing instantly.
  // `() => ...` is an arrow function: a short way to write a function.
  requestAnimationFrame(() => el.classList.add('show'));
  // close is a small function that hides the toast and then removes it.
  const close = () => {
    // Remove "show" so the CSS fades it out.
    el.classList.remove('show');
    // After 300ms (time for the fade-out animation), delete the element from the page.
    setTimeout(() => el.remove(), 300);
  };
  // If there is a button inside the toast, listen for clicks on it.
  // `?.` is optional chaining: if querySelector found nothing (null), skip the rest instead of crashing.
  el.querySelector('button')?.addEventListener('click', () => {
    // Run the caller's onAction function, but only if one was given (`?.()` calls it only if it exists).
    onAction?.();
    // Then hide the toast.
    close();
  });
  // Automatically close the toast after `timeout` milliseconds.
  setTimeout(close, timeout);
}

/*
 * modal(title, bodyHTML, options) — open a pop-up dialog.
 * Inputs:
 *   title    — heading text for the dialog (escaped, so it's always plain text).
 *   bodyHTML — HTML string for the dialog's content (NOT escaped: the caller must make it safe).
 *   options  — { onMount, wide }
 *     onMount(bodyElement, close) — called after the dialog is on the page so the caller can
 *                                   wire up buttons/inputs inside it.
 *     wide — if true, adds the "wide" CSS class for a bigger dialog.
 * Returns: the close() function, so the caller can close the dialog from code.
 */
export function modal(title, bodyHTML, { onMount, wide } = {}) {
  // Build the dialog from a multi-line template string:
  //   - outer <div class="modal-backdrop">: the dark full-screen overlay behind the dialog.
  //   - inner <div class="modal card ...">: the dialog box; gets the extra "wide" class if wide is true.
  //     role="dialog" and aria-modal="true" tell screen readers this is a pop-up dialog.
  //   - .modal-head: the escaped title in an <h3> plus a ✕ button. The data-close attribute
  //     marks the button so we can find it below; aria-label gives it a readable name.
  //   - .modal-body: where the caller's bodyHTML goes.
  const root = h(`<div class="modal-backdrop">
    <div class="modal card ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="modal-body">${bodyHTML}</div>
    </div></div>`);
  // close() hides and removes the dialog and stops listening for the Escape key.
  const close = () => {
    // Remove "show" so the CSS fade-out animation runs.
    root.classList.remove('show');
    // After 200ms (animation time), take the dialog off the page.
    setTimeout(() => root.remove(), 200);
    // Stop listening for key presses; otherwise old dialogs would keep reacting to Escape.
    document.removeEventListener('keydown', onKey);
  };
  // Key handler: if the pressed key is Escape, close. (`a && b()` runs b() only when a is true.)
  // This uses `onKey` inside close() above before it's defined in reading order; that's fine,
  // because close() only runs later, after this line has executed. Functions "remember" variables
  // from where they were created — this is called a closure.
  const onKey = (e) => e.key === 'Escape' && close();
  // Clicking the dark backdrop itself (not the dialog box inside it) closes the dialog.
  // e.target is the exact element clicked; it equals root only when you click outside the box.
  root.addEventListener('mousedown', (e) => e.target === root && close());
  // Find the ✕ button (the element with the data-close attribute) and make clicking it close the dialog.
  root.querySelector('[data-close]').onclick = close;
  // Start listening for key presses anywhere on the page (for Escape).
  document.addEventListener('keydown', onKey);
  // Put the dialog on the page.
  document.body.appendChild(root);
  // On the next animation frame, add "show" so the fade-in transition animates.
  requestAnimationFrame(() => root.classList.add('show'));
  // If the caller gave an onMount function, call it with the body element and the close function.
  onMount?.(root.querySelector('.modal-body'), close);
  // Return close so whoever opened the dialog can close it later.
  return close;
}

// File reading lives in fileread.js (pdf, word, powerpoint, excel, images via OCR, …)
// This line re-exports those helpers: other files can write `import { readFileText } from './ui.js'`
// even though the code actually lives in fileread.js.
//   readFileText    — read one uploaded file into plain text.
//   readFilesText   — same, for several files.
//   enableImagePaste — lets you paste an image into a text box and turns it into text.
//   ACCEPT          — list of file types the file pickers accept.
export { readFileText, readFilesText, enableImagePaste, ACCEPT } from './fileread.js';

/*
 * spinner(label) — HTML for the animated "Thinking…" indicator.
 * Input: label text (defaults to 'Thinking…' if you don't pass one).
 * Returns: an HTML string (not an element) — three dot <span>s (animated by CSS) followed by the escaped label.
 */
export function spinner(label = 'Thinking…') {
  return `<div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span> ${esc(label)}</div>`;
}
