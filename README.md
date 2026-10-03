# orbit

A student workspace inspired by Notion that runs itself. Drop in a syllabus and the app fills your calendar, schedules study sessions before each exam, and switches into stricter focus modes as exams get closer.

> **This is the public, hosted edition of orbit** (the one that runs as a website on GitHub Pages, with "bring your own AI key" and free job search). It's deployed from this repo automatically. The full-power local version — with Kiro, the complete Canadian job search, and Spotify connect — is the same code run with `node server.js`.

## Two ways to run orbit

orbit works the same either way; the difference is only where the AI and job search run.

1. **As a website (no install, share a link).** orbit is a plain static site, so you can host it for free on GitHub Pages and open it on any device. There's no server, so:
   - **AI = bring your own key.** In **Settings → Integrations**, paste your own **Anthropic (Claude)** or **Google Gemini** key — these work straight from the browser. **OpenAI** needs a CORS-friendly proxy URL (OpenAI blocks direct browser calls), so there's a field for that. Keys are saved **only in your browser** and sent straight to the AI provider, never to any orbit server. Use a key with a low spending limit.
   - **Job search = free, no key.** The site searches free sources (Arbeitnow, Remotive) right from the browser — great for remote/worldwide roles. The richer, Canada-heavy search (Google Jobs/Adzuna/Jooble) needs the local app below.
   - **Install it like an app.** It's a PWA: open it in Chrome/Safari and choose *Install* / *Add to Home Screen*. It then opens in its own window and works offline (your data is already in the browser).
   - **Kiro** needs the local app (a website can't run the Kiro CLI).

2. **Locally with `node server.js` (full power).** This unlocks everything: Kiro, the full Google Jobs/Adzuna/Jooble search, reading program/job pages from a link, Spotify account connect, and old-format file conversion on macOS. Keys live in a `.env` file instead of the browser. See **Run it** below.

### Put the website online (GitHub Pages)

The repo includes `.github/workflows/deploy-pages.yml`. One-time setup: on GitHub go to **Settings → Pages → Build and deployment → Source: GitHub Actions**. After that, every push to `main` publishes the `public/` folder to `https://<your-username>.github.io/<repo>/` automatically.

**Custom domain (optional, later):** buy a domain, add a file named `CNAME` inside `public/` containing just your domain (e.g. `orbit.example.com`), point the domain's DNS at GitHub Pages, and set it under Settings → Pages. Nothing else changes — all asset paths are relative.

## Run it

```bash
cp .env.example .env   # optional, see below
node server.js         # Node 18+, no npm install needed
```
Open **http://127.0.0.1:3000**. Use `127.0.0.1` and not `localhost`, because Spotify requires it.

It has no dependencies and works offline. Adding keys turns on the smart features:

| `.env` key | Unlocks |
|---|---|
| `KIRO_API_KEY` **or** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | AI syllabus parsing, the full chat assistant, AI-written notes |
| `SPOTIFY_CLIENT_ID` | Account connect: now playing, playback controls, your own playlists |

### Choosing a model

Every provider you connect in `.env` is available at the same time: `KIRO_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `GEMINI_API_KEY`. The **model picker** in *ask* (also in Settings and the notes generator) lists every model your keys can use, fetched live from each provider, grouped by provider and searchable. Your choice is saved in the browser and used everywhere: chat, notes, syllabus parsing and careers. Each chat reply shows which model wrote it.

For Kiro, the list comes from `kiro-cli chat --list-models`. Kiro CLI has no per-run model flag, so orbit makes a text-only copy of its agent pinned to the model you picked (`kiro-agent/.kiro/agents/study-os-m-*.json`, created automatically). Models cost different amounts of Kiro credits.

Set `AI_MODEL=provider:model` to choose the default for new browsers. `OPENAI_BASE_URL` can point at any OpenAI-compatible service, such as OpenRouter or Ollama.

### Using Kiro as the AI

The app can run all of its AI (chat, notes, syllabus parsing) through your Kiro subscription using [Kiro CLI headless mode](https://kiro.dev/docs/cli/headless/).

1. Install Kiro CLI: `curl -fsSL https://cli.kiro.dev/install | bash` (macOS/Linux). Windows users can install from PowerShell (see kiro.dev/cli).
2. Generate an API key in your Kiro account settings. API keys are available on the Pro, Pro+ and Power plans.
3. Put `KIRO_API_KEY=ksk_...` in `.env` and restart the server. The startup log should show `AI: kiro`.

If you'd rather not use a key, run `kiro-cli login` once and set `AI_PROVIDER=kiro` instead. If `kiro-cli` isn't on your PATH, set `KIRO_CLI_PATH`.

Kiro runs as the `study-os` agent in `kiro-agent/`, which has **no tools**, so it can only reply with text and can't run commands or touch your files. Each AI request uses Kiro credits from your plan. Replies take a few seconds longer than a direct API call because the CLI starts up for each one.

**Spotify setup:** create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), add the redirect URI `http://127.0.0.1:3000/callback`, and copy the Client ID. The OAuth flow is PKCE, so you don't need a client secret. Remote playback control needs Spotify Premium. The embedded player works without any of this.

## Features

- **Syllabus import:** accepts almost any file: PDF (scanned PDFs too), Word (.docx, and .doc on Mac), PowerPoint, Excel, OpenDocument, RTF, HTML, CSV, text, photos and screenshots (PNG, JPG, HEIC…, read with OCR), and Pages/Keynote files that include a preview. You can drop several files at once (e.g. a photo of each page) or paste a screenshot straight into the text box. The same file support works for notes and your resume. Exams, quizzes, deadlines, readings, labs and no-class days go straight onto the calendar, and you can undo the import. Without an AI key, a built-in date parser handles formats like `Oct 14`, `10/14`, `14th November` and `2026-10-14`, and picks up times.
- **Auto study plans:** each exam gets six sessions scheduled at 10, 7, 5, 3, 2 and 1 days out, each with its own goal.
- **Focus phases:** these change automatically as the next exam approaches: drift, then rising (14 days), gravity (7), eclipse (3) and liftoff (exam day). Each phase changes the accent color (eclipse switches to the night theme), the pomodoro length and the playlist. You can override the mode by hand or turn on Zen to hide the sidebar.
- **Calendar:** month view, colors per course, course filters, quick add (`bio quiz fri 2pm`), and `.ics` export to Google or Apple Calendar.
- **Ask:** a chat that knows your schedule and notes. It can explain topics, quiz you and add events. In offline mode it only answers schedule questions.
- **Notes generator:** turns lecture text or slides into an outline, Cornell notes, a summary or flashcards. Notes are editable markdown, and each has a "Quiz me" button. Notes live in a folder for each course (plus "general"), and you can move notes between folders or sort general ones automatically. A few days before each exam (5 by default, set in Settings) orbit turns that course's notes into a **cheat sheet** and a **practice test with an answer key**. You can also make one any time from the folder or the focus page.
- **Spotify:** a player in the sidebar that keeps playing when you switch pages, with a playlist for each focus mode that you can change in Settings.

- **Degree planner:** a folder for each school year with your courses (code, credits, grade, status: done, in progress, planned, failed or dropped). It adds up credits earned, in progress and planned, shows how many are left to graduate, your average and approximate 4.0 GPA, and a finish-time estimate based on your pace. Import a transcript (PDF or screenshot) to build the folders automatically. Give it your university, your program and links to your program pages in the academic calendar, and it reads the requirements and checks every one against your courses. If the program has more than one stream or admission category (e.g. UTM CS CMP1 vs. regular), it asks which one you're in, plus any follow-up questions like co-op, and uses that stream's requirements: specific courses (with "or" options), "X credits from a list / 300-level" rules, total credits, plus things you tick off yourself like GPA or breadth. Credit systems for most Canadian universities are built in (e.g. U of T 0.5 per half-course / 20.0 total, UBC 3 / 120). Calendars that load with JavaScript can't be read from a link, so save the page as a PDF and upload it instead. This is a planning aid, not an official degree audit.
- **Careers:**
  - *Profile:* your default resume (PDF or paste) plus details like major, grad date, target roles, skills and work authorization. AI can fill the details in from your resume.
  - *Find:* Canada-first. Type something like "summer 2027 co-op in toronto or remote" and it turns that into filters (type, co-op term, city or province, where (Canada / Canada + US / US / anywhere), field, posted date, work authorization). Listings come from community-run Canadian 2027 internship and co-op lists, [SimplifyJobs' Summer 2027](https://github.com/SimplifyJobs/Summer2027-Internships) and [New Grad](https://github.com/SimplifyJobs/New-Grad-Positions) lists (filtered to your region), and any Greenhouse, Lever or Ashby company board you add. The defaults are Cohere, Ada, Faire and U of T's PEY co-op board. Work authorization options are Canadian (citizen, PR, study permit, open work permit, needs LMIA, dual CA/US). US roles that don't sponsor visas are hidden unless you're also a US citizen or green card holder. Results are ranked by fit, and AI can re-rank the top 30.
  - *Whole-web search:* add any of these free keys to `.env` to search every company, not just the lists: `SERPAPI_KEY` (Google Jobs, which covers LinkedIn, Indeed, Glassdoor, company career sites and startup boards; the free plan is 250 searches/month), `ADZUNA_APP_ID` + `ADZUNA_APP_KEY`, and `JOOBLE_API_KEY`. Results from every source are merged and de-duplicated, keeping the company's own apply link when there is one, and cached for 3 hours so repeat searches don't use up your quota.
  - *Tailor:* paste a job link or description and get a tailored resume, CV or cover letter built only from your real experience, following Canadian conventions (Canadian spelling, no photo, age or SIN, and French if the posting is in French), plus notes on missing keywords. "Save as pdf" opens a clean print layout.
  - *Tracker:* saved roles move through saved, applied, interview, offer and rejected. Deadlines and follow-ups can go on your calendar.

- **Home layout:** click **customize** on the home page to drag cards around, move them between columns or to the top, make them half or full width, or hide them. Your layout is saved.

All data lives in the browser's localStorage. You can export and import a backup in Settings.

## File support

Everything is read in your browser except two cases that use tools built into macOS: `textutil` for old `.doc` files and `sips` for HEIC/TIFF photos in browsers that can't open them. PDF reading (pdf.js) and photo OCR (Tesseract) load from a CDN the first time you use them, so you need internet for that.

## Code map

```
server.js            static server + /api/ai proxy (Anthropic/OpenAI) + /api/status  (local mode)
public/
  manifest.webmanifest  sw.js  icons/   PWA: install + offline
  js/app.js          router, theme, focus palette, sidebar widgets
  ai.js              AI "phone line" — picks server mode or website (bring-your-own-key) mode
  byoai.js           browser-direct AI calls (Anthropic/Gemini/OpenAI) for website mode
  webjobs.js         free, no-key, browser-direct job search (Arbeitnow/Remotive) for website mode
  fileread.js        reads pdf, office, images (OCR) and more into text
  degree.js          degree planner UI · degree-engine.js credit/requirement math (no DOM)
  syllabus.js        offline parser, AI parser, quick-add parser, import view
  focus.js           mode logic, study-plan generator, pomodoro, focus view
  calendar.js  chat.js  notes.js  dashboard.js  settings.js  spotify.js
  store.js           localStorage state + pub/sub     util.js  helpers + markdown
jobs.js  websearch.js   full job search (local server mode): feeds, boards, Google/Adzuna/Jooble
.github/workflows/deploy-pages.yml   auto-deploy public/ to GitHub Pages on push
```
To rename the app, change `APP_NAME` in `public/js/util.js`. The look is defined by the CSS variables at the top of `public/styles.css`: paper/night themes, fonts, and accent colors.
