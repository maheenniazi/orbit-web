/*
 * notes.js — the "notebook" page: course folders full of markdown notes.
 *
 * What it does:
 *  - Shows one folder per course (plus "general"), each listing its notes; exam prep notes
 *    (cheat sheet / practice test from examprep.js) appear at the top of their folder.
 *  - Lets you view a note (markdown rendered as HTML), edit it, rename it, move it, delete it (with undo),
 *    quiz yourself on it in the chat, or print it as a PDF.
 *  - "generate notes": paste lecture text or upload slides/readings/photos (read by fileread.js),
 *    pick a style (outline, Cornell, summary, flashcards) and get study notes back.
 *    With an AI key, the AI writes them (generateAI). Without one, generateLocal() builds "extractive"
 *    notes: it picks the most important existing sentences using keyword counts — no AI involved.
 *
 * Big idea for beginners: render(el) builds the page as one big HTML string (template literal),
 * puts it into the page with innerHTML, then attaches click/input handlers. Whenever something
 * changes, draw() simply rebuilds everything from the saved data in the store.
 */
// Notes: generate structured notes from lecture text / slides / readings (AI or offline), edit in markdown.
// store = saved app data; getCourse = find a course by id; courseColor = a course's colour.
import { store, getCourse, courseColor } from './store.js';
// AI helpers: is an AI key set up? / send a prompt to the AI / get a model's display info.
import { aiEnabled, ask, modelInfo } from './ai.js';
// The dropdown for choosing which AI model writes the notes.
import { mountModelPicker } from './modelpicker.js';
// esc = make text safe inside HTML; md = markdown → HTML; uid = random id; date helpers.
import { esc, md, uid, fmtDate, todayISO } from './util.js';
// UI helpers: pop-up dialog, toast message, file reading (re-exported from fileread.js), accepted file types, spinner.
import { modal, toast, readFilesText, enableImagePaste, ACCEPT, spinner } from './ui.js';
// askAbout = open the chat page with a question already sent (used by "quiz me").
import { askAbout } from './chat.js';
// Exam prep helpers: build a prep pack, find prep notes for an exam, list upcoming exams.
import { makePrep, prepFor, upcomingExams } from './examprep.js';
// printDoc = open a printable page (save as PDF) for some markdown.
import { printDoc } from './careers.js';
// daysUntil = number of days from today to a date (a second import from util.js; that's allowed).
import { daysUntil } from './util.js';

// The note styles the student can pick from: internal key → label shown on the button.
const STYLES = {
  outline: 'Structured outline',
  cornell: 'Cornell notes',
  summary: 'One-page summary',
  flashcards: 'Flashcards',
};

// "Stop words": very common words that tell us nothing about the topic ("the", "and", "with"...).
// We write them as one long string and .split(' ') turns it into an array of words; the Set makes lookups fast.
// The offline note generator ignores these when looking for keywords.
const STOP = new Set('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its just may more most much must no not of on or our out over so some such than that the their them then there these they this those to too under up us was we were what when where which while who why will with would you your also each other only very about after again all am any because before being below between both down during few further here itself let me my myself nor off once ours own same she should thats theirs themselves through until yours one two use used using like well get make many new way'.split(' '));

/*
 * sentences(text) — splits text into sentences of a sensible length.
 * Input: any text. Returns: an array of sentence strings (26 to 399 characters long).
 */
function sentences(text) {
  // Split per line first so headings don't glue onto the next sentence.
  return text
    // split at one or more line breaks (/\n+/)
    .split(/\n+/)
    // For each line: squash whitespace to single spaces, then find the sentences in it.
    // The regex /[^.!?]+[.!?]+(\s|$)/g means: one or more characters that are NOT . ! or ?,
    // then one or more of . ! ?, then a space or the end of the line. `|| []` handles lines with no full sentence.
    // flatMap joins all lines' sentence arrays into one array.
    .flatMap((l) => l.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(\s|$)/g) || [])
    // trim the spaces around each sentence
    .map((s) => s.trim())
    // drop very short bits (like "Fig. 2.") and giant run-on chunks
    .filter((s) => s.length > 25 && s.length < 400);
}
// Regex for "definition words": the whole word (\b = word boundary) is / are / refers to / is defined as / means, any case (i).
const DEF_RE = /\b(is|are|refers to|is defined as|means)\b/i;
// defTerm(s): the term being defined = everything before the first definition word,
// with a leading "the", "a" or "an" removed. e.g. "The hippocampus is ..." → "hippocampus".
const defTerm = (s) => s.split(DEF_RE)[0].replace(/^(the|a|an)\s+/i, '').trim();
// isDefinition(s): does this sentence look like a definition?
const isDefinition = (s) => {
  const t = defTerm(s);
  // Yes if: it has a definition word, the term is more than 1 character and at most 4 words,
  // and the term doesn't start with a vague word like "research", "this", "it", "they"... (those aren't real definitions).
  return DEF_RE.test(s) && t.length > 1 && t.split(/\s+/).length <= 4 && !/^(research|studies|this|it|there|that|these|they|we|he|she)\b/i.test(t);
};
/*
 * keywords(text, n) — finds the n most frequent meaningful words in the text.
 * Inputs: text, and how many to return (default 10). Returns: an array of words, most frequent first.
 */
function keywords(text, n = 10) {
  // word → how many times it appears
  const freq = {};
  // Words = a letter followed by 3+ letters or hyphens (so 4+ characters long). Skip stop words; count the rest.
  // `(freq[w] || 0) + 1` starts at 0 the first time we see a word.
  for (const w of text.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []) if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
  // Object.entries turns { word: count } into [[word, count], ...]; sort by count (b[1] - a[1] = biggest first);
  // take the top n; `([w]) => w` destructures each pair and keeps just the word.
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

// Offline extractive note generator.
/*
 * generateLocal(text, style, title) — makes notes WITHOUT AI by picking out the most important sentences,
 * definitions, headings and keywords from the source text.
 * Inputs: the source text, the style key ('outline' | 'cornell' | 'summary' | 'flashcards'), and the note title.
 * Returns: a markdown string. Exported so other parts of the app can use it too.
 */
export function generateLocal(text, style, title) {
  // All usable sentences.
  const sents = sentences(text);
  // The 12 most frequent topic words.
  const keys = keywords(text, 12);
  // score(s): how many keywords a sentence contains, divided by the square root of its word count —
  // so keyword-rich sentences win, without simply rewarding long sentences.
  // reduce() walks the keywords, adding 1 to the running total `a` for each keyword found.
  const score = (s) => keys.reduce((a, k) => a + (s.toLowerCase().includes(k) ? 1 : 0), 0) / Math.sqrt(s.split(' ').length);
  // The top 6 sentences: remember each sentence with its original position i and score v,
  // sort by score (highest first), keep 6, then sort back into original order (so they read naturally), and keep just the text.
  const top = sents.map((s, i) => ({ s, i, v: score(s) })).sort((a, b) => b.v - a.v).slice(0, 6).sort((a, b) => a.i - b.i).map((x) => x.s);
  // Up to 8 definition sentences.
  const defs = sents.filter(isDefinition).slice(0, 8);
  // Lines that look like headings: 4 to 59 characters, not ending in . , or ; and any of:
  //   /^#/                 starts with # (a markdown heading)
  //   /^[A-Z0-9][^a-z]*$/  ALL CAPS (no lowercase letters at all)
  //   /^\d+[.)]\s/         numbered like "1. " or "2) "
  //   /^[A-Z][\w\s:&-]+$/  starts with a capital and has only letters/digits, spaces, : & and -
  // Keep at most 10.
  const heads = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 3 && l.length < 60 && !/[.,;]$/.test(l) && (/^#/.test(l) || /^[A-Z0-9][^a-z]*$/.test(l) || /^\d+[.)]\s/.test(l) || /^[A-Z][\w\s:&-]+$/.test(l))).slice(0, 10);
  // term(s): the defined term (max 60 chars) for use in a question. If it starts with 2+ capitals (an acronym like "DNA")
  // keep it; otherwise lowercase its first letter so "What is hippocampus?" reads naturally mid-sentence.
  const term = (s) => { const t = defTerm(s).slice(0, 60); return /^[A-Z]{2,}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1); };
  // A "What is ...?" question for each definition.
  const questions = defs.map((d) => `What is ${term(d)}?`);

  // FLASHCARDS: use the definitions as cards (or the top sentences if there are none).
  if (style === 'flashcards') {
    const cards = defs.length ? defs : top;
    // Builds "## Title · Flashcards", then for each card: a bold "Q1. What is X?" (or "Q1. Explain:" when using top sentences)
    // and the sentence as a quote line ("> ..."). Template literals can be nested: `${ ... `inner` ... }`.
    return `## ${title} · Flashcards\n\n${cards.map((c, i) => `**Q${i + 1}. ${defs.length ? `What is ${term(c)}?` : 'Explain:'}**\n> ${c}\n`).join('\n')}`;
  }
  // CORNELL notes: three sections.
  if (style === 'cornell') {
    // "### Cues / Questions": the definition questions, or (if none) "What is the role of <keyword>?" for 5 keywords, as bullets;
    // "### Notes": the top sentences as bullets; "### Summary": the first 2 top sentences as a paragraph.
    return `## ${title}\n\n### Cues / Questions\n${(questions.length ? questions : keys.slice(0, 5).map((k) => `What is the role of ${k}?`)).map((q) => `- ${q}`).join('\n')}\n\n### Notes\n${top.map((s) => `- ${s}`).join('\n')}\n\n### Summary\n${top.slice(0, 2).join(' ')}\n`;
  }
  // SUMMARY: the top sentences as one paragraph, then up to 8 key terms shown as `code` chips.
  if (style === 'summary') {
    return `## ${title}\n\n${top.join(' ')}\n\n**Key terms:** ${keys.slice(0, 8).map((k) => `\`${k}\``).join(' ')}\n`;
  }
  // OUTLINE (the default). Sections, in order:
  //  - "### Topics" (only if headings were found): each heading as a bullet, with leading # marks removed (/^#+\s*/)
  //  - "### Key points": the top sentences
  //  - "### Key terms": up to 10 keywords in bold
  //  - "### Definitions" (only if any were found)
  //  - "### Review questions": the definition questions as checkboxes "- [ ] ..." (or one generic question if none)
  return `## ${title}\n\n${heads.length ? `### Topics\n${heads.map((h) => `- ${h.replace(/^#+\s*/, '')}`).join('\n')}\n\n` : ''}### Key points\n${top.map((s) => `- ${s}`).join('\n')}\n\n### Key terms\n${keys.slice(0, 10).map((k) => `- **${k}**`).join('\n')}\n${defs.length ? `\n### Definitions\n${defs.map((d) => `- ${d}`).join('\n')}\n` : ''}\n### Review questions\n${(questions.length ? questions : ['Summarize the main idea in two sentences.']).map((q) => `- [ ] ${q}`).join('\n')}\n`;
}

/*
 * generateAI(text, style, title) — asks the AI to write the notes.
 * Inputs: the source text, the style key, and the title. Returns (a Promise of) the AI's markdown.
 * `async` = this function can use `await` and always returns a Promise.
 */
async function generateAI(text, style, title) {
  // Style-specific instructions. We write an object of all four, then immediately pick the one for `style` with [style].
  const guide = {
    outline: 'A hierarchical outline with ## sections, bullet points, **bold** key terms, a "Key terms" glossary, and 5 "- [ ] " review questions at the end.',
    cornell: 'Cornell format: "### Cues / Questions" (bullets), "### Notes" (detailed bullets), "### Summary" (3-4 sentences).',
    summary: 'A tight one-page summary: 1 paragraph overview, then "### Must-know" bullets, then "### Common mistakes".',
    flashcards: 'Flashcards: each as "**Q: ...**" on one line followed by "> A: ..." on the next. 12-20 cards covering all key concepts.',
  }[style];
  // Send the request (returns a Promise of the reply text).
  return ask({
    // System prompt: "turn lecture material into study notes in Markdown" + the style guide + use ==highlight== for the
    // most exam-relevant facts + start with "## <title>" + be accurate and don't invent facts.
    system: `You turn raw lecture material into excellent student study notes in Markdown. ${guide} Use ==highlight== for the single most exam-relevant facts. Start with "## ${title}". Be accurate; do not invent facts not supported by the source.`,
    // The source text is the "user" message, cut to 60000 characters so the request isn't too big.
    messages: [{ role: 'user', content: text.slice(0, 60000) }],
    // Maximum length of the answer.
    maxTokens: 4000,
  });
}

// These variables live outside render(), so they're remembered even when you leave the page and come back.
// The id of the note currently shown on the right.
let selectedId = null;
// true = show the markdown editor; false = show the rendered note.
let editing = false;
let openFolder = null; // course id of the folder you're looking at ('' = general)
// Ids of folders the student has collapsed (closed).
const collapsed = new Set();

// Guess a course from a note's title/body (for "sort into folders")
/*
 * guessCourse(n, courses) — guesses which course a note belongs to by looking for the course's code or name in it.
 * Inputs: a note and the list of courses. Returns: the matching course object, or undefined.
 */
function guessCourse(n, courses) {
  // "Haystack" to search in: title + first 3000 characters of the body, in UPPERCASE, with whitespace squashed.
  const hay = `${n.title}\n${n.body.slice(0, 3000)}`.toUpperCase().replace(/\s+/g, ' ');
  // Same text with all spaces and hyphens removed (/[\s-]/g), so "PSY 100" and "PSY-100" both match "PSY100".
  const tight = hay.replace(/[\s-]/g, '');
  // First try: a course whose code (also without spaces/hyphens) appears in the text.
  return courses.find((c) => c.code && tight.includes(c.code.toUpperCase().replace(/[\s-]/g, '')))
    // Otherwise (`||`): a course whose full name (longer than 5 characters, to avoid false matches) appears.
    || courses.find((c) => c.name && c.name.length > 5 && hay.includes(c.name.toUpperCase()));
}

/*
 * render(el) — draws the notes page inside `el`. Called by app.js when you go to #/notes.
 * Input: the page container element. Returns nothing.
 */
export function render(el) {
  // Another page (e.g. the exam prep "open" button) may have asked us to open a specific note.
  const pre = sessionStorage.getItem('studyos:open-note');
  // If so: forget the request (so it only happens once), select that note, and show it in view mode.
  if (pre) { sessionStorage.removeItem('studyos:open-note'); selectedId = pre; editing = false; }

  // draw() builds the whole page from the current data and attaches all the event handlers.
  // It's called again after every change. It's an arrow function stored in a variable.
  const draw = () => {
    const s = store.get();
    // A sorted copy of all notes ([...array] spread makes a copy), most recently updated first.
    const notes = [...s.notes].sort((a, b) => b.updatedAt - a.updatedAt);
    // If nothing is selected (or the selected note was deleted), pick: the newest note in the open folder,
    // else the newest note overall, else nothing (null).
    // `openFolder == null` (two =) is true for both null and undefined, i.e. "no folder chosen yet".
    // `(n.courseId || '')` treats a missing course id as '' (the general folder). `?.id` avoids crashing if nothing was found.
    if (!selectedId || !notes.find((n) => n.id === selectedId)) selectedId = notes.find((n) => openFolder == null || (n.courseId || '') === openFolder)?.id || notes[0]?.id || null;
    // The selected note object (or undefined).
    const note = notes.find((n) => n.id === selectedId);
    // The open folder follows the selected note.
    if (note) openFolder = note.courseId || '';
    // Set of all course ids that still exist (notes pointing to a deleted course count as "general").
    const known = new Set(s.courses.map((c) => c.id));
    // The folder list: one per course, then the "general" folder.
    const folders = [
      // For each course: id, display name (code if it has one, else name), a subtitle (the full name, if different from the code), and colour.
      ...s.courses.map((c) => ({ id: c.id, name: c.code || c.name, sub: c.code && c.name !== c.code ? c.name : '', color: c.color })),
      // The general folder uses id '' and a faint grey colour (a CSS variable).
      { id: '', name: 'general', sub: 'not tied to a course', color: 'var(--faint)' },
    ];
    // inFolder(fid): notes in folder fid. A note's folder is its courseId if that course exists, otherwise '' (general).
    const inFolder = (fid) => notes.filter((n) => (known.has(n.courseId) ? n.courseId : '') === fid);
    // General notes (not prep notes) that we could auto-sort into a course folder.
    const unsorted = inFolder('').filter((n) => !n.prep && guessCourse(n, s.courses));

    // noteItem(n): HTML for one note in the sidebar list. The template builds:
    //  - a <div class="note-item"> with extra classes "on" (if it's the selected note) and "prep" (if it's a prep note),
    //    and data-id holding the note's id (used by the click handler below);
    //  - the escaped title, plus a "practice" or "cheat sheet" tag for prep notes;
    //  - a preview (class "s") of the body: the regex /^\s*(#+|>|[-*]\s+\[[ x]\]|[-*]|\d+\.)\s*/gim removes markdown markers
    //    at the start of every line (headings #, quotes >, checkboxes "- [ ]", bullets - or *, numbers "1."),
    //    the m flag makes ^ mean "start of each line"; then /[*`=]/g removes * ` = characters, whitespace is squashed,
    //    and only the first 110 characters are kept.
    const noteItem = (n) => `<div class="note-item ${n.id === selectedId ? 'on' : ''} ${n.prep ? 'prep' : ''}" data-id="${n.id}">
      <div class="row spread" style="flex-wrap:nowrap"><span class="t">${esc(n.title)}</span>${n.prep ? `<span class="prep-tag">${n.prep.kind === 'practice' ? 'practice' : 'cheat sheet'}</span>` : ''}</div>
      <div class="s">${esc(n.body.replace(/^\s*(#+|>|[-*]\s+\[[ x]\]|[-*]|\d+\.)\s*/gim, '').replace(/[*`=]/g, '').replace(/\s+/g, ' ').slice(0, 110))}</div></div>`;

    // folderHTML(f): HTML for one folder in the sidebar.
    const folderHTML = (f) => {
      // Notes in this folder.
      const list = inFolder(f.id);
      // Hide the general folder completely when it's empty.
      if (!list.length && f.id === '' ) return '';
      // The next exam for this course (course folders only; general has none).
      const exam = f.id ? upcomingExams(f.id)[0] : null;
      // Does that exam already have prep notes? (A number > 0 counts as true.)
      const hasPrep = exam && prepFor(exam.id).length;
      // Open unless the student collapsed it.
      const isOpen = !collapsed.has(f.id);
      // Prep notes, with the cheat sheet sorted before the practice test.
      const prep = list.filter((n) => n.prep).sort((a, b) => (a.prep.kind === 'cheatsheet' ? -1 : 1));
      // The student's normal notes.
      const rest = list.filter((n) => !n.prep);
      // The folder template:
      //  - a <div class="nfolder"> (class "open" when open) with data-folder = folder id;
      //  - a header button (data-fold = folder id, for collapsing) showing an arrow, a coloured dot, the name and the note count;
      //  - when open:
      //     * if there's an upcoming exam: its title and "today" or "in Nd", then either nothing (prep exists),
      //       a "make cheat sheet + practice test" button (data-prep = exam id) if there are notes, or a hint to add notes;
      //     * the prep notes, then the normal notes (each via noteItem);
      //     * "empty folder" if there are no notes;
      //     * a "+ new page here" button (data-new = folder id).
      return `<div class="nfolder ${isOpen ? 'open' : ''}" data-folder="${esc(f.id)}">
        <button class="nfolder-head" data-fold="${esc(f.id)}">
          <span class="chev ${isOpen ? 'down' : ''}"></span><span class="dot-c" style="background:${f.color}"></span>
          <span class="nf-name">${esc(f.name)}</span><span class="nf-count">${list.length}</span>
        </button>
        ${isOpen ? `
          ${exam ? `<div class="nf-exam">${esc(exam.title)} · ${daysUntil(exam.date) === 0 ? 'today' : `in ${daysUntil(exam.date)}d`}
            ${hasPrep ? '' : rest.length ? `<button class="link-btn" data-prep="${exam.id}">make cheat sheet + practice test</button>` : '<span class="faint">add notes to get exam prep</span>'}</div>` : ''}
          ${prep.map(noteItem).join('')}${rest.map(noteItem).join('')}
          ${list.length ? '' : '<div class="small faint" style="padding:6px 10px 10px">empty folder</div>'}
          <button class="link-btn nf-new" data-new="${esc(f.id)}">+ new page here</button>` : ''}
      </div>`;
    };

    // The whole page. The template contains:
    //  - Header: "notes · N saved · M course folder(s)", the title "the notebook", a description,
    //    and buttons "+ blank page" (#blank) and "generate notes" (#gen).
    //  - Left card: a search box (#search); a "sort N general notes into course folders" button (#sort) if any can be sorted;
    //    and the folder list (#list) — or an "empty." message if there are no notes and no courses.
    //  - Right card (#pane): if a note is selected:
    //      * a "folder" dropdown (#move) listing all folders with the note's current folder selected,
    //        and "updated <date>" (+ "written by ai"/"basic version" for prep notes);
    //      * buttons: remake (#regen, prep notes only), pdf, quiz me, edit/done, delete;
    //      * the title input (#title);
    //      * either a textarea editor (#body) when editing, or the note rendered from markdown with md().
    //    If no note: a "blank page" call-to-action with a "generate notes" button (#gen2).
    el.innerHTML = `
      <div class="page-head">
        <div><div class="kicker">notes · ${notes.length} saved · ${s.courses.length} course folder${s.courses.length === 1 ? '' : 's'}</div><h1>the <em>notebook</em></h1><p>a folder for every course. paste a lecture or upload slides and get clean study notes back, plus a cheat sheet and practice test before each exam.</p></div>
        <div class="row"><button class="btn ghost sm" id="blank">+ blank page</button><button class="btn sm" id="gen">generate notes</button></div>
      </div>
      <div class="notes-layout">
        <div class="card" style="padding:12px">
          <input id="search" placeholder="search all notes…" style="margin-bottom:8px">
          ${unsorted.length ? `<button class="btn ghost sm" id="sort" style="width:100%;margin-bottom:8px;justify-content:center">sort ${unsorted.length} general note${unsorted.length === 1 ? '' : 's'} into course folders</button>` : ''}
          <div class="note-list" id="list">${notes.length || s.courses.length ? folders.map(folderHTML).join('') : '<div class="empty"><span class="big">empty.</span>import a syllabus and each course gets its own folder</div>'}</div>
        </div>
        <div class="card paper-sheet" id="pane">
          ${note ? `
            <div class="row spread" style="margin-bottom:10px">
              <label class="small muted row" style="gap:6px">folder
                <select id="move" class="move-sel">${folders.map((f) => `<option value="${esc(f.id)}" ${(known.has(note.courseId) ? note.courseId : '') === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
                · updated ${fmtDate(new Date(note.updatedAt).toISOString().slice(0, 10))}${note.prep ? ` · ${note.prep.by === 'ai' ? 'written by ai' : 'basic version'} from your notes` : ''}
              </label>
              <div class="row">
                ${note.prep ? '<button class="btn ghost sm" id="regen">remake</button>' : ''}
                <button class="btn ghost sm" id="pdf">pdf</button>
                <button class="btn ghost sm" id="quiz">quiz me</button>
                <button class="btn ghost sm" id="edit">${editing ? 'done' : 'edit'}</button>
                <button class="icon-btn" id="del" title="Delete">delete</button>
              </div>
            </div>
            <input class="note-title" id="title" value="${esc(note.title)}">
            ${editing ? `<textarea class="editor" id="body">${esc(note.body)}</textarea>` : `<div class="prose">${md(note.body)}</div>`}
          ` : `<div class="cta"><div class="big">a blank page.</div><h3>your notes live here</h3><p class="muted">generate notes from lecture text or a pdf, or start from scratch.</p><button class="btn" id="gen2">generate notes</button></div>`}
        </div>
      </div>`;

    // $(q): shortcut to find one element inside this page by CSS selector (like "#gen").
    const $ = (q) => el.querySelector(q);
    // "generate notes" opens the generator dialog, defaulting to the open folder.
    $('#gen').onclick = () => openGenerator(openFolder);
    // Same for the second button, which only exists when no note is selected (`?.` skips it if it's missing).
    $('#gen2')?.addEventListener('click', () => openGenerator(openFolder));
    // newPage(fid): create an empty "Untitled" note in folder fid, select it, open the editor, make sure the folder is open, redraw.
    const newPage = (fid) => {
      const id = uid();
      // `id` alone in the object is shorthand for `id: id`. Date.now() = the current time in milliseconds.
      store.update((st) => st.notes.push({ id, title: 'Untitled', courseId: fid || '', body: '', createdAt: Date.now(), updatedAt: Date.now() }));
      selectedId = id; editing = true; collapsed.delete(fid || ''); draw();
    };
    // "+ blank page" adds a page to the open folder.
    $('#blank').onclick = () => newPage(openFolder);
    // Each "+ new page here" button adds a page to its own folder (read from its data-new attribute via dataset.new).
    el.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => newPage(b.dataset.new)));
    // Clicking a folder header toggles it: if collapsed, un-collapse it; otherwise collapse it. Then redraw.
    el.querySelectorAll('[data-fold]').forEach((b) => (b.onclick = () => { const f = b.dataset.fold; collapsed.has(f) ? collapsed.delete(f) : collapsed.add(f); draw(); }));
    // Clicking a note in the list selects it (in view mode).
    el.querySelectorAll('.note-item').forEach((n) => (n.onclick = () => { selectedId = n.dataset.id; editing = false; draw(); }));
    // "make cheat sheet + practice test" buttons.
    el.querySelectorAll('[data-prep]').forEach((b) => (b.onclick = async () => {
      // Find the exam event by the id stored on the button.
      const exam = store.get().events.find((e) => e.id === b.dataset.prep);
      // Disable the button and show progress text so it can't be clicked twice.
      b.disabled = true; b.textContent = 'making your prep…';
      // Build the prep pack (may take a while with AI); returns the cheat sheet's id or null.
      const id = await makePrep(exam);
      // If it worked, show the new cheat sheet.
      if (id) { selectedId = id; editing = false; }
      draw();
    }));
    // "sort into course folders" button (only exists if there are sortable notes).
    $('#sort')?.addEventListener('click', () => {
      // Count how many notes we move.
      let moved = 0;
      // For every note not in a real course folder (and not a prep note), guess its course; if found, move it there.
      store.update((st) => st.notes.forEach((n) => { if (!known.has(n.courseId) && !n.prep) { const c = guessCourse(n, st.courses); if (c) { n.courseId = c.id; moved++; } } }));
      // Report, e.g. "moved 3 notes into course folders".
      toast(`moved ${moved} note${moved === 1 ? '' : 's'} into course folders`);
      draw();
    });
    // Search box: runs on every keystroke and hides notes (and folders) that don't match. No redraw needed.
    $('#search').oninput = (e) => {
      // What was typed, lowercase.
      const q = e.target.value.toLowerCase();
      // For each folder...
      el.querySelectorAll('.nfolder').forEach((f) => {
        // ...track whether any of its notes match.
        let any = false;
        f.querySelectorAll('.note-item').forEach((n) => {
          // The note object behind this list item.
          const nt = s.notes.find((x) => x.id === n.dataset.id);
          // Match if the search is empty, or the title+body contains the text.
          const hit = !q || (nt.title + nt.body).toLowerCase().includes(q);
          // Show ('' = default display) or hide ('none').
          n.style.display = hit ? '' : 'none';
          // `||=`: becomes true once any note matched.
          any ||= hit;
        });
        // Hide the folder if searching and nothing in it matched.
        f.style.display = !q || any ? '' : 'none';
      });
    };
    // Everything below needs a selected note; stop here if there isn't one.
    if (!note) return;
    // save(patch): update the selected note in the store. Object.assign copies the fields of `patch`
    // (e.g. { title: 'New' }) and a fresh updatedAt onto the stored note object.
    const save = (patch) => store.update((st) => Object.assign(st.notes.find((x) => x.id === note.id), patch, { updatedAt: Date.now() }));
    // Folder dropdown changed: move the note, make sure the target folder is open, confirm with its name, redraw.
    $('#move').onchange = (e) => { save({ courseId: e.target.value }); collapsed.delete(e.target.value); toast(`moved to ${e.target.selectedOptions[0].textContent}`); draw(); };
    // Title changed (fires when you leave the box): save it (or "Untitled" if empty) and redraw.
    $('#title').onchange = (e) => { save({ title: e.target.value.trim() || 'Untitled' }); draw(); };
    // edit/done button.
    $('#edit').onclick = () => {
      // Leaving edit mode → save what's in the editor first.
      if (editing) save({ body: $('#body').value });
      // Flip between edit and view, redraw.
      editing = !editing; draw();
    };
    // Auto-save while typing ("debounce"): every keystroke cancels the previous timer and starts a new 400 ms one,
    // so we only save once you pause typing. The timer id is stored on the element itself as `_t`.
    $('#body')?.addEventListener('input', (e) => { clearTimeout($('#body')._t); $('#body')._t = setTimeout(() => save({ body: e.target.value }), 400); });
    // "quiz me": open the chat and ask it to quiz you on this note (askAbout is in chat.js).
    $('#quiz').onclick = () => askAbout(`Quiz me on my note "${note.title}". Ask one question at a time and wait for my answer.`);
    // "pdf": open a printable version (title as a heading, then the body).
    $('#pdf').onclick = () => printDoc(`## ${note.title}\n\n${note.body}`, note.title);
    // "remake" (prep notes only): rebuild the prep pack for this note's exam.
    $('#regen')?.addEventListener('click', async () => {
      // Find the exam this prep note was made for.
      const exam = store.get().events.find((e) => e.id === note.prep.examId);
      // The exam was deleted → explain and stop. (`return toast(...)` shows the message and exits.)
      if (!exam) return toast('that exam isn’t on your calendar anymore');
      // Disable the button and show progress.
      $('#regen').disabled = true; $('#regen').textContent = 'remaking…';
      editing = false;
      // Rebuild, replacing the old prep notes. Returns the new cheat sheet's id.
      const id = await makePrep(exam, { replace: true });
      // Select the new version of the same kind: if we were looking at the practice test, find the new practice note
      // for this exam (falling back to the cheat sheet id); otherwise select the new cheat sheet.
      if (id) selectedId = note.prep.kind === 'practice' ? store.get().notes.find((n) => n.prep?.examId === exam.id && n.prep.kind === 'practice')?.id || id : id;
      draw();
    });
    // "delete" button.
    $('#del').onclick = () => {
      // Keep a copy (spread `{ ...note }` copies its fields) so we can undo.
      const snap = { ...note };
      // Remove the note from the store.
      store.update((st) => (st.notes = st.notes.filter((x) => x.id !== note.id)));
      selectedId = null; draw();
      // Show "note deleted" with an "undo" button that puts the copy back and selects it again.
      toast('note deleted', { action: 'undo', onAction: () => { store.update((st) => st.notes.push(snap)); selectedId = snap.id; draw(); } });
    };
  };

  /*
   * openGenerator(folderId) — opens the "generate notes" dialog.
   * Input: the folder (course id) to pre-select. Returns nothing.
   * The dialog lets you upload/paste material, choose title, folder and style, then generates and saves a note.
   */
  function openGenerator(folderId) {
    const courses = store.get().courses;
    // modal(title, html, options) shows a pop-up. The HTML template contains:
    //  - a drop zone label (#g-drop) wrapping a hidden file input (#g-file) that accepts our supported types and multiple files;
    //  - a big textarea (#g-text) for pasted text;
    //  - a title input (#g-title) and a folder dropdown (#g-course) with "general" plus every course (the given folder pre-selected);
    //  - style buttons (#g-style), one per STYLES entry; Object.entries gives [key, label] pairs, the first button starts "on";
    //  - a line saying which AI model writes it (#g-picker) and "can take 10–30s", or an offline-mode note; and the "generate" button (#g-go);
    //  - a status area (#g-status) for progress messages.
    modal('generate notes', `
      <label class="drop" id="g-drop" style="padding:18px"><input type="file" id="g-file" accept="${ACCEPT}" multiple hidden><b>upload slides, readings or photos</b><span class="muted small">pdf, powerpoint, word, photos of the whiteboard… · or paste below (screenshots too)</span></label>
      <textarea id="g-text" placeholder="Paste lecture transcript, slides text, or reading…" style="min-height:180px"></textarea>
      <div class="row">
        <label class="field">Title<input id="g-title" placeholder="e.g. Lecture 5: Memory"></label>
        <label class="field">folder<select id="g-course"><option value="">general</option>${courses.map((c) => `<option value="${c.id}" ${c.id === folderId ? 'selected' : ''}>${esc(c.code || c.name)}</option>`).join('')}</select></label>
      </div>
      <div class="row spread">
        <div class="seg" id="g-style">${Object.entries(STYLES).map(([k, v], i) => `<button data-s="${k}" class="${i === 0 ? 'on' : ''}">${v}</button>`).join('')}</div>
      </div>
      <div class="row spread"><span class="small muted">${aiEnabled() ? `<span class="row" style="gap:8px">written by <span id="g-picker"></span> · can take 10–30s</span>` : 'Offline mode: extractive notes. Connect Kiro or an AI key for AI-written notes.'}</span><button class="btn" id="g-go">generate</button></div>
      <div id="g-status"></div>`, {
      // Use the wider dialog size.
      wide: true,
      // onMount runs once the dialog is on the page. `body` = the dialog's content element, `close` = function to close it.
      // (Writing `onMount(body, close) { ... }` inside an object is "method shorthand" for `onMount: function (body, close) { ... }`.)
      onMount(body, close) {
        // $(q): find an element inside the dialog.
        const $ = (q) => body.querySelector(q);
        // The chosen style; starts as the first one.
        let style = 'outline';
        // If the model-picker spot exists (AI on), put a compact picker there and keep its cleanup function;
        // otherwise use a do-nothing function `() => {}`.
        const unmount = body.querySelector('#g-picker') ? mountModelPicker(body.querySelector('#g-picker'), { compact: true }) : () => {};
        // When the dialog's fade animation ends and the dialog is no longer on the page (it was closed), clean up the picker.
        body.closest('.modal-backdrop')?.addEventListener('transitionend', () => { if (!document.body.contains(body)) unmount(); });
        // Style buttons: clicking one remembers its style and highlights only that button (toggle 'on' where x === b).
        body.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => { style = b.dataset.s; body.querySelectorAll('[data-s]').forEach((x) => x.classList.toggle('on', x === b)); }));
        // gStatus(m): show a spinner with message m in the status area (used as the progress callback).
        const gStatus = (m) => ($('#g-status').innerHTML = spinner(m));
        // loadFiles(files): read uploaded/dropped files into the textarea.
        const loadFiles = async (files) => {
          // No files → nothing to do. (`files?.length` is undefined if files is missing.)
          if (!files?.length) return;
          try {
            // Read all files into one text (with progress messages) and put it in the textarea.
            $('#g-text').value = await readFilesText(files, { onProgress: gStatus });
            // If no title typed yet, use the first file's name without its extension (/\.[^.]+$/ = a dot and the non-dot characters after it, at the end).
            if (!$('#g-title').value) $('#g-title').value = files[0].name.replace(/\.[^.]+$/, '');
            // Reading failed → show the error for 8 seconds.
          } catch (err) { toast(err.message, { timeout: 8000 }); }
          // Clear the progress spinner.
          $('#g-status').innerHTML = '';
        };
        // Files chosen with the file picker.
        $('#g-file').onchange = (e) => loadFiles(e.target.files);
        // The drop zone element.
        const gDrop = $('#g-drop');
        // While a file is dragged over: preventDefault (otherwise the browser would just open the file) and highlight the zone.
        ['dragenter', 'dragover'].forEach((ev) => gDrop.addEventListener(ev, (e) => { e.preventDefault(); gDrop.classList.add('over'); }));
        // When the drag leaves or the file is dropped: remove the highlight.
        ['dragleave', 'drop'].forEach((ev) => gDrop.addEventListener(ev, (e) => { e.preventDefault(); gDrop.classList.remove('over'); }));
        // On drop: read the dropped files.
        gDrop.addEventListener('drop', (e) => loadFiles(e.dataTransfer.files));
        // Allow pasting screenshots into the textarea (OCR'd into text): show progress, clear it when done, show errors as toasts.
        enableImagePaste($('#g-text'), { onProgress: gStatus, onDone: () => ($('#g-status').innerHTML = ''), onError: (e) => { $('#g-status').innerHTML = ''; toast(e.message); } });
        // The "generate" button.
        $('#g-go').onclick = async () => {
          // The source material.
          const text = $('#g-text').value.trim();
          // Too short to make useful notes → ask for more and stop.
          if (text.length < 80) return toast('Add a bit more source material (at least a paragraph)');
          // The typed title, or "Notes · <today's date>".
          const title = $('#g-title').value.trim() || `Notes · ${fmtDate(todayISO())}`;
          // Disable the button so it's not clicked twice, and show a spinner.
          $('#g-go').disabled = true;
          $('#g-status').innerHTML = spinner('Writing your notes…');
          // Will hold the generated markdown.
          let bodyMd;
          try {
            // With AI: wait for the AI's notes. Without: build offline notes instantly.
            bodyMd = aiEnabled() ? await generateAI(text, style, title) : generateLocal(text, style, title);
          } catch (err) {
            // AI failed → say so and fall back to the offline generator.
            toast(`AI failed (${err.message}), used offline generator`);
            bodyMd = generateLocal(text, style, title);
          }
          // The title is shown separately, so drop a leading "## Title" heading.
          // The regex /^#{1,3}\s+.*\n+/ matches a first line that is a #, ## or ### heading, plus the line breaks after it.
          // The function decides: if that heading contains the first 12 characters of the title, remove it (''); otherwise keep it.
          bodyMd = bodyMd.trim().replace(/^#{1,3}\s+.*\n+/, (line) => (line.toLowerCase().includes(title.toLowerCase().slice(0, 12)) ? '' : line));
          // New note id.
          const id = uid();
          // Save the new note in the chosen folder. We also keep the first 20000 characters of the source
          // (exam prep uses it later as extra material).
          store.update((st) => st.notes.push({ id, title, courseId: $('#g-course').value, body: bodyMd.trim(), source: text.slice(0, 20000), createdAt: Date.now(), updatedAt: Date.now() }));
          // Select the new note in view mode and make sure its folder is open.
          selectedId = id; editing = false; collapsed.delete($('#g-course').value);
          // Close the dialog and redraw the page.
          close(); draw();
          toast('notes ready');
        };
      },
    });
  }

  // Draw the page for the first time.
  draw();
}
