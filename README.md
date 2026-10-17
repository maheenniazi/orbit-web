# 🪐 orbit (web)

**A student workspace that organizes itself.** Drop in a syllabus and orbit fills your calendar, schedules study sessions before every exam, and moves into stricter focus modes as exams get closer. It also writes your notes, plans your degree and helps you find a co-op.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)
![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-F7DF1E?logo=javascript&logoColor=black)
![No dependencies](https://img.shields.io/badge/npm%20install-not%20needed-brightgreen)
![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white)
![GitHub Pages](https://img.shields.io/badge/hosted%20on-GitHub%20Pages-222?logo=github)

### 🌐 **[Open orbit →](https://maheenniazi.github.io/orbit-web/)**

This is the **hosted edition** of orbit: a static site on GitHub Pages that you can install as an app (PWA) and use offline. Nothing to install, and AI works with your own key. The local-first original lives at **[orbit](https://github.com/maheenniazi/orbit)**.

---

## ✨ What it does

| | |
|---|---|
| 📄 **Syllabus import** | Drop in almost any file (PDF, Word, slides, spreadsheets, photos and screenshots via OCR) and exams, deadlines, readings and labs go straight onto your calendar. You can undo an import. |
| 📆 **Auto study plans** | Every exam gets 6 study sessions scheduled 10, 7, 5, 3, 2 and 1 days before it, each with its own goal. |
| 🌗 **Focus phases** | *drift → rising (14 days) → gravity (7) → eclipse (3) → liftoff (exam day)*. Each phase changes the accent colour, the pomodoro length and the playlist. |
| 🗓️ **Calendar** | Month view, a colour per course, filters, quick add (`bio quiz fri 2pm`) and `.ics` export to Google or Apple Calendar. |
| 💬 **Ask** | A chat assistant that knows your schedule and notes. It can explain topics, quiz you and add events. |
| 📝 **Notes generator** | Turns lecture text into an outline, Cornell notes, a summary or flashcards. It also builds a **cheat sheet** and a **practice test** before each exam. |
| 🎓 **Degree planner** | Tracks credits, GPA and your graduation pace, and checks your courses against your program's real requirements. |
| 💼 **Careers** | Canada-first internship and co-op search, AI-tailored resumes and cover letters, and an application tracker. |
| 🎧 **Spotify** | A sidebar player that keeps playing across pages, with a playlist for each focus mode. |
| 🧩 **Custom home** | Drag, resize and hide the cards on your dashboard. |

All your data stays in your browser (localStorage), and you can export or import a backup in Settings.

## 🚀 Two ways to run it

Same app either way. The only difference is where the AI and job search run.

### 1. In the browser (no install)

Open **[maheenniazi.github.io/orbit-web](https://maheenniazi.github.io/orbit-web/)**.

- **🔑 AI = bring your own key.** In **Settings → Integrations**, paste an **Anthropic (Claude)** or **Google Gemini** key. Both work directly from the browser. **OpenAI** blocks direct browser calls, so it needs a CORS-friendly proxy URL (there's a field for it). Keys are stored **only in your browser** and sent straight to the provider, never to an orbit server. Use a key with a low spending limit.
- **💼 Job search is free and needs no key.** The site searches Arbeitnow and Remotive directly from the browser, which is good for remote and worldwide roles. The Canada-heavy search (Google Jobs, Adzuna, Jooble) needs the local mode below.
- **📲 Install it like an app.** In Chrome or Safari, choose *Install* / *Add to Home Screen*. It opens in its own window and works offline.
- Kiro needs local mode, because a website can't run the Kiro CLI.

### 2. Locally (full power)

```bash
git clone https://github.com/maheenniazi/orbit-web.git
cd orbit-web
cp .env.example .env   # optional: add API keys
node server.js         # Node 18+, no npm install needed
```

Open **http://127.0.0.1:3000**. Use `127.0.0.1` rather than `localhost`, because Spotify requires it. Local mode adds Kiro, the full Google Jobs / Adzuna / Jooble search, reading program and job pages from a link, Spotify account connect, and old-format file conversion on macOS. Keys live in `.env` instead of the browser:

| `.env` key | Unlocks |
|---|---|
| `KIRO_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | AI syllabus parsing, the chat assistant, AI notes, resume tailoring |
| `SERPAPI_KEY`, `ADZUNA_APP_ID` + `ADZUNA_APP_KEY`, `JOOBLE_API_KEY` | Whole-web job search (Google Jobs, Adzuna, Jooble), all free to start |
| `SPOTIFY_CLIENT_ID` | Spotify account connect: now playing, playback controls, your own playlists |

With no keys at all, the calendar, study plans, focus modes and the offline date parser still work.

### 🛰️ Deploying your own copy

`.github/workflows/deploy-pages.yml` publishes `public/` to GitHub Pages on every push to `main`. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Your copy goes live at `https://<your-username>.github.io/<repo>/`.

**Custom domain (optional):** add a `public/CNAME` file containing your domain, point the domain's DNS at GitHub Pages, and set it under Settings → Pages. All asset paths are relative, so nothing else changes.

---

## 📖 Details

<details>
<summary><b>🤖 Choosing an AI model</b></summary>

Every provider you add to `.env` is available at the same time. The **model picker** (in *ask*, Settings and the notes generator) fetches the live model list from each provider, grouped and searchable. Your choice is saved in the browser and used everywhere, and each chat reply shows which model wrote it.

- `AI_MODEL=provider:model` sets the default for new browsers (e.g. `gemini:gemini-2.5-pro`).
- `OPENAI_BASE_URL` points the OpenAI provider at any compatible service, such as OpenRouter, Ollama or LM Studio.

</details>

<details>
<summary><b>🟣 Using Kiro as the AI (local mode)</b></summary>

orbit can run all of its AI through your Kiro subscription using [Kiro CLI headless mode](https://kiro.dev/docs/cli/headless/).

1. Install Kiro CLI: `curl -fsSL https://cli.kiro.dev/install | bash` (macOS/Linux; Windows users can install from PowerShell, see kiro.dev/cli).
2. Generate an API key in your Kiro account settings (Pro, Pro+ and Power plans).
3. Put `KIRO_API_KEY=ksk_...` in `.env` and restart. The startup log should show `AI: kiro`.

No key? Run `kiro-cli login` once and set `AI_PROVIDER=kiro`. If `kiro-cli` isn't on your PATH, set `KIRO_CLI_PATH`.

Kiro runs as the `study-os` agent in `kiro-agent/`, which has **no tools**: it can only reply with text and can't run commands or touch your files. The model list comes from `kiro-cli chat --list-models`. Kiro CLI has no per-run model flag, so orbit creates a text-only copy of the agent pinned to the model you picked (`kiro-agent/.kiro/agents/study-os-m-*.json`). Each request uses Kiro credits, and replies take a few seconds longer than a direct API call because the CLI starts up each time.

</details>

<details>
<summary><b>🎧 Spotify setup (local mode)</b></summary>

Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), add the redirect URI `http://127.0.0.1:3000/callback`, and copy the Client ID into `.env`. The OAuth flow uses PKCE, so you don't need a client secret. Remote playback control needs Spotify Premium. The embedded player works without any of this.

</details>

<details>
<summary><b>📄 Syllabus import and file support</b></summary>

Accepted files: PDF (scanned too), Word (.docx, and .doc on Mac), PowerPoint, Excel, OpenDocument, RTF, HTML, CSV, text, photos and screenshots (PNG, JPG, HEIC…, read with OCR), and Pages/Keynote files that include a preview. You can drop several files at once or paste a screenshot. The same file support works for notes and resumes.

Without an AI key, a built-in date parser handles formats like `Oct 14`, `10/14`, `14th November` and `2026-10-14`, and picks up times.

Everything is read in your browser, with two exceptions that use built-in macOS tools: `textutil` for old `.doc` files and `sips` for HEIC/TIFF photos. pdf.js and Tesseract (OCR) load from a CDN the first time you use them, so that step needs internet.

</details>

<details>
<summary><b>📝 Notes, cheat sheets and practice tests</b></summary>

Notes are editable Markdown with a "Quiz me" button, organized into a folder for each course (plus "general"). You can move notes between folders or sort the general ones automatically. A few days before each exam (5 by default, set in Settings), orbit turns that course's notes into a **cheat sheet** and a **practice test with an answer key**. You can also make one any time from the folder or the focus page.

</details>

<details>
<summary><b>🎓 Degree planner</b></summary>

- A folder for each school year with your courses (code, credits, grade and status: done, in progress, planned, failed or dropped).
- Totals for credits earned, in progress, planned and still needed, plus your average, approximate 4.0 GPA and an estimated finish date based on your pace.
- **Import a transcript** (PDF or screenshot) to build the folders automatically.
- **Requirement checking:** give it your university, program and the links to your program's academic calendar pages. It reads the requirements and checks each one against your courses: specific courses (with "or" options), "X credits from a list / 300-level" rules and total credits, plus things you tick off yourself like GPA or breadth. If the program has more than one stream (e.g. UTM CS CMP1 vs. regular), it asks which one you're in, plus follow-up questions like co-op.
- Credit systems for most Canadian universities are built in (e.g. U of T 0.5 per half-course / 20.0 total, UBC 3 / 120).

Calendar pages that load with JavaScript can't be read from a link, so save them as a PDF and upload that instead. This is a planning aid, not an official degree audit.

</details>

<details>
<summary><b>💼 Careers</b></summary>

- **Profile:** your default resume (PDF or paste) plus your major, grad date, target roles, skills and work authorization. AI can fill these in from your resume.
- **Find (Canada-first):** type something like *"summer 2027 co-op in toronto or remote"* and it becomes filters (type, term, location, region, field, posted date, work authorization). Listings come from community-run Canadian internship and co-op lists, [SimplifyJobs Summer 2027](https://github.com/SimplifyJobs/Summer2027-Internships) and [New Grad](https://github.com/SimplifyJobs/New-Grad-Positions) lists, and any Greenhouse, Lever or Ashby board you add (the defaults are Cohere, Ada, Faire and U of T PEY). US roles that don't sponsor visas are hidden unless you're also a US citizen or green card holder. Results are ranked by fit, and AI can re-rank the top 30.
- **Whole-web search:** with `SERPAPI_KEY` (Google Jobs, covering LinkedIn, Indeed, Glassdoor and company sites; 250 free searches a month), Adzuna or Jooble keys, results from every source are merged, de-duplicated (keeping the company's own apply link) and cached for 3 hours.
- **Tailor:** paste a job link or description and get a resume, CV or cover letter built only from your real experience, following Canadian conventions (Canadian spelling, no photo, age or SIN, French if the posting is in French), plus notes on missing keywords. "Save as pdf" opens a clean print layout.
- **Tracker:** saved → applied → interview → offer / rejected, with deadlines and follow-ups on your calendar.

</details>

---

## 🗂️ Code map

```
server.js              static server + /api/ai proxy + /api/status   (local mode)
jobs.js, websearch.js  job search: feeds, company boards, Google Jobs / Adzuna / Jooble
pages.js               reads public web pages (program requirements, job postings) into text
ai-providers.js        Anthropic / OpenAI / Gemini / Kiro adapters + live model lists
public/
  index.html, styles.css
  manifest.webmanifest, sw.js, icons/   PWA: install + offline
  js/ai.js             picks local-server mode or bring-your-own-key website mode
  js/byoai.js          browser-direct AI calls (Anthropic / Gemini / OpenAI) for website mode
  js/webjobs.js        free, no-key job search (Arbeitnow / Remotive) for website mode
  js/app.js            router, theme, focus palette, sidebar widgets
  js/fileread.js       reads PDF, Office, images (OCR) and more into text
  js/syllabus.js       offline parser, AI parser, quick-add parser, import view
  js/focus.js          focus phases, study-plan generator, pomodoro
  js/degree.js         degree planner UI   ·   js/degree-engine.js  credit/requirement math (no DOM)
  js/careers.js        profile, find, tailor, tracker
  js/calendar.js  chat.js  notes.js  examprep.js  dashboard.js  settings.js  spotify.js
  js/store.js          localStorage state + pub/sub   ·   js/util.js  helpers + markdown
kiro-agent/            the tool-less "study-os" Kiro agent
.github/workflows/deploy-pages.yml   auto-deploys public/ to GitHub Pages
```

**Make it yours:** rename the app with `APP_NAME` in `public/js/util.js`. The look (paper and night themes, fonts, accent colours) comes from the CSS variables at the top of `public/styles.css`.
