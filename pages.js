/*
 * pages.js — reads the text of a public web page.
 *
 * Where it fits: in the Degree planner, the student can paste a link to a page from
 * their university's academic calendar (the page that lists a program's required
 * courses). The browser cannot download other websites directly (browsers block that
 * for security, a rule called CORS), so it asks OUR server instead: the browser calls
 * GET /api/page-text?url=... (see server.js), and server.js calls pageText() below.
 *
 * Key ideas for a beginner:
 *  - HTML is the markup language web pages are written in (tags like <p>, <table>).
 *    We strip the tags so only the readable words remain.
 *  - fetch() downloads a URL. It is "asynchronous": it takes time, so we `await` it,
 *    which pauses this function until the answer arrives without freezing the server.
 *  - Regular expressions ("regex", written /like this/) are patterns for finding text.
 */

// Borrow three helpers from jobs.js using "destructuring": require() returns an object,
// and { a, b, c } = obj pulls out just those three properties into variables.
//  - htmlToText: turns an HTML string into plain readable text.
//  - isPrivateHost: true if a host name is on a private/local network (e.g. localhost).
//  - UA: an object holding a browser-like "user-agent" header, so sites treat us like a normal browser.
const { htmlToText, isPrivateHost, UA } = require('./jobs');

// The most characters of page text we send back (the underscore in 60_000 is just a
// readable digit separator, it means 60000). Keeps AI prompts from getting huge.
const MAX_CHARS = 60_000;

/*
 * pageText(rawUrl)
 * What it does: downloads a public web page and extracts its main readable text.
 * Input: rawUrl — the link the student pasted (a string).
 * Returns (a Promise of): { title, text, url } — the page title, its text (trimmed to
 * MAX_CHARS) and the final URL after any redirects.
 * Throws an Error with a friendly message if the link is bad, private, a PDF, or unreadable.
 * "async" means the function can use `await` and always returns a Promise.
 */
async function pageText(rawUrl) {
  // Declare u with `let` (a variable we will assign later) so it is visible after the try block.
  let u;
  // Try to turn the text into a URL object (String() makes sure it is text, .trim() removes
  // spaces at the ends). new URL() throws an error for things that aren't valid links,
  // and the catch turns that into a friendly message.
  try { u = new URL(String(rawUrl).trim()); } catch { throw new Error('That doesn’t look like a link'); }
  // Safety check. The regex /^https?:$/ matches exactly "http:" or "https:" (the ? makes the
  // "s" optional). We also refuse private hosts, so nobody can use our server to peek at
  // machines on the local network (an attack called SSRF).
  if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) throw new Error('Only public links are supported');

  // Download the page. Options:
  //  - headers: `...UA` is the "spread" operator — it copies every property of UA (the
  //    user-agent) into this new object, then we add an "accept" header saying which
  //    content types we prefer (HTML first, plain text next, anything else last).
  //  - redirect: 'follow' means if the site says "moved, go here", fetch goes there.
  //  - signal: AbortSignal.timeout(25_000) cancels the download after 25 seconds.
  // `await` waits for the response to arrive; r is the Response object.
  const r = await fetch(u, { headers: { ...UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(25_000) });
  // r.ok is true for HTTP status codes 200–299 (success). Otherwise report the code (e.g. 404).
  // The backtick string is a "template literal": ${...} inserts a value into the text.
  if (!r.ok) throw new Error(`the site returned ${r.status}`);
  // Read the Content-Type header (what kind of file this is); use '' if it's missing.
  // `||` means "if the left side is empty/null, use the right side instead".
  const type = r.headers.get('content-type') || '';
  // /pdf/i matches "pdf" anywhere in the type, ignoring upper/lower case (the i flag).
  // PDFs aren't text we can read here, so ask the student to upload the file instead.
  if (/pdf/i.test(type)) throw new Error('that link is a PDF. Download it and upload the file instead');
  // Read the whole response body as a text string.
  const raw = await r.text();
  // If the type isn't HTML AND the body has no "<html" or "<body" tag, it's plain text:
  // return it as-is (cut to MAX_CHARS), using the host name as the title.
  // r.url is the final address after redirects.
  if (!/html/i.test(type) && !/<html|<body/i.test(raw)) return { title: u.hostname, text: raw.slice(0, MAX_CHARS), url: r.url };

  // Find the page title. The regex matches "<title ...>", then captures (in the brackets
  // group) everything up to "</title>": [\s\S]*? means "any characters, including new
  // lines, as few as possible". .match() returns an array where [1] is the captured part.
  // If there's no match we use [] so [1] is undefined, then fall back to ''.
  // htmlToText cleans any entities like &amp; and .trim() removes surrounding spaces.
  const title = htmlToText((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  // Prefer the main content area; calendars wrap requirements in <main>, #content or <article>
  // Each line tries one pattern; `?.[0]` is "optional chaining": if match() returned null
  // (no match) it gives undefined instead of crashing, and `||` moves on to the next try.
  //  1. a <main>...</main> block
  //  2. an <article>...</article> block
  //  3. a <div> whose id is content / main-content / main / page-content, up to the last </div>
  //  4. the whole <body>...</body>
  //  5. if all else fails, the whole raw HTML
  const main =
    raw.match(/<main[\s\S]*?<\/main>/i)?.[0] ||
    raw.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
    raw.match(/<div[^>]+id=["'](?:content|main-content|main|page-content)["'][\s\S]*<\/div>/i)?.[0] ||
    raw.match(/<body[\s\S]*<\/body>/i)?.[0] ||
    raw;
  // Keep table rows on one line so "PSY100H1 | Introductory Psychology | 0.5" stays together
  // The regex matches the end of one table cell (</td> or </th>), any spaces, and the start
  // of the next cell (<td ...> or <th ...>), and replaces that join with " | ".
  // The g flag means "replace every match", i means "ignore case".
  const tabled = main.replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' | ');
  // Strip all remaining HTML tags to get plain readable text.
  const text = htmlToText(tabled);
  // Fewer than 400 characters usually means the page builds its content with JavaScript
  // in the browser, so the raw HTML we downloaded is nearly empty. Explain a workaround.
  if (text.length < 400) {
    throw new Error('this calendar loads with JavaScript, so it can’t be read from a link. Open it, press ⌘P and choose “Save as PDF”, then upload that file (or copy and paste the requirements)');
  }
  // Success: send back the title, the text (cut to the size limit) and the final URL.
  return { title, text: text.slice(0, MAX_CHARS), url: r.url };
}

// Make pageText available to other files: server.js does require('./pages').pageText(...).
module.exports = { pageText };
