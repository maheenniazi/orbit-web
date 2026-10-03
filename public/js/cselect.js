/*
 * cselect.js — themed ("custom") dropdowns for the whole app.
 *
 * The problem: a browser's built-in <select> dropdown can't really be styled with CSS
 * (the open list looks different in every browser and ignores our theme).
 * The trick used here:
 *   1. Keep the real <select> in the page, but hide it (CSS rule `select.cs-native { display: none }`
 *      in styles.css). Because it still exists, every other file can keep reading `select.value`
 *      and listening for its "change" event exactly as if nothing happened.
 *   2. Put a styled <button> right after it that shows the chosen option's text.
 *   3. When the button is clicked, build a floating menu (<div> full of <button>s), one per option.
 *      Picking one sets the hidden <select>'s value and fires its "change" event.
 * A MutationObserver is a browser tool that "watches" part of the page and calls a function when
 * something changes (elements added, attributes changed…). We use it to (a) notice brand-new
 * <select>s whenever a page is drawn, and (b) notice when a select's options change.
 * app.js calls startSelects() once at startup; that's the only entry point.
 */

// Original note from the author:
// Replaces every native <select> with a styled dropdown that matches the theme.
// The real <select> stays in the page (hidden), so existing code that reads .value or listens
// for "change" keeps working. New selects are picked up automatically as views render.

// Which menu is open right now (only one at a time). null = no menu open.
// When open it holds { menu, btn, sel, choose, active } — see the end of open() below.
// `let` (not `const`) because we reassign it.
let openMenu = null;

/*
 * closeMenu() — close the currently open dropdown menu, if there is one.
 * Inputs: none. Returns: nothing.
 */
function closeMenu() {
  // Nothing open? Then there's nothing to do — leave the function early.
  if (!openMenu) return;
  // Remove the floating menu <div> from the page.
  openMenu.menu.remove();
  // Tell screen readers the dropdown is now collapsed (accessibility attribute).
  openMenu.btn.setAttribute('aria-expanded', 'false');
  // Remove the "open" CSS class so the button stops looking pressed/open.
  openMenu.btn.classList.remove('open');
  // Remember that no menu is open anymore.
  openMenu = null;
}

/*
 * labelOf(sel) — the visible text of the option currently chosen in a <select>.
 * Input: sel = a <select> element. Returns: that option's text, or '' if nothing is selected.
 */
function labelOf(sel) {
  // sel.options is the list of <option>s; selectedIndex is the position of the chosen one (-1 if none).
  const o = sel.options[sel.selectedIndex];
  // If an option exists, return its text; otherwise an empty string.
  // (`a ? b : c` is the "ternary" operator: if a then b else c.)
  return o ? o.textContent : '';
}

/*
 * enhance(sel) — turn one native <select> into the styled button + menu version.
 * Input: sel = a <select> element. Returns: nothing (it changes the page).
 */
function enhance(sel) {
  // Skip it if: we already enhanced it (data-cs is set), it allows multiple choices (not supported here),
  // or the HTML asked to keep the native look with a data-native attribute.
  // `sel.dataset.x` reads the HTML attribute data-x. `!= null` is true for anything except null/undefined.
  if (sel.dataset.cs || sel.multiple || sel.dataset.native != null) return;
  // Mark it as enhanced (adds data-cs="1" to the HTML) so we never do it twice.
  sel.dataset.cs = '1';
  // Create the new button that will stand in for the select.
  const btn = document.createElement('button');
  // type="button" so clicking it inside a <form> doesn't submit the form.
  btn.type = 'button';
  // Give it the "cselect" class plus any classes the select had, so page-specific styling carries over.
  // This is a template literal (backtick string): ${...} inserts a value. .trim() removes the
  // trailing space if the select had no classes.
  btn.className = `cselect ${sel.className}`.trim();
  // If the select had inline styles (style="..."), copy them onto the button too.
  if (sel.style.cssText) btn.style.cssText = sel.style.cssText;
  // Accessibility: announce that this button opens a list of choices…
  btn.setAttribute('aria-haspopup', 'listbox');
  // …and that the list starts closed.
  btn.setAttribute('aria-expanded', 'false');
  // Copy the tooltip text (title attribute) if there is one.
  if (sel.title) btn.title = sel.title;
  // Find a name for screen readers: use the select's aria-label if present; otherwise, if the select
  // sits inside a <label>, use the label's first piece of text (e.g. "Course" in <label>Course <select>).
  // `?.` is "optional chaining": if the thing on the left is null/undefined, stop and give undefined
  // instead of crashing. So if there's no <label>, or no first child, or no text, we just get undefined.
  // `||` means "use the left side if it's truthy, else the right side".
  const ariaLabel = sel.getAttribute('aria-label') || sel.closest('label')?.childNodes[0]?.textContent?.trim();
  // Only set the attribute if we actually found a name.
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  // Fill the button with two spans: one for the chosen option's text (cs-val) and one for the
  // little arrow/caret drawn by CSS (cs-caret, hidden from screen readers because it's decoration).
  btn.innerHTML = '<span class="cs-val"></span><span class="cs-caret" aria-hidden="true"></span>';
  // Insert the button into the page directly after the select.
  sel.after(btn);
  // Add the class that hides the real select (styles.css: select.cs-native { display: none }).
  sel.classList.add('cs-native');

  // refresh(): copy the select's current state onto the button — its chosen text, and whether it's disabled.
  // `() => { ... }` is an arrow function: a short way of writing a function with no inputs.
  // It's also a "closure": it remembers `btn` and `sel` from this enhance() call even when run later.
  const refresh = () => { btn.querySelector('.cs-val').textContent = labelOf(sel); btn.disabled = sel.disabled; };
  // Run it once now so the button shows the starting value.
  refresh();
  // And again whenever the select changes.
  sel.addEventListener('change', refresh);
  // keep the button in sync when code sets select.value directly
  // (Setting .value from code does NOT fire a "change" event, so we'd miss it otherwise.)
  // Step 1: grab the browser's built-in definition of the `value` property for all <select>s
  // (its getter = what runs when you read .value, its setter = what runs when you assign .value).
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  // Step 2: give THIS select its own `value` property that wraps the built-in one:
  //  - get(): just call the original getter (reading works exactly as before);
  //  - set(v): call the original setter, then refresh() the button.
  // `.call(this, ...)` runs the original function with `this` = our select element.
  // configurable: true lets it be redefined later if needed.
  Object.defineProperty(sel, 'value', { configurable: true, get() { return proto.get.call(this); }, set(v) { proto.set.call(this, v); refresh(); } });
  // Step 3: watch the select itself. If its options are added/removed (childList, subtree) or an
  // option's "selected"/"disabled" attribute changes, call refresh() so the button stays correct.
  new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['selected', 'disabled'] });

  // choose(i): the user picked the option at position i.
  // `(i) => { ... }` is an arrow function with one input, i.
  const choose = (i) => {
    // Only do work if it's actually a different option than the current one.
    if (sel.selectedIndex !== i) {
      // Select that option in the hidden real <select>.
      sel.selectedIndex = i;
      // Update the button's text.
      refresh();
      // Fire the same events a real select would fire, so other code listening on the select reacts.
      // bubbles: true means parent elements hear it too (some code listens on a parent).
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Close the menu either way…
    closeMenu();
    // …and put keyboard focus back on the button, like a native select does.
    btn.focus();
  };

  // open(): build and show the floating menu (or close it if this button's menu is already open).
  const open = () => {
    // If the open menu belongs to this same button, clicking again toggles it shut.
    if (openMenu?.btn === btn) return closeMenu();
    // Otherwise close any other dropdown's menu first (only one open at a time).
    closeMenu();
    // Create the menu container.
    const menu = document.createElement('div');
    // Class for styling.
    menu.className = 'cs-menu';
    // Accessibility: it's a list of choices.
    menu.setAttribute('role', 'listbox');
    // Build one <button> per option:
    //  - [...sel.options] uses the spread operator `...` to copy the options list into a real array
    //    (sel.options is an "array-like" collection without .map).
    //  - .map((o, i) => `...`) turns each option o (at index i) into an HTML string. The template gives:
    //      class "on" if it's the currently chosen option,
    //      data-i="i" so we know which option a button stands for,
    //      the "disabled" attribute if the option is disabled,
    //      aria-selected="true/false" for screen readers.
    //    The buttons are left empty on purpose — the text is filled on the next line.
    //  - .join('') glues all the strings into one big HTML string.
    menu.innerHTML = [...sel.options].map((o, i) => `<button type="button" role="option" class="cs-opt ${i === sel.selectedIndex ? 'on' : ''}" data-i="${i}" ${o.disabled ? 'disabled' : ''} aria-selected="${i === sel.selectedIndex}"></button>`).join('');
    // Now put each option's text into its button using textContent (safe: text is never treated as HTML).
    [...menu.children].forEach((b, i) => (b.textContent = sel.options[i].textContent));
    // Add the menu to the end of <body> so it floats above everything (not clipped by parent boxes).
    document.body.appendChild(menu);
    // ---- Positioning: place the menu under the button, or above it if there's no room below ----
    // r = the button's position and size on screen (left, top, bottom, width…).
    const r = btn.getBoundingClientRect();
    // h = how tall the menu wants to be, capped at 300px.
    const h = Math.min(menu.scrollHeight, 300);
    // below = free space between the button's bottom and the bottom of the window (minus an 8px margin).
    const below = window.innerHeight - r.bottom - 8;
    // Make the menu at least as wide as the button.
    menu.style.minWidth = `${r.width}px`;
    // Line it up with the button's left edge, but shift it left if it would spill off the right side
    // of the window (window width minus the menu's width minus an 8px margin).
    menu.style.left = `${Math.min(r.left, window.innerWidth - Math.max(r.width, menu.offsetWidth) - 8)}px`;
    // Vertical position: if the menu fits below (or there's more room below than above), put it
    // 4px under the button; otherwise put it above (button top minus menu height minus 4px).
    menu.style.top = below >= h || below > r.top ? `${r.bottom + 4}px` : `${r.top - h - 4}px`;
    // Max height: the space available on the chosen side (below, or above minus 12px), but never
    // less than 140px and never more than 300px. If the list is longer, the menu scrolls.
    menu.style.maxHeight = `${Math.max(140, Math.min(300, below >= h || below > r.top ? below : r.top - 12))}px`;
    // Stop mousedown's default action inside the menu, so clicking an option doesn't steal focus
    // from the button (which would make it look like the user clicked away).
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    // Clicking an option button calls choose() with its index. `+b.dataset.i` turns the text "3" into the number 3.
    menu.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => choose(+b.dataset.i)));
    // Scroll the menu so the currently chosen option (class "on") is visible, if there is one.
    menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    // Accessibility: the dropdown is now expanded.
    btn.setAttribute('aria-expanded', 'true');
    // Style the button as open.
    btn.classList.add('open');
    // Remember everything about this open menu. `{ menu, btn, sel, choose }` is shorthand for
    // { menu: menu, btn: btn, ... }. `active` = the option highlighted by the arrow keys (starts at the chosen one).
    openMenu = { menu, btn, sel, choose, active: sel.selectedIndex };
  };

  // Clicking the button opens/closes the menu. stopPropagation() stops this click from also reaching
  // the document-wide "click outside closes the menu" listener in startSelects(), which would close it instantly.
  btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  // Keyboard support, so the fake dropdown behaves like a real one.
  btn.addEventListener('keydown', (e) => {
    // n = how many options there are.
    const n = sel.options.length;
    // Is this button's menu the one currently open?
    const isOpen = openMenu?.btn === btn;
    // Up/Down arrow keys:
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      // Stop the page from scrolling.
      e.preventDefault();
      // If the menu is closed, the first arrow press just opens it.
      if (!isOpen) return open();
      // Start from the currently highlighted option.
      let a = openMenu.active;
      // Move one step down (+1) or up (-1). Adding n and using % n ("remainder") wraps around:
      // going down from the last option lands on the first, going up from the first lands on the last.
      // The do…while loop keeps stepping while it lands on a disabled option, and stops if it
      // has gone all the way round back to where it started (so it can't loop forever).
      do { a = (a + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; } while (sel.options[a].disabled && a !== openMenu.active);
      // Save the new highlighted position.
      openMenu.active = a;
      // Give the "active" class to that option's button only (toggle(class, true/false) adds or removes it).
      openMenu.menu.querySelectorAll('.cs-opt').forEach((o, i) => o.classList.toggle('active', i === a));
      // Make sure the highlighted option is scrolled into view.
      openMenu.menu.children[a]?.scrollIntoView({ block: 'nearest' });
    // Enter or Space while open: pick the highlighted option.
    } else if ((e.key === 'Enter' || e.key === ' ') && isOpen) { e.preventDefault(); choose(openMenu.active); }
    // Escape while open: close without changing anything.
    else if (e.key === 'Escape' && isOpen) { e.preventDefault(); closeMenu(); }
    // Tab moves focus elsewhere, so close the menu (but don't preventDefault — let Tab work normally).
    else if (e.key === 'Tab') closeMenu();
    // Any single printable character (e.key.length === 1 rules out keys like "Shift");
    // the regex /\S/ means "one character that is NOT whitespace", so pressing space doesn't count here.
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      // type a letter to jump to the next option starting with it
      // Start searching just after the highlighted option (if open) or the chosen option (if closed).
      const start = (isOpen ? openMenu.active : sel.selectedIndex) + 1;
      // Check each option once, wrapping around the end with % n.
      for (let k = 0; k < n; k++) {
        // i = the option position to check this time round.
        const i = (start + k) % n;
        // Is it enabled, and does its text (trimmed, lowercase) start with the typed letter (lowercase)?
        if (!sel.options[i].disabled && sel.options[i].textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())) {
          // If the menu is open: just move the highlight there (same three steps as the arrow keys).
          if (isOpen) { openMenu.active = i; openMenu.menu.querySelectorAll('.cs-opt').forEach((o, j) => o.classList.toggle('active', j === i)); openMenu.menu.children[i].scrollIntoView({ block: 'nearest' }); }
          // If closed: select it immediately, like a native select does.
          else choose(i);
          // Found a match — stop searching.
          break;
        }
      }
    }
  });
}

/*
 * enhanceSelects(root) — enhance every not-yet-enhanced <select> inside `root`.
 * Input: root = the element to search in (defaults to the whole document). Returns: nothing.
 * `root = document` is a default parameter: used when the caller passes nothing.
 * The CSS selector 'select:not([data-cs])' means "<select> elements that don't have a data-cs attribute".
 */
export function enhanceSelects(root = document) {
  // Run enhance() on each one found.
  root.querySelectorAll('select:not([data-cs])').forEach(enhance);
}

/*
 * startSelects() — switch the whole app over to themed dropdowns. Called once by app.js at startup.
 * Inputs: none. Returns: nothing.
 */
export function startSelects() {
  // Enhance the selects that are already on the page.
  enhanceSelects();
  // Watch the whole <body> for new elements. The callback receives `muts`, a list of change records.
  new MutationObserver((muts) => {
    // Was any <select> added? For each change m, look through its added nodes n (spread into an array):
    //  - n.nodeType === 1 means it's an element (not plain text);
    //  - it either IS a <select> (tagName 'SELECT'), or contains one (n.querySelector('select')).
    // .some() returns true as soon as one item matches. If so, enhance the new selects.
    if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.tagName === 'SELECT' || n.querySelector?.('select'))))) enhanceSelects();
  // childList + subtree: tell us about elements added or removed anywhere inside <body>.
  }).observe(document.body, { childList: true, subtree: true });
  // A click anywhere outside the open menu closes it.
  document.addEventListener('click', (e) => { if (openMenu && !openMenu.menu.contains(e.target)) closeMenu(); });
  // Resizing the window would leave the menu in the wrong place, so just close it.
  window.addEventListener('resize', closeMenu);
  // Scrolling anything except the menu itself also closes it (it'd otherwise float away from its button).
  // The final `true` means "capture": hear scroll events from every scrolling box, not just the page.
  document.addEventListener('scroll', (e) => { if (openMenu && !openMenu.menu.contains(e.target)) closeMenu(); }, true);
}
