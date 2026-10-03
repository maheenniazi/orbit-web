/*
 * server.js — the starting point of the orbit app. Running `node server.js` starts it.
 *
 * What it does: it is a small web server (an "HTTP server"). A web server is a program
 * that waits for requests from a browser ("give me this page", "ask the AI this") and
 * sends back responses. This one does three jobs:
 *   1. Serves the static files in /public (index.html, styles.css, the browser JS).
 *   2. Offers a small "API" (URLs starting with /api/...) that the browser code calls to
 *      use AI, search jobs, convert files and read web pages. These run here, on the
 *      server, because they need secret API keys (passwords for services like OpenAI)
 *      that must never be sent to the browser.
 *   3. Loads settings from a .env file (a simple "NAME=value" text file of secrets/config).
 * Data is sent back and forth as JSON (JavaScript Object Notation): objects written as text.
 * "Zero-dependency" means it only uses modules built into Node, no npm packages.
 * async/await: some work takes time (network, files). An `async` function can `await`
 * a Promise (a "result that arrives later") without freezing the whole server.
 */
// Zero-dependency server: static files + AI proxy + config.
// Run: node server.js   (Node 18+ for global fetch)
// require() loads a module (a file of code) and gives back what it exports.
// 'http' is Node's built-in module for making web servers.
const http = require('http');
// 'fs' (file system) reads and writes files on disk.
const fs = require('fs');
// 'path' builds file paths safely (handles "/" vs "\" on different operating systems).
const path = require('path');

// --- tiny .env loader ---
// __dirname is the folder this file is in. Build the full path to the .env file there.
const envPath = path.join(__dirname, '.env');
// Only try to read .env if it exists (it's optional; without it the app runs offline).
if (fs.existsSync(envPath)) {
  // Read the whole file as text, then split it into lines. The regex /\r?\n/ matches a
  // line break: "\n" with an optional "\r" before it (Windows files use "\r\n").
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    // Match lines shaped like NAME=value. In plain words the regex says:
    // optional spaces, then capture a NAME made of capital letters/digits/underscores,
    // optional spaces, "=", optional spaces, then capture everything else as the value.
    // m becomes an array: m[1] = the name, m[2] = the value (or null if no match).
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    // If the line matched and that name isn't already set in the real environment
    // (real environment variables win over the file), store it in process.env.
    // process.env is the object Node uses for environment variables.
    // The value is trimmed, then the regex /^["']|["']$/g removes one quote mark (" or ')
    // at the very start and at the very end, so NAME="abc" becomes abc.
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '').trim();
  }
}

// Which port (a numbered "door" on the computer) to listen on. Number() converts text
// to a number; if PORT isn't set, Number(undefined) is NaN, and `|| 3000` falls back to 3000.
const PORT = Number(process.env.PORT) || 3000;
// Which network address to listen on. 127.0.0.1 means "this computer only", so other
// devices on the Wi-Fi can't reach the app unless HOST is changed.
const HOST = process.env.HOST || '127.0.0.1';
// Full path to the folder holding the browser files.
const PUBLIC = path.join(__dirname, 'public');
// Biggest request body we accept by default: 8 megabytes (8 × 1024 × 1024 bytes).
const MAX_BODY = 8 * 1024 * 1024;

// Load our own AI module (ai-providers.js), which talks to Kiro/Anthropic/OpenAI/Gemini.
const ai = require('./ai-providers');

// MIME types tell the browser what kind of file it is receiving, keyed by file extension.
// "charset=utf-8" says the text uses the UTF-8 encoding (supports emoji, accents, etc.).
const MIME = {
  // web page
  '.html': 'text/html; charset=utf-8',
  // JavaScript code
  '.js': 'text/javascript; charset=utf-8',
  // stylesheet
  '.css': 'text/css; charset=utf-8',
  // JSON data
  '.json': 'application/json',
  // vector image
  '.svg': 'image/svg+xml',
  // PNG image
  '.png': 'image/png',
  // favicon (the little tab icon)
  '.ico': 'image/x-icon',
  // PWA web app manifest (describes the installable app).
  '.webmanifest': 'application/manifest+json',
  // JPEG image (used by the PDF guide / any photos).
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/*
 * send(res, status, body, type)
 * What it does: sends a complete response back to the browser.
 * Inputs: res — the response object Node gives us; status — HTTP status code
 * (200 = OK, 404 = not found, 500 = server error...); body — what to send (text,
 * raw bytes, or an object); type — the Content-Type, defaulting to JSON.
 * Returns: nothing useful (the response is finished).
 * `type = 'application/json'` is a "default parameter": used when no type is passed.
 */
function send(res, status, body, type = 'application/json') {
  // Write the status line and headers. 'Cache-Control: no-store' tells the browser not to
  // cache (save) the response, so it always gets fresh data/files.
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  // Finish the response. If body is already a string or a Buffer (raw bytes, e.g. an image),
  // send it as-is; otherwise it's an object, so turn it into JSON text with JSON.stringify.
  // `a ? b : c` is the "ternary" operator: if a is true use b, else use c.
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/*
 * readBody(req, options)
 * What it does: collects the full body (uploaded data) of an incoming request.
 * Inputs: req — the request; an options object with raw (true = give back raw bytes,
 * false = give back text) and limit (max bytes allowed, default MAX_BODY).
 * The `{ raw = false, limit = MAX_BODY } = {}` part is "destructuring with defaults":
 * it pulls raw and limit out of the object passed in, using defaults if missing, and
 * `= {}` means calling readBody(req) with no options also works.
 * Returns: a Promise that resolves to a Buffer (raw) or a string, or rejects if too large.
 */
function readBody(req, { raw = false, limit = MAX_BODY } = {}) {
  // A Promise wraps work that finishes later. We call resolve(value) on success and
  // reject(error) on failure. `(resolve, reject) => {...}` is an "arrow function",
  // a short way to write a function.
  return new Promise((resolve, reject) => {
    // Running total of bytes received so far.
    let size = 0;
    // The body arrives in pieces ("chunks"); we store them here and join them at the end.
    const chunks = [];
    // 'data' fires every time a new chunk arrives.
    req.on('data', (c) => {
      // Add this chunk's length to the total.
      size += c.length;
      // Too big? Fail the Promise and close the connection so we stop receiving data.
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      // Otherwise keep the chunk.
      } else chunks.push(c);
    });
    // 'end' fires when the whole body has arrived. Buffer.concat joins the chunks into one
    // Buffer; for text mode we decode it as UTF-8 into a string.
    req.on('end', () => resolve(raw ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    // If the connection has an error, reject the Promise with that error.
    req.on('error', reject);
  });
}

// execFile runs another program on the computer (here: macOS conversion tools).
// The { execFile } = ... syntax is destructuring: take just execFile from the module.
const { execFile } = require('child_process');
// Our job-search module (jobs.js): job feeds, search, and reading job posting pages.
const jobs = require('./jobs');
// Our web-page reader (pages.js), used for academic calendar links.
const pages = require('./pages');

// ---- File conversion helpers (macOS built-ins: textutil for old Word/RTF/ODT, sips for HEIC/TIFF photos) ----
// 'os' gives info about the operating system, e.g. where the temporary folder is.
const os = require('os');
// A Set is a collection of unique values with a fast .has() check.
// These are the file extensions macOS's "textutil" tool can turn into plain text.
const TEXTUTIL_EXT = new Set(['.doc', '.dot', '.docx', '.rtf', '.rtfd', '.odt', '.wordml', '.html', '.htm', '.webarchive', '.txt']);
// These are image extensions macOS's "sips" tool can turn into a JPEG.
const SIPS_EXT = new Set(['.heic', '.heif', '.tif', '.tiff', '.bmp', '.gif', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.psd', '.jp2']);
// execP(cmd, args): a "promisified" version of execFile, so we can `await` it.
// Inputs: cmd — program path; args — list of arguments. Returns a Promise of the
// program's output (stdout). Options: give up after 60 seconds (60_000 ms), allow up to
// 30 MB of output, and don't pop up a window on Windows.
// If the program fails, reject with a short error: use what it printed to stderr (its
// error output) or the error message, turned to text, trimmed, and keep only the LAST
// line (.split('\n').pop()) since that's usually the real reason.
const execP = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 60_000, maxBuffer: 30 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || err.message).toString().trim().split('\n').pop())) : resolve(stdout)));

/*
 * convertFile(buf, name, to)
 * What it does: converts an uploaded file into something the app can read — plain text
 * (for Word/RTF/etc.) or a JPEG image (for HEIC/TIFF photos etc.), using macOS tools.
 * Inputs: buf — the file's raw bytes; name — original filename (for its extension);
 * to — 'text' or 'jpeg'.
 * Returns (a Promise of): { text: '...' } or { jpeg: <Buffer> }.
 * Throws an error with status 415 ("unsupported media type") when it can't convert.
 */
async function convertFile(buf, name, to) {
  // Get the lowercase extension (e.g. ".docx"). The regex /^\.[a-z0-9]{1,8}$/ only accepts
  // a dot followed by 1–8 letters/digits, so weird names can't sneak odd text into a path.
  // If it doesn't match, use ['.bin'] instead; [0] takes the first item (the extension).
  const ext = (path.extname(String(name)).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || ['.bin'])[0];
  // process.platform is 'darwin' on macOS. The tools we use only exist on a Mac.
  const onMac = process.platform === 'darwin';
  // Small helper (arrow function) that makes an Error and attaches status 415 to it.
  // Object.assign(target, extra) copies the properties of extra onto target.
  const unsupported = (msg) => Object.assign(new Error(msg), { status: 415 });
  // Asked for text but textutil can't read this extension? Stop with a clear message.
  if (to === 'text' && !TEXTUTIL_EXT.has(ext)) throw unsupported(`can’t convert ${ext} files to text`);
  // Asked for an image but sips can't read this extension? Stop.
  if (to === 'jpeg' && !SIPS_EXT.has(ext)) throw unsupported(`can’t convert ${ext} files to an image`);
  // Not on a Mac: the tools don't exist, so explain why.
  if (!onMac) throw unsupported(to === 'text' ? 'converting this file needs macOS' : 'converting this image type needs macOS');
  // Make a brand-new temporary folder (like /tmp/orbit-abc123) to work in.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-'));
  // try/finally: whatever happens inside try (success or error), the finally block runs,
  // so the temporary folder always gets deleted.
  try {
    // Path for the input file, keeping its extension so the tool knows its type.
    const input = path.join(dir, 'input' + ext);
    // Save the uploaded bytes to that file.
    fs.writeFileSync(input, buf);
    // Text: run `textutil -convert txt -stdout <file>`, which prints the text; return it as a string.
    if (to === 'text') return { text: (await execP('/usr/bin/textutil', ['-convert', 'txt', '-stdout', input])).toString('utf8') };
    // Image: where sips should write the JPEG.
    const out = path.join(dir, 'out.jpg');
    // Run sips: set format to JPEG, -Z 3000 shrinks it so the longest side is at most 3000 px.
    await execP('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '3000', input, '--out', out]);
    // Read the JPEG bytes back and return them.
    return { jpeg: fs.readFileSync(out) };
  } finally {
    // Delete the temp folder and everything in it; force: true means don't complain if it's gone.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/*
 * serveStatic(req, res, urlPath)
 * What it does: sends a file from the /public folder to the browser.
 * Inputs: the request, the response, and the URL path asked for (e.g. "/js/app.js").
 * Returns: nothing; it sends the response itself.
 * If the file doesn't exist, it sends index.html instead ("SPA fallback": orbit is a
 * single-page app, so the browser JS decides what to show for any path).
 */
function serveStatic(req, res, urlPath) {
  // Turn things like "%20" in the URL back into normal characters (a space).
  let rel = decodeURIComponent(urlPath);
  // The home page and the Spotify login "/callback" page both just load index.html.
  if (rel === '/' || rel === '/callback') rel = '/index.html';
  // Build the full file path, and normalize it (resolves things like "../").
  const file = path.normalize(path.join(PUBLIC, rel));
  // Security: if the result is outside the public folder (someone asked for "/../.env"),
  // refuse with 403 Forbidden so secrets can't be downloaded.
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  // Read the file. This uses a "callback": a function Node calls when reading is done,
  // with err (if it failed) and buf (the file's bytes).
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback
      // The file wasn't found, so send index.html instead. If even that fails, send 404.
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) =>
        e2 ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, html, MIME['.html'])
      );
    }
    // Found it: send it with the right MIME type for its extension, or a generic
    // "binary data" type if the extension isn't in our MIME list.
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

// Create the web server. The async arrow function runs once for EVERY request.
// req = the incoming request (method, URL, headers, body); res = the response we fill in.
// This big function is the "router": it looks at the URL and method and picks what to do.
const server = http.createServer(async (req, res) => {
  // Parse the URL so we can read .pathname ("/api/ai") and .searchParams ("?a=1").
  // new URL needs a full address, so we add the host from the request headers.
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Any unexpected error inside goes to the catch at the bottom and becomes a 500 response.
  try {
    // GET /api/status — the browser asks "what's set up?" when the app loads.
    if (url.pathname === '/api/status' && req.method === 'GET') {
      // List of AI providers that have keys configured, e.g. ['kiro', 'gemini'].
      const providers = ai.enabled();
      return send(res, 200, {
        // true if at least one AI provider is available
        ai: providers.length > 0,
        // the full list
        providers,
        // the first (default) provider, or null if none
        provider: providers[0] || null,
        // Spotify app ID (public, not secret) so the browser can do Spotify login
        spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
        // which web job sources have keys (see websearch.js status())
        webJobs: require('./websearch').status(),
      });
    }
    // GET /api/models — the list of AI models for the model picker.
    // "?refresh" in the URL forces a fresh list instead of the cached one.
    if (url.pathname === '/api/models' && req.method === 'GET') {
      return send(res, 200, await ai.catalog({ refresh: url.searchParams.has('refresh') }));
    }
    // POST /api/ai — send messages to an AI model and get its reply.
    if (url.pathname === '/api/ai' && req.method === 'POST') {
      // Read the body text and parse it from JSON into an object ({ system, messages, model... }).
      // If the body is empty, parse '{}' (an empty object) instead.
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        // Ask the AI and send back { text, model }.
        return send(res, 200, await ai.callAI(body));
      } catch (e) {
        // AI failed: use the error's status if it has one, else 502 ("bad gateway":
        // the service we passed the request on to had a problem).
        return send(res, e.status || 502, { error: e.message });
      }
    }
    // GET /api/jobs/test — the "test my sources" button: try each web job source once.
    if (url.pathname === '/api/jobs/test' && req.method === 'GET') {
      return send(res, 200, await require('./websearch').testSources());
    }
    // POST /api/jobs/search — search for jobs using the filters the student picked.
    if (url.pathname === '/api/jobs/search' && req.method === 'POST') {
      // The filters arrive as JSON in the body.
      const filters = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, await jobs.search(filters));
    }
    // POST /api/convert?to=text|jpeg&name=file.docx — convert an uploaded file.
    if (url.pathname === '/api/convert' && req.method === 'POST') {
      // Which output we want: 'text' or 'jpeg'.
      const to = url.searchParams.get('to');
      // Anything else is a bad request (400).
      if (!['text', 'jpeg'].includes(to)) return send(res, 400, { error: 'to must be text or jpeg' });
      try {
        // Read the uploaded file as raw bytes, allowing up to 40 MB.
        const buf = await readBody(req, { raw: true, limit: 40 * 1024 * 1024 });
        // Convert it (the filename comes from ?name=, or '' if missing).
        const out = await convertFile(buf, url.searchParams.get('name') || '', to);
        // If we got an image, send the JPEG bytes; otherwise send { text } as JSON.
        return out.jpeg ? send(res, 200, out.jpeg, 'image/jpeg') : send(res, 200, out);
      } catch (e) {
        // Failed: use its status (e.g. 415) or 422 ("couldn't process this").
        return send(res, e.status || 422, { error: e.message });
      }
    }
    // GET /api/page-text?url=... — read the text of a public web page (pages.js).
    if (url.pathname === '/api/page-text' && req.method === 'GET') {
      try {
        return send(res, 200, await pages.pageText(url.searchParams.get('url') || ''));
      } catch (e) {
        // A TimeoutError means the 25-second limit was hit; give a friendlier message for it.
        return send(res, 422, { error: e.name === 'TimeoutError' ? 'that site took too long to respond' : e.message });
      }
    }
    // GET /api/job-text?url=... — read the description from a job posting link (jobs.js).
    if (url.pathname === '/api/job-text' && req.method === 'GET') {
      try {
        return send(res, 200, await jobs.jobText(url.searchParams.get('url') || ''));
      } catch (e) {
        return send(res, 422, { error: e.name === 'TimeoutError' ? 'That site took too long. Paste the description instead.' : e.message });
      }
    }
    // Any other GET request is for a file (page, script, stylesheet...).
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    // Anything else (e.g. a POST to an unknown URL) isn't allowed: 405.
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    // Something unexpected broke (e.g. invalid JSON in a body). Log it in the terminal
    // and tell the browser with a 500 "internal server error".
    console.error('[server]', e.message);
    send(res, 500, { error: e.message });
  }
});

// Start listening for requests on HOST:PORT. The arrow function runs once the server is ready.
server.listen(PORT, HOST, () => {
  // Print the address to open in the browser (\n adds a blank line first).
  console.log(`\n  ✦ orbit running at http://${HOST}:${PORT}`);
  // Which AI providers are configured.
  const providers = ai.enabled();
  // Print the AI status. In plain words: if there are providers, turn each id into its
  // nice label (ai.LABEL, e.g. 'gemini' → 'Google Gemini') with .map(), join them with
  // commas, and if AI_MODEL is set add " (default <model>)". If there are none, say
  // we're in offline mode. All of it is inside one template literal.
  console.log(`  AI: ${providers.length ? providers.map((p) => ai.LABEL[p]).join(', ') + (process.env.AI_MODEL ? ` (default ${process.env.AI_MODEL})` : '') : 'offline mode (add a key to .env for full AI)'}`);
  // Check in the background whether the Kiro CLI program is installed (prints a line when done).
  ai.probeKiro();
  // Print whether Spotify account login is possible or only the embedded player works.
  console.log(`  Spotify: ${process.env.SPOTIFY_CLIENT_ID ? 'client ID set' : 'embed-only (set SPOTIFY_CLIENT_ID for account connect)'}\n`);
});
