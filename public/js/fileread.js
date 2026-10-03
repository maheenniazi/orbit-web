/*
 * fileread.js — turns (almost) any file the student uploads into plain text.
 *
 * Other screens (syllabus import, notes, exam prep) call readFileText() or readFilesText()
 * and get back one string of text. The AI and the parsers only understand text, so
 * this file's job is to get the words OUT of PDFs, Word docs, slides, spreadsheets,
 * photos, etc. Almost everything happens inside the browser; nothing is uploaded.
 *
 * Key ideas for a beginner:
 *  - Binary file / ArrayBuffer: a file is just a long list of bytes (numbers 0-255).
 *    An ArrayBuffer is JavaScript's box of raw bytes; a Uint8Array lets us read it byte by byte,
 *    and a DataView lets us read 2- or 4-byte numbers at a given position ("offset").
 *  - .docx / .pptx / .xlsx (and .odt, .pages ...) are really ZIP files full of XML text files.
 *    So we unzip them ourselves and read the XML (a tag-based format like HTML).
 *  - OCR (Optical Character Recognition) = software that "looks" at a picture and guesses
 *    the letters in it. We use the tesseract.js library for photos and scanned PDFs.
 *  - Old formats (.doc) and some photo formats (HEIC) are sent to our own local server,
 *    which uses macOS tools (textutil / sips) to convert them.
 */
// Read (almost) any file into plain text, fully client-side where possible.
//  pdf (+ OCR for scanned pages) · docx/docm · pptx · xlsx · odt/ods/odp · rtf · html · csv/tsv · txt/md/…
//  images (png jpg webp gif bmp heic tiff …) via OCR · doc/heic/tiff via the local server on macOS (textutil / sips)
//  .pages/.key/.numbers via their embedded preview

// Web address of the pdf.js library (made by Mozilla) that knows how to read PDFs.
// It's only downloaded the first time someone actually opens a PDF.
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
// pdf.js does the heavy work in a "worker" (a background thread) so the page doesn't freeze; this is that worker's script.
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
// Web address of tesseract.js, the OCR library (reads text out of pictures). Also loaded only when needed.
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

// ACCEPT is the list of file types we allow, used in <input type="file" accept="...">
// so the file picker only shows supported files. `export` means other files can import it.
export const ACCEPT = [
  // document formats (Word, RTF, OpenDocument, Apple Pages)
  '.pdf', '.doc', '.docx', '.docm', '.dot', '.dotx', '.rtf', '.odt', '.ott', '.pages',
  // slide and spreadsheet formats
  '.ppt', '.pptx', '.ppsx', '.odp', '.key', '.xlsx', '.xlsm', '.ods', '.numbers', '.csv', '.tsv',
  // plain-text-ish formats (markdown, web pages, JSON, calendar files, emails, LaTeX)
  '.txt', '.md', '.markdown', '.html', '.htm', '.json', '.ics', '.eml', '.tex',
  // image formats (read with OCR)
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.heic', '.heif', '.avif',
  // MIME types (the browser's own type labels): any image, PDFs, any text
  'image/*', 'application/pdf', 'text/*',
  // .join(',') glues the array into one comma-separated string, which is what `accept` expects.
].join(',');

// extOf("Week 3.PDF") → "pdf". Gets a file's extension in lowercase.
// This is an arrow function: `(name) => expression` is a short way to write a function that returns `expression`.
// The regex /\.([a-z0-9]+)$/ means: a dot, then one or more letters/digits, right at the end ($) of the name.
// The ( ) "captures" the part after the dot, which .match() puts at index [1].
// If there's no match, .match() returns null, so `|| []` swaps in an empty array; then [1] is undefined and `|| ''` gives "".
const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
// A Set is a list with no duplicates that can answer "is X in here?" very fast with .has(X).
// These are the image extensions we send to OCR.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'jfif']);
// tidy(s) cleans up messy whitespace in extracted text:
//  1) /\r\n?/g  — Windows (\r\n) and old-Mac (\r) line endings → normal "\n" (g = replace every match, not just the first)
//  2) /[ \t\u00a0]+\n/g — spaces, tabs or non-breaking spaces (\u00a0) sitting right before a line break → removed
//  3) /\n{3,}/g — 3 or more line breaks in a row → just 2 (at most one blank line)
//  4) .trim() — remove whitespace at the very start and end
const tidy = (s) => s.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ---------------- ZIP (for docx/pptx/xlsx/odf/iwork) ----------------
/*
 * unzip(buf) — a tiny ZIP reader written by hand (so the app needs no libraries).
 * Input: buf, an ArrayBuffer holding the whole .zip-style file.
 * Returns: an object { names, read, text }:
 *   names       — list of every file path inside the zip (e.g. "word/document.xml")
 *   read(name)  — gives back that inner file's bytes (Uint8Array), or null if it's not there
 *   text(name)  — same but decoded into a string
 * How a ZIP is laid out: each inner file is stored one after another, and at the END there is
 * a "central directory" (a table of contents) followed by a small "End Of Central Directory"
 * (EOCD) record that says where the table of contents starts. We read from the end backwards.
 * `async` means the function can use `await` (wait for slow work) and always returns a Promise.
 */
async function unzip(buf) {
  // View the raw bytes as an array of single bytes (each 0-255).
  const u8 = new Uint8Array(buf);
  // A DataView lets us read multi-byte numbers (2 bytes = Uint16, 4 bytes = Uint32) at any byte position.
  const dv = new DataView(buf);
  // Position of the EOCD record; -1 means "not found yet".
  let eocd = -1;
  // The EOCD record is at least 22 bytes long and sits at the end, but may be followed by a comment
  // of up to 65535 bytes. So we scan backwards from 22 bytes before the end, at most 65557 (22 + 65535) bytes back.
  // Math.max(0, ...) stops us going below position 0 for small files.
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    // Every EOCD starts with the 4-byte "signature" 0x06054b50 (the bytes "PK\5\6").
    // The `true` means read in little-endian order (smallest byte first), which is how ZIP stores numbers.
    // When we find it, remember the position and stop the loop with `break`.
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  // No EOCD found → this isn't a zip file. `throw` stops the function with an error the caller can catch.
  if (eocd < 0) throw new Error('not a zip');
  // 10 bytes into the EOCD: how many files the zip contains (2-byte number).
  const count = dv.getUint16(eocd + 10, true);
  // 16 bytes into the EOCD: the byte position where the central directory (table of contents) starts.
  let off = dv.getUint32(eocd + 16, true);
  // A Map is like an object/dictionary: it stores key → value pairs. Here: file name → info about that file.
  const entries = new Map();
  // TextDecoder turns bytes into a string (UTF-8 by default). Used for file names and XML contents.
  const dec = new TextDecoder();
  // Walk through each entry of the central directory. Stop after `count` entries, or if the next
  // bytes aren't a central-directory entry (signature 0x02014b50 = "PK\1\2"), which protects against damaged files.
  for (let n = 0; n < count && dv.getUint32(off, true) === 0x02014b50; n++) {
    // Byte 10 of the entry: compression method (0 = stored as-is, 8 = "deflate" compressed).
    const method = dv.getUint16(off + 10, true);
    // Byte 20: compressed size in bytes (how many bytes the stored data takes up).
    const csize = dv.getUint32(off + 20, true);
    // Byte 28: length of the file name.
    const nameLen = dv.getUint16(off + 28, true);
    // Byte 30: length of the optional "extra field" (extra metadata we skip over).
    const extraLen = dv.getUint16(off + 30, true);
    // Byte 32: length of the optional per-file comment (also skipped).
    const commLen = dv.getUint16(off + 32, true);
    // Byte 42: where this file's "local header" (and its data) starts in the zip.
    const local = dv.getUint32(off + 42, true);
    // The file name starts right after the 46-byte fixed part. .subarray() takes a slice of bytes (without copying),
    // and dec.decode turns it into text. We save { method, csize, local } under that name.
    // `{ method, csize, local }` is shorthand for `{ method: method, csize: csize, local: local }`.
    entries.set(dec.decode(u8.subarray(off + 46, off + 46 + nameLen)), { method, csize, local });
    // Jump to the next entry: the 46 fixed bytes plus the three variable-length parts.
    off += 46 + nameLen + extraLen + commLen;
  }
  // read(name): get the (uncompressed) bytes of one inner file.
  // This inner arrow function is a "closure": it remembers `entries`, `u8` and `dv` from unzip() even after unzip() has returned.
  const read = async (name) => {
    // Look up the file's info in our table of contents.
    const e = entries.get(name);
    // Not in the zip → return null ("nothing").
    if (!e) return null;
    // The local header is 30 fixed bytes, followed by the name (length at byte 26) and an extra field (length at byte 28).
    // The actual file data starts right after all of that.
    const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
    // Slice out exactly the stored (possibly compressed) bytes.
    const data = u8.subarray(start, start + e.csize);
    // Method 0 = not compressed, so the bytes are already the file. Done.
    if (e.method === 0) return data;
    // We only know how to undo method 8 (deflate); anything else is an error.
    if (e.method !== 8) throw new Error('unsupported zip compression');
    // Decompress using the browser's built-in DecompressionStream. 'deflate-raw' = deflate data with no extra header, as ZIP uses.
    // new Blob([data]).stream() turns the bytes into a stream; .pipeThrough() sends that stream through the decompressor.
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    // new Response(stream).arrayBuffer() is a handy trick to collect a whole stream into one ArrayBuffer.
    // `await` pauses here until it's done. Wrap it in Uint8Array so it matches the type returned above.
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  // Return the three tools. [...entries.keys()] uses the spread operator `...` to copy the Map's keys (file names) into a normal array.
  // text(name) reads the bytes, and if they exist (b is not null) decodes them into a string; otherwise returns null.
  // `cond ? a : b` is the ternary operator: "if cond then a else b".
  return { names: [...entries.keys()], read, text: async (name) => { const b = await read(name); return b ? dec.decode(b) : null; } };
}
// parseXML(s): turn an XML string into a document tree we can search (like the browser does for HTML).
const parseXML = (s) => new DOMParser().parseFromString(s, 'application/xml');
// kids(el): the child elements (tags only, no plain text) of an element, as a real array.
// `el.children || []` guards against el having no children list; Array.from makes it an array so we can use .filter/.map.
const kids = (el) => Array.from(el.children || []);
// numSort(re) builds a sort function that orders names by the number captured by the regex `re`.
// Example: "slide10.xml" must come after "slide2.xml" (plain alphabetical sorting would put 10 first).
// a.match(re)?.[1] — `?.` is optional chaining: if match() returned null, the whole thing is undefined instead of crashing.
// `|| 0` uses 0 if there's no number; the leading `+` converts the text "10" into the number 10.
// A sort function returns a negative number if a comes first, positive if b comes first.
const numSort = (re) => (a, b) => +(a.match(re)?.[1] || 0) - +(b.match(re)?.[1] || 0);

// ---------------- Word (.docx) ----------------
/*
 * docxRun(node) — collects the text inside one Word paragraph (or part of one).
 * In Word's XML, text lives in <w:t> tags inside "runs" <w:r>; tabs are <w:tab/>, line breaks <w:br/>.
 * Input: an XML element. Returns: the text found inside it (a string).
 * It calls itself on child elements ("recursion") to dig through nested tags.
 */
function docxRun(node) {
  // Text we've collected so far.
  let out = '';
  // Loop over every child node (tags AND text pieces).
  for (const c of node.childNodes) {
    // nodeType 1 means "element" (a tag). Skip anything else (raw text between tags, comments...).
    if (c.nodeType !== 1) continue;
    // localName is the tag name without its prefix, e.g. "w:t" → "t".
    const n = c.localName;
    // <w:t> holds actual words → add them.
    if (n === 't') out += c.textContent;
    // <w:tab/> → a tab character.
    else if (n === 'tab') out += '\t';
    // <w:br/> or <w:cr/> → a line break.
    else if (n === 'br' || n === 'cr') out += '\n';
    // A "non-breaking hyphen" → a normal hyphen.
    else if (n === 'noBreakHyphen') out += '-';
    // Skip deleted text (tracked changes), field instructions, and formatting info — none of it is visible text.
    else if (['del', 'delText', 'instrText', 'rPr', 'pPr', 'fldData'].includes(n)) continue;
    // Any other tag (like a run <w:r> or a hyperlink): look inside it by calling docxRun again.
    else out += docxRun(c);
  }
  // Give back everything collected.
  return out;
}
/*
 * docxBlocks(node) — walks the document body and returns an array of lines:
 * one line per paragraph, and one line per table row (cells joined with " | ").
 * Input: an XML element (e.g. <w:body>). Returns: array of strings.
 */
function docxBlocks(node) {
  // Lines of text we'll return.
  const lines = [];
  // Look at each direct child tag.
  for (const c of kids(node)) {
    const n = c.localName;
    // <w:p> is a paragraph → read its text as one line.
    if (n === 'p') lines.push(docxRun(c));
    // <w:tbl> is a table.
    else if (n === 'tbl') {
      // For each table row <w:tr> in the table...
      for (const tr of kids(c).filter((x) => x.localName === 'tr')) {
        // ...take its cells (<w:tc>, or <w:sdt> "content control" wrappers), and for each cell:
        // get its lines (cells can contain paragraphs), join them with spaces,
        // squash runs of whitespace (/\s+/g = one or more spaces/tabs/newlines) into one space, and trim the ends.
        const cells = kids(tr).filter((x) => x.localName === 'tc' || x.localName === 'sdt')
          .map((tc) => docxBlocks(tc).join(' ').replace(/\s+/g, ' ').trim());
        // One line per row, like "Week 1 | Intro | Sep 4".
        lines.push(cells.join(' | '));
      }
      // Blank line after the table to separate it from what follows.
      lines.push('');
      // These tags are just "wrappers" (content controls, text boxes, smart tags...) — look inside them.
      // lines.push(...array) uses spread `...` to push every item of the returned array, not the array itself.
    } else if (['sdt', 'sdtContent', 'customXml', 'body', 'txbxContent', 'smartTag'].includes(n)) lines.push(...docxBlocks(c));
  }
  return lines;
}
/*
 * docxText(zip) — gets all the text from a Word file.
 * Input: the unzip() result for the .docx. Returns (a Promise of) the text.
 */
async function docxText(zip) {
  // The main text of every .docx is stored in word/document.xml inside the zip.
  const xml = await zip.text('word/document.xml');
  // Missing → the file isn't a proper Word file.
  if (!xml) throw new Error('This Word file looks empty or damaged.');
  // Parse the XML and find the <w:body> tag. getElementsByTagNameNS('*', 'body') means "a body tag in any namespace (prefix)".
  const body = parseXML(xml).getElementsByTagNameNS('*', 'body')[0];
  // Turn the body into lines and join them with line breaks.
  return docxBlocks(body).join('\n');
}

// ---------------- PowerPoint (.pptx) ----------------
/*
 * pptxText(zip) — gets the text from every slide, in order, labelled "Slide 1", "Slide 2"...
 * Input: the unzip() result. Returns (a Promise of) the text.
 */
async function pptxText(zip) {
  // Matches inner file names like "ppt/slides/slide12.xml": ^ = start, (\d+) captures the slide number, $ = end.
  // The \/ and \. are escaped "/" and "." so they're matched literally.
  const re = /^ppt\/slides\/slide(\d+)\.xml$/;
  // Keep only slide files, then sort them by slide number (2 before 10).
  const slides = zip.names.filter((n) => re.test(n)).sort(numSort(re));
  // One chunk of text per slide.
  const out = [];
  // slides.entries() gives [index, value] pairs; `const [i, name]` is "destructuring" — it unpacks the pair into two variables.
  for (const [i, name] of slides.entries()) {
    // Read and parse this slide's XML.
    const doc = parseXML(await zip.text(name));
    // Find all paragraph tags <a:p> ...
    const paras = Array.from(doc.getElementsByTagNameNS('*', 'p'))
      // ...but only the ones from the "drawingml" namespace (that's where slide text paragraphs live).
      .filter((p) => p.namespaceURI?.includes('drawingml'))
      // For each paragraph, glue together the text of all its <a:t> pieces, then trim spaces.
      .map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('').trim())
      // .filter(Boolean) drops empty strings (an empty string counts as "false").
      .filter(Boolean);
    // If the slide had any text, add "Slide N" plus its paragraphs (one per line).
    // The backtick string is a template literal: ${...} inserts a value. i + 1 because i starts at 0.
    if (paras.length) out.push(`Slide ${i + 1}\n${paras.join('\n')}`);
  }
  // Blank line between slides.
  return out.join('\n\n');
}

// ---------------- Excel (.xlsx) ----------------
// Excel stores dates as plain numbers plus a "number format". These built-in format IDs mean date/time formats.
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
/*
 * excelDate(serial) — converts an Excel date number (days since Excel's starting day) into text like "Sep 4, 2025".
 * Input: a number (e.g. 45904). Returns: a string.
 */
function excelDate(serial) {
  // Excel counts days starting from Dec 30, 1899 (month 11 = December, because JS months start at 0).
  // 86400000 = milliseconds in one day; multiply and add to that start date to get the real date.
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
  // Format it in US style ("Sep 4, 2025"). timeZone 'UTC' stops the date shifting by a day because of the local time zone.
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
/*
 * xlsxText(zip) — gets the text of every sheet in a spreadsheet.
 * Each row becomes one line with cells joined by " | "; sheets are separated by a blank line.
 * Input: the unzip() result. Returns (a Promise of) the text.
 */
async function xlsxText(zip) {
  // Excel saves each unique piece of text once in "sharedStrings.xml"; cells then just store an index into this list.
  const shared = [];
  // Read that shared list (it might not exist if the sheet has no text).
  const ss = await zip.text('xl/sharedStrings.xml');
  // For each shared string item <si>, join its <t> text pieces and add it to `shared`, keeping the same order (so indexes match).
  if (ss) for (const si of parseXML(ss).getElementsByTagNameNS('*', 'si')) shared.push(Array.from(si.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join(''));
  // Which cell styles are dates?
  // We'll store the numbers of the cell styles that display a date.
  const dateStyles = new Set();
  // styles.xml describes the formatting styles used by cells.
  const st = await zip.text('xl/styles.xml');
  if (st) {
    const sd = parseXML(st);
    // Find custom number formats (<numFmt>) that look like dates and collect their IDs.
    // The regex /"[^"]*"|\[[^\]]*\]/g removes "quoted text" and [bracketed parts] (like colours [Red]) from the format code,
    // then /[dmy]/i checks if what's left contains d, m or y (day/month/year), ignoring upper/lower case (i).
    // `+f.getAttribute('numFmtId')` converts the ID text into a number.
    const custom = new Set(Array.from(sd.getElementsByTagNameNS('*', 'numFmt')).filter((f) => /[dmy]/i.test((f.getAttribute('formatCode') || '').replace(/"[^"]*"|\[[^\]]*\]/g, ''))).map((f) => +f.getAttribute('numFmtId')));
    // <cellXfs> is the list of cell styles; a cell's "s" attribute is its position in this list.
    const xfs = sd.getElementsByTagNameNS('*', 'cellXfs')[0];
    // For each style (position i), if its number format is a built-in or custom date format, remember i as a "date style".
    // `xfs || {}` avoids a crash if the list is missing (an empty object has no children).
    kids(xfs || {}).forEach((xf, i) => { const id = +xf.getAttribute('numFmtId'); if (BUILTIN_DATE_FMTS.has(id) || custom.has(id)) dateStyles.add(i); });
  }
  // Matches sheet files like "xl/worksheets/sheet3.xml" and captures the number.
  const re = /^xl\/worksheets\/sheet(\d+)\.xml$/;
  // One text chunk per sheet.
  const out = [];
  // Go through each sheet file in number order.
  for (const name of zip.names.filter((n) => re.test(n)).sort(numSort(re))) {
    // Lines (rows) for this sheet.
    const rows = [];
    // Every <row> tag in the sheet.
    for (const row of parseXML(await zip.text(name)).getElementsByTagNameNS('*', 'row')) {
      // Cell texts in this row.
      const cells = [];
      // Every <c> (cell) tag in the row.
      for (const c of kids(row).filter((x) => x.localName === 'c')) {
        // The "t" attribute says the cell's type: "s" shared string, "inlineStr" inline text, "b" boolean, or none for numbers.
        const t = c.getAttribute('t');
        // The cell's stored value is in its <v> tag. `?.` avoids a crash if there's no <v>;
        // `??` ("nullish coalescing") means "if the left side is null/undefined, use '' instead".
        const v = c.getElementsByTagNameNS('*', 'v')[0]?.textContent ?? '';
        // The final text for this cell.
        let val;
        // Shared string: v is an index into the shared list (+v turns "3" into 3).
        if (t === 's') val = shared[+v] ?? '';
        // Inline string: the text is written right inside the cell in <t> tags.
        else if (t === 'inlineStr') val = Array.from(c.getElementsByTagNameNS('*', 't')).map((x) => x.textContent).join('');
        // Boolean: "1" → TRUE, otherwise FALSE.
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        // A number whose style ("s" attribute) is a date style → convert to a readable date.
        // Number.isNaN(+v) checks the value really is a number ("NaN" = Not a Number).
        else if (v !== '' && dateStyles.has(+c.getAttribute('s')) && !Number.isNaN(+v)) val = excelDate(+v);
        // Otherwise just use the raw value (a plain number, or a formula's result).
        else val = v;
        // Only keep non-empty cells (String() makes sure we can call .trim()).
        if (String(val).trim()) cells.push(String(val).trim());
      }
      // Skip empty rows; otherwise join cells with " | ".
      if (cells.length) rows.push(cells.join(' | '));
    }
    // Skip empty sheets.
    if (rows.length) out.push(rows.join('\n'));
  }
  // Blank line between sheets.
  return out.join('\n\n');
}

// ---------------- OpenDocument (.odt/.ods/.odp) ----------------
/*
 * odfWalk(node, lines) — walks an OpenDocument (LibreOffice) XML tree and adds lines of text to `lines`.
 * Paragraphs/headings become one line each; table rows become cells joined by " | ".
 * Inputs: an XML element and the array to fill. Returns: that same array.
 */
function odfWalk(node, lines) {
  for (const c of kids(node)) {
    const n = c.localName;
    // A table row: take each cell's text (whitespace squashed, trimmed), drop empty cells, join with " | ".
    if (n === 'table-row') {
      const cells = kids(c).filter((x) => x.localName === 'table-cell').map((x) => x.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (cells.length) lines.push(cells.join(' | '));
      // A paragraph <text:p> or heading <text:h>.
    } else if (n === 'p' || n === 'h') {
      // Text of this paragraph, built up below.
      let s = '';
      // walk(el) is a small recursive helper that goes through every child node:
      //  - nodeType 3 = plain text → add it
      //  - <text:tab> → tab, <text:line-break> → newline
      //  - <text:s text:c="4"> means "4 spaces" (ODF squeezes repeated spaces this way) → add that many spaces (default 1)
      //  - any other tag (e.g. a styled <text:span>) → look inside it
      const walk = (el) => { for (const k of el.childNodes) { if (k.nodeType === 3) s += k.textContent; else if (k.localName === 'tab') s += '\t'; else if (k.localName === 'line-break') s += '\n'; else if (k.localName === 's') s += ' '.repeat(+k.getAttribute('text:c') || 1); else walk(k); } };
      // Run it on this paragraph, then save the line.
      walk(c);
      lines.push(s);
      // Anything else is a container (sections, lists, frames...) → walk inside it.
    } else odfWalk(c, lines);
  }
  return lines;
}
/*
 * odfText(zip) — gets the text of an .odt/.ods/.odp file.
 * Input: the unzip() result. Returns (a Promise of) the text.
 */
async function odfText(zip) {
  // All OpenDocument files keep their content in content.xml.
  const xml = await zip.text('content.xml');
  if (!xml) throw new Error('This OpenDocument file looks damaged.');
  // Walk the whole document starting from its root element, with an empty list to fill, then join the lines.
  return odfWalk(parseXML(xml).documentElement, []).join('\n');
}

// ---------------- RTF ----------------
// RTF (Rich Text Format) is text mixed with commands like \b (bold) or {\fonttbl ...}.
// SKIP_DEST: "destinations" (groups) that hold non-visible stuff — font tables, colour tables, pictures, headers, metadata...
// When we see one of these, we skip everything in that { } group.
const SKIP_DEST = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'object', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'mmathPr', 'fldinst', 'bkmkstart', 'bkmkend', 'field', 'nonshppict', 'shppict', 'xe']);
// SPECIAL: RTF commands that stand for a character: \par = new paragraph, \tab = tab, \cell = end of table cell,
// \emdash = —, \lquote/\rquote = curly single quotes, \ldblquote/\rdblquote = curly double quotes, etc.
const SPECIAL = { par: '\n', line: '\n', row: '\n', sect: '\n\n', page: '\n\n', tab: '\t', cell: ' | ', emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ' };
/*
 * rtfToText(s) — converts RTF source text into plain text, reading it one character at a time.
 * Input: the RTF file's contents as a string. Returns: plain text.
 * Exported so other files can use it too.
 */
export function rtfToText(s) {
  // RTF writes special characters as \'e9 (a byte in the Windows-1252 code page); this decoder turns that byte into "é".
  const cp = new TextDecoder('windows-1252');
  // The plain text we're building.
  let out = '';
  // A stack (list we add to / remove from the end) of "skip this group?" flags, one per open { }. Start: not skipping.
  const skip = [false];
  // After a \uNNNN unicode character, RTF puts a fallback character for old readers; this counts how many to skip.
  let ucSkip = 0;
  // Current position in the string.
  let i = 0;
  // top(): are we currently inside a group we're skipping? (the last flag on the stack)
  const top = () => skip[skip.length - 1];
  // Go through the whole string.
  while (i < s.length) {
    // The current character.
    const ch = s[i];
    // "{" opens a group: it inherits the skip state of its parent group.
    if (ch === '{') { skip.push(top()); i++; continue; }
    // "}" closes a group: remove its flag (but never remove the very first one).
    if (ch === '}') { if (skip.length > 1) skip.pop(); i++; continue; }
    // A backslash starts an RTF command.
    if (ch === '\\') {
      // Look at the next 40 characters (enough for any command).
      const rest = s.slice(i, i + 40);
      // Will hold regex match results.
      let m;
      // Control word: a backslash, letters (the command name), an optional number (maybe negative), and an optional single space.
      // e.g. "\par ", "\fs24", "\u8217". Group 1 = name, group 2 = number. (Assigning inside if() is intentional.)
      if ((m = rest.match(/^\\([a-zA-Z]+)(-?\d+)? ?/))) {
        // Move past the whole command.
        i += m[0].length;
        // The command's name.
        const w = m[1];
        // Starts a hidden group → mark the current group as skipped.
        if (SKIP_DEST.has(w)) { skip[skip.length - 1] = true; continue; }
        // Inside a skipped group → ignore this command.
        if (top()) continue;
        // \u = a unicode character by number. Negative numbers are an RTF quirk (they wrap around), so add 65536.
        // Then add that character and remember to skip the 1 fallback character that follows.
        if (w === 'u') { let code = +m[2]; if (code < 0) code += 65536; out += String.fromCharCode(code); ucSkip = 1; continue; }
        // If it's a command that means a character (\par, \tab...), add that character. Other commands (bold, font size...) are ignored.
        if (SPECIAL[w]) out += SPECIAL[w];
        continue;
      }
      // Hex character: backslash, apostrophe, then exactly 2 hex digits (0-9, a-f), e.g. \'e9.
      if ((m = rest.match(/^\\'([0-9a-fA-F]{2})/))) {
        // That's always 4 characters long.
        i += 4;
        // If it's the fallback after a \u character, skip it.
        if (ucSkip) { ucSkip--; continue; }
        // Otherwise (and if not in a skipped group) turn the hex number into a byte and decode it with Windows-1252.
        if (!top()) out += cp.decode(Uint8Array.of(parseInt(m[1], 16)));
        continue;
      }
      // Control symbol: a backslash followed by one non-letter character.
      const sym = s[i + 1];
      // Move past the backslash and the symbol.
      i += 2;
      // \* means "if you don't understand the next command, skip this whole group" → skip it.
      if (sym === '*') { skip[skip.length - 1] = true; continue; }
      if (top()) continue;
      // \~ = non-breaking space → normal space.
      if (sym === '~') out += ' ';
      // \_ = non-breaking hyphen → "-"; \- = optional hyphen → nothing.
      else if (sym === '-' || sym === '_') out += sym === '_' ? '-' : '';
      // \\ \{ \} = literal backslash or brace characters → add them as-is.
      else if ('\\{}'.includes(sym)) out += sym;
      // A backslash before a line break also means a new paragraph.
      else if (sym === '\n' || sym === '\r') out += '\n';
      continue;
    }
    // A normal character: move forward.
    i++;
    // Raw line breaks in RTF source are meaningless (real breaks are \par), so ignore them.
    if (ch === '\r' || ch === '\n') continue;
    // Skip the fallback character after a \u character.
    if (ucSkip) { ucSkip--; continue; }
    // Add visible text (if not in a skipped group).
    if (!top()) out += ch;
  }
  return out;
}

// ---------------- HTML ----------------
/*
 * htmlText(html) — gets readable text out of a web page / HTML email.
 * Input: HTML source. Returns: text (table rows become " | " lines, paragraphs end with a line break).
 */
function htmlText(html) {
  // Let the browser parse the HTML into a document (nothing is shown or run).
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Remove parts that aren't readable text: scripts, CSS styles, <noscript>, drawings (svg), and the <head>.
  doc.querySelectorAll('script,style,noscript,svg,head').forEach((n) => n.remove());
  // Replace each table row with a single line of text: cell texts (whitespace squashed) joined by " | ", on its own line.
  doc.querySelectorAll('tr').forEach((tr) => { tr.replaceWith(doc.createTextNode('\n' + Array.from(tr.children).map((td) => td.textContent.replace(/\s+/g, ' ').trim()).join(' | ') + '\n')); });
  // <br> tags → real line breaks.
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  // Add a line break at the end of every block-level element so paragraphs/headings/list items don't run together.
  doc.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,section,article,ul,ol').forEach((b) => b.append('\n'));
  // Take all the text in the body (or '' if there's no body), and squash runs of spaces/tabs (/[ \t]+/g) into one space.
  return (doc.body?.textContent || '').replace(/[ \t]+/g, ' ');
}

// ---------------- Legacy .doc (fallback when the Mac converter isn't available) ----------------
/*
 * legacyDocGuess(buf) — a "best guess" text extractor for old binary .doc files (pre-2007 Word).
 * We don't truly understand the format; we just look for stretches of bytes that look like readable words.
 * Old Word stores text either as 1 byte per letter (Windows-1252) or 2 bytes per letter (UTF-16), so we try both
 * and keep whichever finds more letters.
 * Input: the file's ArrayBuffer. Returns: the guessed text.
 */
function legacyDocGuess(buf) {
  const u8 = new Uint8Array(buf);
  // runs(str): find "runs" of 5+ readable characters in a row. The regex class allows:
  // \p{L} letters (any language), \p{N} numbers, \p{P} punctuation, \p{Zs} spaces, plus tab/CR/LF.
  // The `u` flag turns on these \p{...} Unicode categories; `g` finds all runs.
  // Then keep only runs that contain at least 3 letters in a row (/\p{L}{3}/u), to drop random junk.
  const runs = (str) => (str.match(/[\p{L}\p{N}\p{P}\p{Zs}\t\r\n]{5,}/gu) || []).filter((r) => /\p{L}{3}/u.test(r));
  // Attempt 1: read the bytes as 1-byte-per-character text.
  const a = runs(new TextDecoder('windows-1252').decode(u8));
  // Attempt 2: read as UTF-16 little-endian (2 bytes per character). UTF-16 needs an even number of bytes,
  // so cut off the last byte if the length is odd (u8.length % 2 is 1 for odd lengths).
  const b = runs(new TextDecoder('utf-16le').decode(u8.subarray(0, u8.length - (u8.length % 2))));
  // score(list): how many letters the runs contain in total (/[^\p{L}]/gu removes everything that is NOT a letter).
  const score = (list) => list.join('').replace(/[^\p{L}]/gu, '').length;
  // Pick the attempt with more letters.
  const best = score(b) > score(a) ? b : a;
  // Word uses \r for paragraph ends; turn those into \n, then put each run on its own line.
  return best.map((r) => r.replace(/\r/g, '\n')).join('\n');
}

// ---------------- Local server conversions (macOS textutil / sips) ----------------
/*
 * serverConvert(file, to) — sends a file to our own server (server.js, route /api/convert), which converts it
 * using built-in macOS tools: textutil (old Word → text) or sips (HEIC/TIFF photo → JPEG).
 * Inputs: the File, and `to` = 'text' or 'jpeg'.
 * Returns: the text (when to === 'text') or a Blob of JPEG image data (when to === 'jpeg').
 */
async function serverConvert(file, to) {
  // On the hosted website there is no server to do the conversion (this only affects old formats
  // like .doc and HEIC photos; modern PDFs, .docx and common images are handled in the browser).
  // We import ai.js lazily to avoid a circular import at load time.
  try {
    const ai = await import('./ai.js');
    if (ai.isBrowserMode?.()) throw new Error(`converting ${file.name.replace(/^.*(\.[a-z0-9]+)$/i, '$1')} files needs the local app (node server.js)`);
  } catch (e) {
    // If the message is our "needs the local app" one, surface it; otherwise ignore import hiccups.
    if (/needs the local app/.test(e.message)) throw e;
  }
  // POST the raw file to the server. The template literal builds a URL like /api/convert?to=text&name=Essay.doc;
  // encodeURIComponent makes the file name safe to put in a URL (spaces → %20, etc.).
  const r = await fetch(`/api/convert?to=${to}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
  // r.ok is false for error status codes (e.g. 415 "can't convert" or 500).
  if (!r.ok) {
    // Try to read the server's JSON error message; if the body isn't JSON, .catch gives an empty object instead of crashing.
    const e = await r.json().catch(() => ({}));
    // Throw the server's message, or a generic one that includes the status code.
    throw new Error(e.error || `conversion failed (${r.status})`);
  }
  // For text: the server replies with JSON { text: "..." } → return the text. For jpeg: return the image as a Blob.
  return to === 'text' ? (await r.json()).text : r.blob();
}

// ---------------- OCR (tesseract.js, loaded on demand) ----------------
// Remembers the "loading tesseract" Promise so that if two things ask at once, the script is only added to the page once.
let tessPromise;
/*
 * loadTesseract() — makes sure the tesseract.js OCR library is loaded.
 * Returns: a Promise that resolves to the global Tesseract object.
 * (A Promise is an object representing a result that will arrive later; `await` waits for it.)
 */
function loadTesseract() {
  // Already loaded (the library puts itself on window.Tesseract) → hand it back right away, wrapped in a ready Promise.
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  // `||=` means "only assign if tessPromise is currently empty/falsy" — so we only start loading once.
  // new Promise((resolve, reject) => ...) creates a Promise we finish manually: resolve() = success, reject() = failure.
  tessPromise ||= new Promise((resolve, reject) => {
    // Create a <script> tag that downloads the library.
    const s = document.createElement('script');
    s.src = TESSERACT;
    // When the script has loaded, the Promise succeeds with the Tesseract object.
    s.onload = () => resolve(window.Tesseract);
    // If loading fails (e.g. offline), forget the failed Promise so the next try starts fresh, and fail with a friendly message.
    s.onerror = () => { tessPromise = null; reject(new Error('Couldn’t load the text-recognition engine. Check your internet connection.')); };
    // Adding the tag to the page's <head> starts the download.
    document.head.appendChild(s);
  });
  return tessPromise;
}
/*
 * withOcr(onProgress, fn) — sets up an OCR "worker", lets `fn` use it, then always shuts it down.
 * Inputs:
 *   onProgress — optional function to show status messages (like "reading text… 40%")
 *   fn — a function that receives `rec(img, label)`; calling rec() runs OCR on an image/canvas and returns its text
 * Returns: whatever fn returns.
 */
async function withOcr(onProgress, fn) {
  // Wait until the library is loaded.
  const T = await loadTesseract();
  // `onProgress?.(...)` calls onProgress only if it was given (optional chaining on a function call).
  onProgress?.('loading text recognition…');
  // Text shown before the % in progress messages; rec() can change it (e.g. "scanning page 2/5").
  let label = 'reading text';
  // Start an OCR worker for English ('eng'). The 1 picks Tesseract's neural-network (LSTM) recognition engine.
  // logger is called with status updates; while it's recognising, show "label… NN%".
  const worker = await T.createWorker('eng', 1, {
    logger: (m) => { if (m.status === 'recognizing text') onProgress?.(`${label}… ${Math.round(m.progress * 100)}%`); },
  });
  // try/finally: whatever happens inside `try` (success or error), the `finally` part always runs.
  try {
    // Call fn with our rec(img, lbl) helper: optionally update the label, run OCR, and return the recognised text (.data.text).
    return await fn(async (img, lbl) => { if (lbl) label = lbl; return (await worker.recognize(img)).data.text; });
  } finally {
    // Shut the worker down to free memory.
    await worker.terminate();
  }
}

// Decode any image to a canvas (applies EXIF rotation, downsizes huge phone photos).
/*
 * imageToCanvas(blob) — draws an image file onto a <canvas> (an in-memory drawing surface) that OCR can read.
 * Input: an image File/Blob. Returns: the canvas. Throws if the browser can't decode the image format.
 */
async function imageToCanvas(blob) {
  // Decode the image into a bitmap (pixels). This also applies phone-photo rotation info (EXIF).
  const bmp = await createImageBitmap(blob);
  // Shrink so the longest side is at most 3000 pixels (big photos make OCR slow). Math.min(1, ...) means never enlarge.
  const scale = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  // Make a canvas of the scaled size.
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  // Draw the image onto the canvas, stretched/shrunk to fill it.
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  // Free the bitmap's memory (`?.()` = only if this browser supports close()).
  bmp.close?.();
  return c;
}
/*
 * imageText(file, onProgress) — reads the text in a photo/screenshot using OCR.
 * Inputs: the image File and an optional progress callback. Returns: the recognised text.
 */
async function imageText(file, onProgress) {
  // Will hold the canvas to run OCR on.
  let canvas;
  try {
    // Normal case: the browser can decode the image itself.
    canvas = await imageToCanvas(file);
    // `catch {` without (e) — we don't need the error details here.
  } catch {
    // Browser can't decode it (e.g. HEIC/TIFF in Chrome): ask the Mac to convert it to JPEG
    onProgress?.('converting image…');
    try {
      // Convert on the server, then draw the returned JPEG.
      canvas = await imageToCanvas(await serverConvert(file, 'jpeg'));
    } catch (e) {
      // Still failed → explain and suggest a fix.
      throw new Error(`Couldn’t open this image. ${e.message}. Try exporting it as JPG or PNG.`);
    }
  }
  // Run OCR once on the canvas, with the progress label "reading photo".
  const text = await withOcr(onProgress, (rec) => rec(canvas, 'reading photo'));
  // OCR found nothing but whitespace → tell the student.
  if (!text.trim()) throw new Error('No readable text found in that image. Try a sharper, well-lit photo.');
  return text;
}

// ---------------- PDF (text layer, OCR fallback for scans) ----------------
// Holds the pdf.js library once loaded (starts undefined).
let pdfjs;
/*
 * pdfDoc(data) — opens a PDF with pdf.js (loading the library the first time).
 * Input: the PDF's bytes. Returns (a Promise of) a pdf.js document object.
 */
async function pdfDoc(data) {
  // First time only: download the library with a dynamic import() and tell it where its worker script is.
  if (!pdfjs) {
    pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  // getDocument() returns a "loading task"; its .promise gives the opened document.
  return pdfjs.getDocument({ data }).promise;
}
/*
 * pdfText(buf, onProgress) — gets the text of a PDF.
 * First tries the PDF's built-in "text layer". If there's barely any text (a scanned PDF is just pictures),
 * it renders each page as an image and uses OCR instead.
 * Inputs: the PDF's ArrayBuffer and an optional progress callback. Returns: the text.
 */
async function pdfText(buf, onProgress) {
  const doc = await pdfDoc(buf);
  // Text of each page.
  const pages = [];
  // PDF pages are numbered from 1.
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(`reading page ${i}/${doc.numPages}…`);
    // Load page i, then get its text pieces (each piece has a string and a position).
    const content = await (await doc.getPage(i)).getTextContent();
    // Rebuild lines from y-positions so a date stays on the same line as its item
    // y-position of the previous piece (null = none yet).
    let lastY = null;
    // The line we're currently building.
    let line = '';
    // Finished lines of this page.
    const lines = [];
    for (const it of content.items) {
      // it.transform is a position matrix; item [5] is the vertical (y) position. Round it to a whole number.
      const y = Math.round(it.transform[5]);
      // If this piece is more than 2 units higher/lower than the last one, it's on a new line → save the old line and start fresh.
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ''; }
      // Add the piece, putting a space before it if the line already has text that doesn't end in a space.
      line += (line && !line.endsWith(' ') ? ' ' : '') + it.str;
      lastY = y;
    }
    // Don't forget the last line.
    lines.push(line);
    pages.push(lines.join('\n'));
  }
  // All pages, separated by a blank line.
  const text = pages.join('\n\n');
  // Count the letters (\p{L} = any letter, in any language; `u` flag needed for \p{...}).
  const letters = (text.match(/\p{L}/gu) || []).length;
  // Enough real text (over 40 letters per page on average, or over 400 total)? Then it's a normal PDF — done.
  if (letters > 40 * doc.numPages || letters > 400) return text;

  // Scanned / image-only PDF → OCR each page
  // OCR is slow, so only do the first 25 pages at most.
  const maxPages = Math.min(doc.numPages, 25);
  return withOcr(onProgress, async (rec) => {
    // OCR text of each page.
    const out = [];
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      // A "viewport" at 2x zoom — a sharper image gives better OCR.
      const vp = page.getViewport({ scale: 2 });
      // Make a canvas the size of the page.
      const c = document.createElement('canvas');
      c.width = vp.width;
      c.height = vp.height;
      // Draw (render) the PDF page onto the canvas and wait until it's finished.
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      // OCR the canvas, showing "scanning page i/max" as progress.
      out.push(await rec(c, `scanning page ${i}/${maxPages}`));
    }
    return out.join('\n\n');
  });
}

// ---------------- Apple iWork (.pages/.key/.numbers) ----------------
/*
 * iworkText(zip, onProgress, file) — Apple's formats are hard to read directly, but they usually contain
 * a preview copy (a PDF or JPEG) inside the zip. We read the text from that preview instead.
 * Inputs: the unzip() result, a progress callback, and the original File. Returns: the text.
 */
async function iworkText(zip, onProgress, file) {
  // Look for a file named Preview.pdf, at the top level or after a "/" (optionally inside a QuickLook/ folder).
  // ( ^|\/ ) = start of name or a slash; (QuickLook\/)? = optional folder; i = ignore upper/lower case.
  const pdfName = zip.names.find((n) => /(^|\/)(QuickLook\/)?Preview\.pdf$/i.test(n));
  if (pdfName) {
    // Get its bytes. They're a "view" into the bigger zip buffer, so .buffer.slice(...) copies out exactly
    // those bytes into their own ArrayBuffer (byteOffset = where they start, byteLength = how many).
    const bytes = await zip.read(pdfName);
    return pdfText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), onProgress);
  }
  // Otherwise look for a preview image: preview.jpg, preview.jpeg, preview-web.jpg... (jpe?g = "jpg" or "jpeg").
  const jpg = zip.names.find((n) => /preview(-web)?\.jpe?g$/i.test(n));
  // Only use the image for Pages or Keynote (a spreadsheet preview image usually isn't useful).
  if (jpg && /pages|key/.test(extOf(file.name))) {
    const bytes = await zip.read(jpg);
    // Wrap the bytes in a File object so imageText() can OCR it like a normal upload.
    return imageText(new File([bytes], 'preview.jpg', { type: 'image/jpeg' }), onProgress);
  }
  // No preview at all → explain how to export a PDF instead.
  throw new Error('This Apple file doesn’t include a readable preview. In Pages/Keynote/Numbers use File → Export To → PDF, then upload that.');
}

// ---------------- Main entry ----------------
/*
 * readFileText(file, { onProgress }) — THE main function other files use. Figures out what kind of file it is
 * and sends it to the right reader above.
 * Inputs: a File (from a file picker or drag-and-drop) and an optional options object with onProgress.
 *   `{ onProgress } = {}` is destructuring with a default: pull onProgress out of the 2nd argument, or use {} if none was passed.
 * Returns (a Promise of) the cleaned-up text. Throws a friendly Error if the file can't be read.
 */
export async function readFileText(file, { onProgress } = {}) {
  // The file's extension ("pdf", "docx"...).
  const ext = extOf(file.name);
  // The browser's MIME type for the file (may be empty), e.g. "application/pdf".
  const type = file.type || '';
  onProgress?.(`reading ${file.name}…`);

  // PDF → read all bytes (file.arrayBuffer()) and extract text, then tidy the whitespace.
  if (ext === 'pdf' || type === 'application/pdf') return tidy(await pdfText(await file.arrayBuffer(), onProgress));
  // Image → OCR.
  if (IMAGE_EXT.has(ext) || type.startsWith('image/')) return tidy(await imageText(file, onProgress));

  // Zip-based formats: modern Office (Word/PowerPoint/Excel), OpenDocument, and Apple iWork.
  if (['docx', 'docm', 'dotx', 'dotm', 'pptx', 'pptm', 'ppsx', 'potx', 'xlsx', 'xlsm', 'odt', 'ott', 'ods', 'odp', 'pages', 'key', 'numbers'].includes(ext)) {
    let zip;
    // Try to unzip. If it fails...
    try { zip = await unzip(await file.arrayBuffer()); } catch {
      // ...Apple files saved as a "package" (actually a folder) aren't zips → explain the export workaround.
      if (['pages', 'key', 'numbers'].includes(ext)) throw new Error('This Apple file is a folder bundle. In Pages use File → Export To → PDF, then upload that.');
      // Otherwise the file is broken or encrypted (password-protected Office files aren't normal zips).
      throw new Error('This file looks damaged or password-protected.');
    }
    // Pick the reader by the start of the extension: doc*/dot* → Word,
    if (/^doc|^dot/.test(ext)) return tidy(await docxText(zip));
    // ppt*/pps*/pot* → PowerPoint,
    if (/^ppt|^pps|^pot/.test(ext)) return tidy(await pptxText(zip));
    // xls* → Excel,
    if (/^xls/.test(ext)) return tidy(await xlsxText(zip));
    // od*/ott → OpenDocument,
    if (/^od|^ott/.test(ext)) return tidy(await odfText(zip));
    // anything left (pages/key/numbers) → Apple iWork.
    return tidy(await iworkText(zip, onProgress, file));
  }

  // Old binary Office formats (before 2007). These need the Mac server to convert them.
  if (['doc', 'dot', 'wps', 'ppt', 'xls'].includes(ext)) {
    try {
      // Ask the server to turn it into text.
      return tidy(await serverConvert(file, 'text'));
    } catch (e) {
      // Old PowerPoint/Excel: no fallback, so ask the student to re-save it (e.g. as .pptx or .xlsx).
      if (ext !== 'doc' && ext !== 'dot' && ext !== 'wps') throw new Error(`Old .${ext} files can’t be read here. Save it as .${ext}x or PDF and try again.`);
      // Old Word: try our rough "guess the words" reader.
      const guess = legacyDocGuess(await file.arrayBuffer());
      // If the guess has fewer than 30 non-space characters (/\s/g = every whitespace character), it didn't really work.
      if (guess.replace(/\s/g, '').length < 30) throw new Error('Couldn’t read this old Word file. Save it as .docx or PDF and try again.');
      return tidy(guess);
    }
  }

  // Everything else is treated as a text file: read it as a string.
  const raw = await file.text();
  // RTF: by extension, or if the content starts with "{\rtf" (/^\{\\rtf/ — the { and \ are escaped).
  if (ext === 'rtf' || /^\{\\rtf/.test(raw)) return tidy(rtfToText(raw));
  // HTML web pages → strip the tags.
  if (['html', 'htm', 'xhtml'].includes(ext) || type === 'text/html') return tidy(htmlText(raw));
  // TSV (tab-separated values) → show tabs as " | " like our other tables.
  if (ext === 'tsv') return tidy(raw.replace(/\t/g, ' | '));
  // Email (.eml): if it contains "<html" (any case), extract HTML text; otherwise remove the headers —
  // the regex /^[\s\S]*?\r?\n\r?\n/ matches everything from the start up to the FIRST blank line
  // ([\s\S] = any character incl. newlines, *? = as few as possible), which is where email headers end.
  if (ext === 'eml') return tidy(/<html/i.test(raw) ? htmlText(raw) : raw.replace(/^[\s\S]*?\r?\n\r?\n/, ''));
  // A "null" character (\u0000) in the first 4000 characters means this is really a binary file we don't understand.
  if (/\u0000/.test(raw.slice(0, 4000))) throw new Error(`.${ext || 'this'} files aren’t supported yet. Export it as PDF, Word or a photo and try again.`);
  // Plain text (txt, md, csv, json, ics, tex...) → just tidy it.
  return tidy(raw);
}

// Several files at once (e.g. photos of each syllabus page) → one text, in order.
/*
 * readFilesText(files, { onProgress }) — reads several files one after another and joins their text.
 * Inputs: a FileList or array of Files, and an optional progress callback. Returns: one combined string.
 */
export async function readFilesText(files, { onProgress } = {}) {
  // FileList isn't a real array; Array.from makes it one.
  const list = Array.from(files);
  // Text of each file.
  const parts = [];
  // Loop with both index and file (destructuring [i, f]).
  for (const [i, f] of list.entries()) {
    // When there's more than one file, prefix progress messages with "(2/5) " so the student knows which file is being read.
    const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ` : '';
    // Read this file (one at a time, waiting for each), passing a progress function that adds the prefix.
    parts.push(await readFileText(f, { onProgress: (m) => onProgress?.(prefix + m) }));
  }
  // Blank line between files.
  return parts.join('\n\n');
}

// Paste a screenshot (⌘⇧⌃4 on Mac) straight into a textarea → OCR text is inserted.
/*
 * enableImagePaste(textarea, { onProgress, onDone, onError }) — makes a text box accept pasted images:
 * the image is OCR'd and the text is inserted where the cursor is.
 * Inputs: a <textarea> element and optional callbacks (progress, done with text, error). Returns nothing.
 */
export function enableImagePaste(textarea, { onProgress, onDone, onError } = {}) {
  // Run this async function every time something is pasted into the textarea.
  textarea.addEventListener('paste', async (e) => {
    // Look through the clipboard items for a file that's an image. (`?.` and `|| []` in case there's no clipboard data.)
    const item = Array.from(e.clipboardData?.items || []).find((x) => x.kind === 'file' && x.type.startsWith('image/'));
    // Not an image (normal text paste) → do nothing and let the browser paste normally.
    if (!item) return;
    // It IS an image → stop the browser's default paste (which would do nothing useful).
    e.preventDefault();
    // Get the image as a File.
    const file = item.getAsFile();
    try {
      // Give it a file name ending in .png so readFileText treats it as an image, then OCR it.
      const text = await readFileText(new File([file], 'pasted-screenshot.png', { type: file.type }), { onProgress });
      // Destructuring with renaming: take textarea.selectionStart as `a`, selectionEnd as `b` (the cursor/selection), and value.
      const { selectionStart: a, selectionEnd: b, value } = textarea;
      // Insert the text at the cursor: text before + new text + text after (replacing any selected text).
      textarea.value = value.slice(0, a) + text + value.slice(b);
      // Changing .value by code doesn't fire an "input" event, so fire one ourselves so other code notices the change.
      textarea.dispatchEvent(new Event('input'));
      // Tell the caller we're done (if they asked).
      onDone?.(text);
    } catch (err) {
      // Pass errors to the caller's error handler (if any).
      onError?.(err);
    }
  });
}
