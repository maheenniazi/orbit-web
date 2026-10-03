/*
 * examprep.js — builds an "exam prep pack" for an upcoming exam: a cheat sheet + a practice test.
 *
 * How it fits in: the notes page (notes.js) shows a "make cheat sheet + practice test" button in each
 * course folder, and autoPrep() runs on its own a few days before each exam (prepDays, default 5).
 * The pack is made from that course's notes and saved as two new notes in the same folder.
 * Each prep note has a `prep` object ({ examId, kind: 'cheatsheet' | 'practice', by: 'ai' | 'offline', ... })
 * so the app can tell prep notes apart from the student's own notes.
 *
 * Two ways to build it:
 *  - aiPrep(): sends the notes to the AI with instructions to write both documents.
 *  - localPrep(): no AI — pulls out headings, ==highlighted== lines, **bold** terms, definitions and
 *    questions from the notes with regexes (text patterns).
 */
// Exam prep: a few days before each exam, turn that course's notes into a cheat sheet + practice test.
// store = saved app data; getCourse = find a course by id.
import { store, getCourse } from './store.js';
// aiEnabled = is an AI key set up?; ask = send a prompt to the AI and get its reply text.
import { aiEnabled, ask } from './ai.js';
// uid = make a random id; date helpers; EXAM_TYPES = ['exam', 'midterm', 'final'].
import { uid, todayISO, daysUntil, fmtDate, EXAM_TYPES } from './util.js';
// toast = small pop-up message.
import { toast } from './ui.js';

// IDs of exams whose prep is being built right now, so we never build the same one twice at once.
// A Set is a collection with no duplicates and a fast .has() check.
const running = new Set();

// How many days before an exam to auto-build prep. `??` means "if the setting is null/undefined, use 5".
// Number(...) makes sure it's a number. This is an arrow function: `() => value` returns value.
export const prepDays = () => Number(store.get().settings.prepDays ?? 5);
// The student's own notes for a course (prep notes are excluded with !n.prep).
export const courseNotes = (courseId) => store.get().notes.filter((n) => n.courseId === courseId && !n.prep);
// The prep notes already made for a given exam. `n.prep?.examId` uses optional chaining: if n.prep doesn't exist, it's undefined instead of crashing.
export const prepFor = (examId) => store.get().notes.filter((n) => n.prep?.examId === examId);

/*
 * upcomingExams(courseId) — list exams that haven't happened yet, soonest first.
 * Input: a course id (optional — leave it out to get exams for ALL courses).
 * Returns: an array of event objects.
 */
export function upcomingExams(courseId) {
  const today = todayISO();
  return store.get().events
    // Keep events that: are an exam type, are today or later (ISO date strings compare correctly as text),
    // aren't marked done, and belong to the course (or any course if none was given).
    .filter((e) => EXAM_TYPES.includes(e.type) && e.date >= today && !e.done && (!courseId || e.courseId === courseId))
    // Sort by date, earliest first (localeCompare returns negative/0/positive for string order).
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- offline builder (no AI): pulls the important bits out of the notes ----------
/*
 * localPrep(exam, notes) — builds a cheat sheet and practice test WITHOUT AI, by searching the notes' markdown.
 * Inputs: the exam event and an array of note objects.
 * Returns: { sheet, practice } — two markdown strings.
 */
function localPrep(exam, notes) {
  // Every line of every note, trimmed, as { l: lineText, note: noteTitle }.
  // flatMap = map, then flatten the resulting arrays of lines into one big array.
  const lines = notes.flatMap((n) => n.body.split('\n').map((l) => ({ l: l.trim(), note: n.title })));
  // strip(l) cleans a markdown line:
  //  /^[-*>\d.)\s]+/ removes leading bullet/quote/number characters (like "- ", "> ", "1. ", "2) ");
  //  /\[[ x]\]\s*/i removes a checkbox "[ ]" or "[x]" (i = also "[X]").
  const strip = (l) => l.replace(/^[-*>\d.)\s]+/, '').replace(/\[[ x]\]\s*/i, '').trim();
  // Bold terms: find every **term** (2 to 60 characters, no asterisks inside) in every note.
  // matchAll gives all matches; [...x] spreads them into an array; m[1] is the text between the **.
  // new Set(...) removes duplicates, [...Set] turns it back into an array, and we keep at most 30.
  const bold = [...new Set(notes.flatMap((n) => [...n.body.matchAll(/\*\*([^*]{2,60})\*\*/g)].map((m) => m[1].trim())))].slice(0, 30);
  // Highlighted lines: lines containing ==something== (the app's highlight syntax).
  // `({ l })` destructures each line object to get just its text. Then strip the line and remove the == marks.
  const marked = lines.filter(({ l }) => /==[^=]+==/.test(l)).map(({ l }) => strip(l).replace(/==/g, ''));
  // Definition lines: contain a whole word (\b = word boundary) like "is", "are", "refers to", "is defined as" or "means",
  // are shorter than 260 characters, and are bullet points (start with - or *). Keep at most 25.
  const defs = lines.filter(({ l }) => /\b(is|are|refers to|is defined as|means)\b/i.test(l) && l.length < 260 && /^[-*]/.test(l)).map(({ l }) => strip(l)).slice(0, 25);
  // Question lines: end with "?" (optionally followed by spaces) and are under 200 characters. Keep at most 20.
  const qs = lines.filter(({ l }) => /\?\s*$/.test(l) && l.length < 200).map(({ l }) => strip(l)).slice(0, 20);
  // Headings: lines starting with ##, ### or #### and a space. Remove the # marks,
  // then drop generic section names that the note generator itself adds (Key terms, Summary, ...).
  const heads = lines.filter(({ l }) => /^#{2,4}\s/.test(l)).map(({ l }) => l.replace(/^#+\s*/, '')).filter((h) => !/key terms|review questions|definitions|summary|topics|key points/i.test(h));
  // A bullet list of the note titles this sheet is built from.
  const byNote = notes.map((n) => `- **${n.title}**`).join('\n');
  // The cheat sheet, as a template literal (backticks, with ${...} inserting values). Section by section:
  //  - "### Covers" + the note titles
  //  - if the exam event has notes from the syllabus: an italic "From the syllabus:" line
  //  - if there are headings: "### Topics" with up to 20 unique headings as bullets
  //  - if there are highlighted lines: "### Most likely on the exam" with up to 15, kept highlighted (==...==)
  //  - if there are definitions: "### Definitions" bullets
  //  - if there are bold terms: "### Key terms" shown as `code` chips separated by " · "
  // Every optional section uses `condition ? text : ''`, so missing sections become empty lines (cleaned up below).
  const sheet = `### Covers
${byNote}
${exam.notes ? `\n*From the syllabus:* ${exam.notes}\n` : ''}
${heads.length ? `### Topics\n${[...new Set(heads)].slice(0, 20).map((h) => `- ${h}`).join('\n')}\n` : ''}
${marked.length ? `### Most likely on the exam\n${marked.slice(0, 15).map((m) => `- ==${m}==`).join('\n')}\n` : ''}
${defs.length ? `### Definitions\n${defs.map((d) => `- ${d}`).join('\n')}\n` : ''}
${bold.length ? `### Key terms\n${bold.map((b) => `\`${b}\``).join(' · ')}\n` : ''}`;
  // Make a "define this term" question for each of the first 10 bold terms.
  const termQs = bold.slice(0, 10).map((b) => `Define **${b}** and give an example.`);
  // The practice test:
  //  - "### Practice questions": the questions found in the notes followed by the term questions
  //    ([...qs, ...termQs] spreads both arrays into one), max 20, numbered "1. ", "2. "...
  //    If there are none (empty string), `||` uses a single fallback question instead.
  //  - "### Answer key": no real answers offline, so it lists the notes to check against.
  //  - a quote line suggesting connecting an AI for full answers.
  const practice = `### Practice questions
${[...qs, ...termQs].slice(0, 20).map((q, i) => `${i + 1}. ${q}`).join('\n') || '1. Summarize each topic above in two sentences without looking at your notes.'}

### Answer key
Check each answer against your notes:
${notes.map((n) => `- ${n.title}`).join('\n')}

> connect kiro or an ai key in .env to get full worked answers and exam-style questions.`;
  // Squash 3+ line breaks (left by empty sections) down to one blank line, and trim.
  return { sheet: sheet.replace(/\n{3,}/g, '\n\n').trim(), practice };
}

/*
 * aiPrep(exam, notes) — asks the AI to write the cheat sheet and practice test.
 * Inputs: the exam event and the course's notes. Returns (a Promise of) { sheet, practice }.
 * `async` means this function can `await` slow things (like the AI request) and returns a Promise.
 */
async function aiPrep(exam, notes) {
  // The course this exam belongs to (may be undefined).
  const course = getCourse(exam.courseId);
  // All notes as one big text: each note is "# Title", its body, and (if the note was generated from source
  // material) "(source excerpt)" + the first 4000 characters of that source. Notes are separated by "---" lines.
  // The whole thing is cut to 60000 characters so the request isn't too big.
  const material = notes.map((n) => `# ${n.title}\n${n.body}\n${n.source ? `\n(source excerpt)\n${n.source.slice(0, 4000)}` : ''}`).join('\n\n---\n\n').slice(0, 60000);
  // Send the request and wait for the reply text.
  // The system prompt (instructions) tells the AI, in plain words:
  //  - you're an expert tutor; use ONLY the student's notes; don't invent facts;
  //  - write two markdown documents separated by a line that says exactly ===PRACTICE===;
  //  - 1) a dense one-page CHEAT SHEET with topic headings, bullets, bold terms, exact formulas/definitions,
  //       ==highlights== on likely test facts, ending with "### Common mistakes";
  //  - 2) a PRACTICE TEST of about 15 questions (multiple choice, short answer, 2 longer ones), easy → hard,
  //       then an "### Answer key" with answers and short explanations;
  //  - don't start with a title.
  // The user message gives the course, the exam title and date, the syllabus notes for the exam (if any),
  // and then all the notes (`material`). maxTokens: 7000 allows a long answer.
  const reply = await ask({
    system: `You are an expert tutor preparing a student for an exam. Use ONLY the student's notes below. Do not invent facts that aren't in them.
Write two Markdown documents separated by a line containing exactly ===PRACTICE===
1) CHEAT SHEET: dense, one-page review. Sections with ### headings by topic; bullets; **bold** key terms; formulas/definitions verbatim from the notes; ==highlight== the facts most likely to be tested; end with "### Common mistakes".
2) PRACTICE TEST: ~15 exam-style questions mixing multiple choice (A–D), short answer, and 2 longer application questions, ordered easy → hard and grouped by topic. Then "### Answer key" with the correct answer and a 1–2 sentence explanation for each.
Don't start with a title heading.`,
    messages: [{ role: 'user', content: `Course: ${course?.code || ''} ${course?.name || ''}\nExam: ${exam.title} on ${exam.date}${exam.notes ? `\nSyllabus says it covers: ${exam.notes}` : ''}\n\nMy notes:\n${material}` }],
    maxTokens: 7000,
  });
  // Split the reply at the ===PRACTICE=== line. The regex matches a whole line (^ ... $) containing only
  // ===PRACTICE=== with optional spaces around it; the `m` flag makes ^ and $ work per line instead of for the whole text.
  // Destructuring: the first part goes in `sheet`, the second in `practice` (default '' if the AI forgot the separator).
  const [sheet, practice = ''] = reply.split(/^\s*===PRACTICE===\s*$/m);
  // Return both, trimmed. If the practice part is empty, use a placeholder explaining what happened.
  return { sheet: sheet.trim(), practice: practice.trim() || '### Practice questions\n(the ai didn’t return a practice test. try again)' };
}

// Make (or remake) the prep pack for one exam. Returns the cheat sheet note id.
/*
 * makePrep(exam, { replace, silent }) — builds and saves the cheat sheet + practice test notes for one exam.
 * Inputs:
 *   exam    — the exam event object
 *   replace — true to delete this exam's old prep notes first (the "remake" button)
 *   silent  — true to skip pop-up messages about problems (used by the automatic autoPrep)
 *   `{ replace = false, silent = false } = {}` destructures the options with default values; the whole object is optional.
 * Returns (a Promise of) the cheat sheet note's id, or null if nothing was made.
 */
export async function makePrep(exam, { replace = false, silent = false } = {}) {
  // Already building prep for this exam → do nothing.
  if (running.has(exam.id)) return null;
  // The course's notes (the raw material).
  const notes = courseNotes(exam.courseId);
  // No notes → can't build anything; tell the student (unless silent).
  if (!notes.length) {
    if (!silent) toast('add some notes to this course first, then it can build your prep');
    return null;
  }
  // Mark as "in progress".
  running.add(exam.id);
  // try/finally: the `finally` part always runs at the end, even if something throws — so the exam is always un-marked.
  try {
    // Will hold { sheet, practice }.
    let docs;
    // Who wrote it: 'offline' unless the AI succeeds.
    let by = 'offline';
    if (aiEnabled()) {
      // Try the AI; if it fails, show why (unless silent) and fall through to the offline version.
      try { docs = await aiPrep(exam, notes); by = 'ai'; } catch (e) { if (!silent) toast(`ai couldn’t make it (${e.message}), made a basic version`); }
    }
    // `||=` = "assign only if docs is still empty": use the offline builder if we have no AI result.
    docs ||= localPrep(exam, notes);
    // The exam date as short text, e.g. "Oct 14".
    const when = fmtDate(exam.date, { month: 'short', day: 'numeric' });
    // Fields both new notes share: same course folder as the exam, and creation/update times (Date.now() = milliseconds since 1970).
    const base = { courseId: exam.courseId, createdAt: Date.now(), updatedAt: Date.now() };
    // Make the cheat sheet's id now, because we return it and use it in the "open" button.
    const sheetId = uid();
    // Info saved on both notes: which exam, its date, who wrote it, and the ids of the notes it was built from.
    const prep = { examId: exam.id, examDate: exam.date, by, from: notes.map((n) => n.id) };
    // Save to the store (this also saves to the browser's storage and refreshes the screen).
    store.update((s) => {
      // Remaking → first remove the old prep notes for this exam.
      if (replace) s.notes = s.notes.filter((n) => n.prep?.examId !== exam.id);
      // Add both notes. `{ ...base, id: ... }` uses spread to copy base's fields into the new object, then adds more fields.
      // `{ ...prep, kind: 'cheatsheet' }` copies prep and adds which kind this note is.
      s.notes.push(
        // Cheat sheet: title "Cheat sheet · <exam>", body starts with an italic line like
        // "*for Midterm on Oct 14, built from 3 notes*" (adds "s" unless exactly 1), then a blank line and the sheet.
        { ...base, id: sheetId, title: `Cheat sheet · ${exam.title}`, body: `*for ${exam.title} on ${when}, built from ${notes.length} note${notes.length === 1 ? '' : 's'}*\n\n${docs.sheet}`, prep: { ...prep, kind: 'cheatsheet' } },
        // Practice test note with its own new id.
        { ...base, id: uid(), title: `Practice test · ${exam.title}`, body: docs.practice, prep: { ...prep, kind: 'practice' } },
      );
    });
    // Tell the student it's ready, with an "open" button that remembers which note to open
    // (notes.js reads 'studyos:open-note') and switches to the notes page. Shown for 9 seconds.
    toast(`exam prep ready for ${exam.title}`, { action: 'open', onAction: () => { sessionStorage.setItem('studyos:open-note', sheetId); location.hash = '#/notes'; } , timeout: 9000 });
    return sheetId;
  } finally {
    // Done (or failed) → no longer in progress.
    running.delete(exam.id);
  }
}

// Runs at startup and when you come back to the tab: build prep for exams that are N days out.
/*
 * autoPrep() — automatically builds prep packs for exams coming up within prepDays() days.
 * Input: none. Returns (a Promise of) nothing.
 */
export async function autoPrep() {
  const s = store.get();
  // The student turned this feature off in settings → stop.
  if (s.settings.autoPrep === false) return;
  // All upcoming exams (any course), soonest first.
  for (const ex of upcomingExams()) {
    // Days until this exam.
    const d = daysUntil(ex.date);
    // Too far away → stop the whole loop (exams are sorted, so every later one is even further away).
    if (d > prepDays() || d < 0) break;
    // Skip if prep already exists, or the course has no notes yet (`continue` jumps to the next exam).
    if (prepFor(ex.id).length || !courseNotes(ex.courseId).length) continue;
    // Build it quietly, one exam at a time (await waits for each to finish before the next).
    await makePrep(ex, { silent: true });
  }
}
