/*
 * chat.js — the "ask" page: a chat with an AI study assistant.
 *
 * What makes it useful is that every question is sent together with a "context block":
 * a plain-text summary of the student's own data (today's date, upcoming calendar events,
 * courses, note titles, focus mode, job applications, degree progress). The AI reads that
 * summary as part of its instructions (the "system prompt"), so it can answer
 * "what's due this week?" about YOUR calendar instead of guessing.
 *
 * The AI can also add events: we ask it to write a special line like
 * <<ADD_EVENT {...json...}>>; applyActions() finds those lines, adds the events to the calendar,
 * and removes the lines before showing the reply.
 *
 * With no AI key ("offline mode"), localAnswer() answers simple schedule questions itself.
 * Chat history is saved in the store (store.js), so it survives page reloads.
 */
// "Ask" chat: AI assistant grounded in your calendar + notes. Can add events. Offline fallback answers schedule questions.
// `import { a, b } from './file.js'` pulls in functions that another file exported.
// store = the app's saved data; addEvents = add calendar events; getCourse = look up a course by id.
import { store, addEvents, getCourse } from './store.js';
// AI helpers: is AI set up? / send a prompt / which model answered last / a model's display name / fetch the model list.
import { aiEnabled, ask, lastUsedModel, modelInfo, loadModels } from './ai.js';
// The little dropdown for choosing which AI model to use.
import { mountModelPicker } from './modelpicker.js';
// degreeContext() returns a text summary of the student's degree progress (for the AI's context).
import { degreeContext } from './degree.js';
// Small shared helpers: esc = make text safe to put in HTML, md = render markdown as HTML, date helpers, event type info.
import { esc, md, todayISO, addDays, fmtDate, fmtTime, TYPE_META, EXAM_TYPES, daysUntil } from './util.js';
// spinner = "thinking…" dots HTML; toast = little pop-up message at the bottom of the screen.
import { spinner, toast } from './ui.js';
// getFocusState = current focus mode and next exam; syncStudyPlans = auto-create study sessions before exams.
import { getFocusState, syncStudyPlans } from './focus.js';

// Name of the sessionStorage slot used to pass a question from another page into the chat box.
const PREFILL_KEY = 'studyos:chat-prefill';
/*
 * askAbout(text) — used by other pages (e.g. the notes "quiz me" button) to open the chat
 * with a question already typed and sent.
 * Input: the question text. Returns nothing.
 */
export function askAbout(text) {
  // sessionStorage = small storage that lasts until the tab is closed. Save the question there...
  sessionStorage.setItem(PREFILL_KEY, text);
  // ...then switch to the chat page (the app picks the page from the part of the URL after #).
  location.hash = '#/chat';
}

/*
 * contextBlock(question) — builds the plain-text summary of the student's data that is sent to the AI
 * with every question, so the AI "knows" the calendar, courses and notes.
 * Input: the student's question (used to spot note titles they mention).
 * Returns: a multi-line string.
 */
function contextBlock(question) {
  // All saved data (courses, events, notes, careers...).
  const s = store.get();
  // Today's date as "YYYY-MM-DD".
  const today = todayISO();
  // Only look 45 days ahead, to keep the prompt short.
  const horizon = addDays(today, 45);
  // Upcoming events as text lines:
  const upcoming = s.events
    // keep events from 3 days ago up to the horizon (ISO date strings sort correctly as text, so >= and <= work)
    .filter((e) => e.date >= addDays(today, -3) && e.date <= horizon)
    // sort by date; localeCompare compares two strings and returns negative/0/positive
    .sort((a, b) => a.date.localeCompare(b.date))
    // at most 80 events
    .slice(0, 80)
    // turn each event into one line: "- 2025-09-04 14:00 | Exam | PSY100 | Midterm (done) | notes"
    // The template literal (backticks) uses ${...} to insert values. Each optional part uses `cond ? text : ''`.
    // TYPE_META[e.type]?.label = the readable type name; `?.` avoids a crash if the type is unknown.
    // getCourse(...)?.code || ...?.name || '-' = the course code, else its name, else a dash.
    .map((e) => `- ${e.date}${e.time ? ' ' + e.time : ''} | ${TYPE_META[e.type]?.label} | ${getCourse(e.courseId)?.code || getCourse(e.courseId)?.name || '-'} | ${e.title}${e.done ? ' (done)' : ''}${e.notes ? ' | ' + e.notes : ''}`)
    // one event per line
    .join('\n');
  // Lowercase question, for case-insensitive matching.
  const q = question.toLowerCase();
  // Notes whose title appears in the question (max 2) — we'll include their full text so the AI can use them.
  const mentioned = s.notes.filter((n) => n.title && q.includes(n.title.toLowerCase())).slice(0, 2);
  // Titles (and course codes) of up to 40 notes, one per line, so the AI knows what notes exist.
  const noteList = s.notes.slice(0, 40).map((n) => `- ${n.title} (${getCourse(n.courseId)?.code || 'general'})`).join('\n');
  // Current focus mode (e.g. "exam crunch") and the next exam.
  const f = getFocusState();
  // Career data, or an empty object if there is none (so c.saved below doesn't crash).
  const c = s.careers || {};
  // If any job/internship applications are saved, list up to 25 as "- company | role | status | deadline".
  // Otherwise use an empty string so nothing is added.
  const careerLine = (c.saved || []).length
    ? `\nJob/internship applications being tracked:\n${c.saved.slice(0, 25).map((a) => `- ${a.company} | ${a.title} | ${a.status}${a.deadline ? ' | deadline ' + a.deadline : ''}`).join('\n')}`
    : '';
  // If the career profile has target roles, add a line with goals and skills ('-' if no skills given).
  const careerProfile = c.profile?.targetRoles ? `\nCareer goals: ${c.profile.targetRoles}. Skills: ${c.profile.skills || '-'}.` : '';
  // Put it all together. The template below produces, line by line:
  //  1. "Today is 2025-09-04 (Thursday)." + career profile + career list + degree summary (each may be empty)
  //  2. "Focus mode: <mode>" + (if there's a next exam) ', next exam "<title>" in N day(s)'
  //  3. "Courses: CODE Name; CODE Name" (or "none yet")
  //  4. "Upcoming events:" then the event lines (or "(none)")
  //  5. "Notes:" then the note titles (or "(none)")
  //  6. For each note mentioned in the question: a "--- Full note: Title ---" header and its first 8000 characters.
  // Note: inside the courses .map, `c` is a course (it temporarily hides the outer `c` = careers).
  return `Today is ${today} (${fmtDate(today, { weekday: 'long' })}).${careerProfile}${careerLine}${degreeContext()}
Focus mode: ${f.mode.label}${f.exam ? `, next exam "${f.exam.title}" in ${f.days} day(s)` : ''}.
Courses: ${s.courses.map((c) => `${c.code || ''} ${c.name}`.trim()).join('; ') || 'none yet'}
Upcoming events:
${upcoming || '(none)'}
Notes:
${noteList || '(none)'}
${mentioned.map((n) => `\n--- Full note: ${n.title} ---\n${n.body.slice(0, 8000)}`).join('\n')}`;
}

// SYSTEM = the AI's standing instructions (the "system prompt"). In plain words it says:
//  - you're a warm, sharp study assistant inside a student app;
//  - answer about their schedule/courses/notes, explain concepts, make study plans, quiz one question at a time;
//  - be concise and use markdown;
//  - to add an event, write one line per event in the exact <<ADD_EVENT {json}>> format shown,
//    with title, type (one of the listed types), date (YYYY-MM-DD) and time (HH:MM or empty);
//  - confirm in plain words, and never write ADD_EVENT unless the student asked to add something.
// The student's context block is appended to this later, in send().
const SYSTEM = `You are a warm, sharp study assistant inside a student's productivity app.
Answer questions about their schedule, courses and notes, explain concepts clearly, make study plans, and quiz them when asked (one question at a time, then give feedback).
Be concise and use markdown (short paragraphs, bullet lists, **bold** key terms).
If the user asks you to add/schedule something, include one line per event exactly like:
<<ADD_EVENT {"title":"...","type":"assignment|exam|midterm|final|quiz|project|reading|lab|study|class|other","date":"YYYY-MM-DD","time":"HH:MM or empty"}>>
and confirm in plain words. Never output ADD_EVENT unless asked to add something.`;

/*
 * applyActions(text) — looks for <<ADD_EVENT {...}>> commands in the AI's reply, adds those events
 * to the calendar, and removes the commands from the text.
 * Input: the AI's raw reply. Returns: the cleaned-up reply to show the student.
 */
function applyActions(text) {
  // Events we'll add.
  const added = [];
  // The regex matches: "<<ADD_EVENT", optional spaces (\s*), then a { ... } JSON object (captured in group 1),
  // optional spaces, then ">>". [\s\S]*? = any characters including newlines, as few as possible (so it stops at the first "}>>").
  // The g flag handles every command in the reply. For each match, the arrow function runs and its return value ('')
  // replaces the match — i.e. the command is deleted from the text. `_` is the whole match (unused), `json` is group 1.
  const cleaned = text.replace(/<<ADD_EVENT\s*(\{[\s\S]*?\})\s*>>/g, (_, json) => {
    try {
      // Turn the JSON text into an object.
      const e = JSON.parse(json);
      // Only accept it if the date looks like YYYY-MM-DD (^ start, \d{4} four digits, -, \d{2}, -, \d{2}, $ end).
      // Then add a clean event: default title, type only if it's a known type (else 'other'), time or '', and mark it as from the chat.
      if (/^\d{4}-\d{2}-\d{2}$/.test(e.date)) added.push({ title: e.title || 'Untitled', type: TYPE_META[e.type] ? e.type : 'other', date: e.date, time: e.time || '', source: 'chat' });
      // `catch {` with no variable: if the JSON is broken, just skip this command.
    } catch { /* ignore */ }
    // Replace the command with nothing.
    return '';
  });
  // If we found any events...
  if (added.length) {
    // ...save them to the calendar,
    addEvents(added);
    // if any is an exam type, create study sessions before it (.some = "is at least one item true?"),
    if (added.some((e) => EXAM_TYPES.includes(e.type))) syncStudyPlans();
    // and show a pop-up like "Added 2 events to your calendar" (adds "s" only when more than 1).
    toast(`Added ${added.length} event${added.length > 1 ? 's' : ''} to your calendar`);
  }
  // Return the reply without the commands, trimmed.
  return cleaned.trim();
}

// Offline: answer the most common schedule questions from local data.
/*
 * localAnswer(q) — a simple rule-based "assistant" used when there's no AI (or the AI fails).
 * It checks the question for keywords (exam, today, tomorrow, next week, due...) and lists matching events.
 * Input: the question. Returns: a markdown answer string.
 */
function localAnswer(q) {
  const s = store.get();
  // Lowercase question for keyword checks.
  const t = q.toLowerCase();
  const today = todayISO();
  // list(evs) turns events into markdown bullet lines: "- **Title**: Thu, Sep 4 2pm (PSY100)".
  // If the list is empty, it returns "- Nothing found". The course part only appears if the event has a course.
  const list = (evs) => evs.length
    ? evs.map((e) => `- **${e.title}**: ${fmtDate(e.date)}${e.time ? ' ' + fmtTime(e.time) : ''} ${getCourse(e.courseId) ? `(${getCourse(e.courseId).code || getCourse(e.courseId).name})` : ''}`).join('\n')
    : '- Nothing found';
  // A copy of all events ([...array] = spread into a new array, so sorting doesn't reorder the saved list),
  // without finished ones, sorted by date.
  const sorted = [...s.events].filter((e) => !e.done).sort((a, b) => a.date.localeCompare(b.date));
  // Question mentions exam/midterm/final/test?
  if (/exam|midterm|final|test/.test(t)) {
    // Upcoming exam-type events from today on.
    const ex = sorted.filter((e) => EXAM_TYPES.includes(e.type) && e.date >= today);
    // List them, and if there's at least one (ex[0] exists), say how many days until the next.
    return `Your upcoming exams:\n${list(ex)}${ex[0] ? `\n\nThe next one is **${daysUntil(ex[0].date)} days** away.` : ''}`;
  }
  // range = [start date, end date, words to describe it], or null if the question isn't about a time range.
  let range = null;
  // "today"
  if (/today/.test(t)) range = [today, today, 'today'];
  // "tomorrow"
  else if (/tomorrow/.test(t)) range = [addDays(today, 1), addDays(today, 1), 'tomorrow'];
  // "next week" = 7 to 13 days from now
  else if (/next week/.test(t)) range = [addDays(today, 7), addDays(today, 13), 'next week'];
  // general "week/due/deadline/upcoming/soon" = the next 7 days (today + 6)
  else if (/week|due|deadline|upcoming|soon/.test(t)) range = [today, addDays(today, 6), 'in the next 7 days'];
  if (range) {
    // Events within the range, leaving out regular classes.
    const evs = sorted.filter((e) => e.date >= range[0] && e.date <= range[1] && e.type !== 'class');
    return `Here's what's on ${range[2]}:\n${list(evs)}`;
  }
  // Didn't understand → explain offline mode and how to connect an AI key (in the .env settings file).
  return `I'm in **offline mode**, so I can answer schedule questions like *“what's due this week?”* or *“when are my exams?”*.\n\nAdd \`KIRO_API_KEY\` (or an Anthropic/OpenAI key) to \`.env\` to unlock full answers, explanations, and quizzes.`;
}

/*
 * render(el) — draws the chat page inside the element `el` and wires up its buttons.
 * Called by app.js when you go to #/chat.
 * Returns: a cleanup function (removes the model picker) that app.js runs when you leave the page.
 */
export function render(el) {
  const s = store.get();
  // Page HTML (a template literal). It contains:
  //  - a header: "ask · connected/offline", the title "ask orbit", and a description that depends on aiEnabled(),
  //    plus a spot for the model picker (#picker) and a "clear chat" button;
  //  - a chat card: the message log (#log) and an input row with a textarea (#in) and a "send" button.
  el.innerHTML = `
    <div class="page-head view-enter">
      <div><div class="kicker">ask · ${aiEnabled() ? 'connected' : 'offline'}</div><h1>ask <em>orbit</em></h1><p>${aiEnabled() ? 'Knows your calendar, courses and notes. Ask it to explain, plan, quiz you, or add events.' : 'Offline mode: schedule questions only. Connect Kiro (or another AI key) for the full assistant.'}</p></div>
      <div class="row"><div id="picker"></div><button class="btn ghost sm" id="clear">clear chat</button></div>
    </div>
    <div class="card chat view-enter">
      <div class="chat-log" id="log"></div>
      <div class="chat-input">
        <textarea id="in" rows="1" placeholder="what’s due this week? · quiz me on my notes · explain mitosis like i’m 5"></textarea>
        <button class="btn" id="send">send</button>
      </div>
    </div>`;
  // Grab the message log and the text box we just created.
  const log = el.querySelector('#log');
  const input = el.querySelector('#in');

  // drawLog() re-draws all chat messages (or the welcome screen if there are none).
  const drawLog = () => {
    // Saved messages: [{ role: 'user' | 'assistant', content, model?, ts }].
    const msgs = store.get().chat;
    // No messages yet → show a welcome message with clickable example questions.
    if (!msgs.length) {
      // The template shows "ask me anything." and a row of suggestion buttons; each button stores its question
      // in a data-q attribute (esc() makes the text safe inside HTML).
      log.innerHTML = `<div class="empty" style="margin:auto"><span class="big">ask me anything.</span>your schedule, your notes, or that one concept you still don’t get
        <div class="suggestions">${["what's due this week?", 'when is my next exam?', 'make me a study plan for my next exam', 'add: essay draft due friday'].map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
      // Clicking a suggestion puts its question in the box and sends it.
      // (`send` is defined further down; that's fine because the click happens later, after it exists.)
      log.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => { input.value = b.dataset.q; send(); }));
      return;
    }
    // Turn each message into HTML:
    //  - assistant messages: markdown rendered with md(), plus (if known) the AI model's name underneath;
    //  - user messages: escaped text with line breaks (\n) turned into <br>.
    log.innerHTML = msgs.map((m) => m.role === 'assistant'
      ? `<div class="msg assistant">${md(m.content)}${m.model ? `<div class="msg-model">${esc(modelInfo(m.model).label)}</div>` : ''}</div>`
      : `<div class="msg user">${esc(m.content).replace(/\n/g, '<br>')}</div>`).join('');
    // Scroll to the bottom so the newest message is visible.
    log.scrollTop = log.scrollHeight;
  };

  // true while waiting for an answer, so a second message can't be sent at the same time.
  let busy = false;
  /*
   * send() — sends whatever is in the text box: saves it, shows a "thinking" bubble, gets an answer
   * (from the AI, or offline), saves and shows the answer. Returns nothing (it's async).
   */
  async function send() {
    const text = input.value.trim();
    // Ignore empty messages, or if we're already waiting for a reply.
    if (!text || busy) return;
    busy = true;
    // Clear the box.
    input.value = '';
    // Save the student's message (with a timestamp) into the chat history.
    store.update((st) => st.chat.push({ role: 'user', content: text, ts: Date.now() }));
    // Show it.
    drawLog();
    // Add a temporary "thinking…" bubble at the end of the log.
    log.insertAdjacentHTML('beforeend', `<div class="msg assistant" id="pending">${spinner()}</div>`);
    log.scrollTop = log.scrollHeight;
    // Will hold the answer text.
    let reply;
    // Which model answered (null if offline).
    let usedModel = null;
    try {
      if (aiEnabled()) {
        // The last 16 messages, keeping only role and content. `({ role, content }) => ({ role, content })`
        // destructures each message and builds a smaller object (the extra ( ) around { } means "return this object").
        const history = store.get().chat.slice(-16).map(({ role, content }) => ({ role, content }));
        // Ask the AI. The system prompt = SYSTEM + a "# Student context" heading + the context block for this question.
        // That's how the AI learns about the calendar/notes. maxTokens limits the answer length.
        // Then applyActions() handles any ADD_EVENT commands in the reply.
        reply = applyActions(await ask({ system: `${SYSTEM}\n\n# Student context\n${contextBlock(text)}`, messages: history, maxTokens: 1500 }));
        // Remember which model replied, to show its name.
        usedModel = lastUsedModel();
        // No AI → use the offline rules.
      } else reply = localAnswer(text);
    } catch (e) {
      // The AI request failed → show the error message followed by the best offline answer.
      reply = `${e.message}\n\n${localAnswer(text)}`;
    }
    // Save the assistant's reply (or "Done" if it was empty, e.g. only an ADD_EVENT command).
    store.update((st) => st.chat.push({ role: 'assistant', content: reply || 'Done', model: usedModel, ts: Date.now() }));
    busy = false;
    // Redraw (this also removes the "thinking" bubble), and put the cursor back in the box.
    drawLog();
    input.focus();
  }

  // The send button sends.
  el.querySelector('#send').onclick = send;
  // Pressing Enter sends; Shift+Enter makes a new line instead. preventDefault stops Enter adding a line break.
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  // Auto-grow the text box as you type: reset its height, then set it to fit the content, up to 160 pixels.
  input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; };
  // "clear chat" empties the history and redraws.
  el.querySelector('#clear').onclick = () => { store.update((st) => (st.chat = [])); drawLog(); };

  // Draw the messages for the first time.
  drawLog();
  // Put the model picker in #picker; it gives back a function that removes it later.
  const unmountPicker = mountModelPicker(el.querySelector('#picker'));
  // Once the model list has loaded, redraw so model names show under past replies. (.then runs after the Promise finishes.)
  loadModels().then(drawLog); // model names for the labels under replies
  // Did another page leave a question for us (see askAbout above)?
  const pre = sessionStorage.getItem(PREFILL_KEY);
  // If so: remove it (so it's only used once), put it in the box and send it right away. Otherwise just focus the box.
  if (pre) { sessionStorage.removeItem(PREFILL_KEY); input.value = pre; send(); }
  else input.focus();
  // Hand the cleanup function to app.js.
  return unmountPicker;
}
