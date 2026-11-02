# Harness

A personal chat and agent harness for **Claude Code**, the **Claude API** and **Gemini**, with
Google (Calendar, Gmail, Drive, Contacts), MCP servers, projects on disk, a Today page, phone
automations and notifications. It runs on your own computer, in the browser or as a desktop app.

## Run it

Needs Node 20+ (and the `claude` CLI if you want Claude Code).

```bash
npm install
npm start          # web app at http://localhost:4317
npm run desktop    # same app in an Electron window, with native notifications
npm test
```

Then open **Settings** to connect providers. Everything you enter is stored only on this
computer in `~/.ynros-harness` (override with `HARNESS_DATA_DIR`). API keys, OAuth tokens and
the Home Assistant token are never sent back to the browser.

### Why a local web app with an Electron wrapper

The server has to run on your machine anyway: it spawns the `claude` CLI, holds API keys and
OAuth tokens away from the page, reads and writes project folders, and keeps working (queues,
automations) while no tab is open. With a local server, the UI works in any browser and the
desktop app is a thin Electron shell around the same page. The shell adds native
notifications, a dock or taskbar presence, and keeps automations running after the window
closes on macOS. The server only listens on `127.0.0.1` and rejects requests for other hosts or
origins (DNS-rebinding and CSRF protection).

## What it does

| Area | Details |
| --- | --- |
| **Providers** | Claude API (streaming, tools), Claude Code (`claude -p` stream-json, sessions resumed per chat), Gemini (streaming, function calling). Test buttons in Settings. |
| **Auto model** | Pick `auto` as the model and a small model routes each message to a small, medium or large tier. Routing is sticky: a chat moves up a tier when needed but does not drop back mid-chat, which would lose the prompt cache. |
| **Fresh-chat hint** | When a message looks unrelated to the chat, a banner offers to move it to a new chat, so the old history isn't re-sent. |
| **Runs on the server** | Chats keep running when you switch away or close the tab; reopening replays the live stream. |
| **Subagents** | Claude Code subagents (Agent/Task, including background ones) appear in a live panel per chat with status, type, current activity, tool count and elapsed time. The sidebar shows running counts. |
| **Skills** | Claude Code skills show as a chip in the chat; click it to read the skill text in a modal. Claude API and Gemini get skills from `~/.claude/skills` and `<project>/.claude/skills` via a `load_skill` tool. |
| **Queue + triage** | Keep typing while a chat works. Messages queue and go out together as one batch. A small model checks each one, and if it should interrupt, you get an **Interrupt now / Keep queued** prompt. It never interrupts on its own. |
| **Usage limits** | Reads Claude Code's rate-limit events and 429s, plus optional token budgets for API keys. When a provider runs out, work waits for the reset (with a queued "continue") and the chat offers to switch provider. Queued and resumed work stops at 95% so the last **5%** (configurable) stays for your new instructions. |
| **Projects** | Folders on disk (default `~/Harness Projects`, set in Settings) with `CLAUDE.md` and `outputs/`. Claude Code runs inside the folder; API models get `CLAUDE.md` as instructions plus read/write tools for the folder. The sidebar groups chats by project, showing 3 per group with "Show more". |
| **@-mentions** | Type `@` for file autocomplete (with "Browse files…"), or use 📎 for a file picker. API models get the file contents inline; Claude Code reads them itself. |
| **Markdown** | Files view with a rendered viewer and a WYSIWYG editor (Toast UI), with save conflict detection. |
| **Google** | Your own OAuth client (loopback redirect). Calendar: read, and create events without emailing guests. Gmail: search, read and **draft only**. Drive: search and read. Contacts: look up people. |
| **Other calendars and people** | ICS feeds (Outlook, iCloud…), vCard files or URLs, and a local people notebook the models can update. |
| **MCP** | One registry for all providers. Add servers by hand (stdio or HTTP), install **Claude Code plugins** from its marketplace (their MCP servers are shared with the API models), or import **Gemini CLI extensions** from GitHub. |
| **Chrome** | One-click Chrome DevTools MCP, or *Claude in Chrome* for Claude Code. Browser actions ask **Allow / Deny** in the chat, and Claude Code permission prompts can too. |
| **Today** | Home page with today's calendar, important unread mail, chats waiting on you, recent replies, and your feeds and news topics. **Brief me** starts a briefing chat. |
| **Phone** | Through Home Assistant: your phone's zone and push notifications. Automations run on a schedule, when you arrive or leave, or both, and can notify you or run a prompt and send you the result. You can also ask in a chat ("remind me when I leave work"). |
| **Notifications** | Browser notifications on the web, native ones in the desktop app. They fire for finished replies, interrupt suggestions, approvals and automations. |
| **Themes** | Follows the system light or dark setting, with an override in Settings. |

## Layout

```
server/            Node server (no framework)
  index.js         HTTP API, static files, chat turns, queue, quota holds
  runs.js          server-side runs, subagent state, live event fan-out
  providers/       anthropic.js, gemini.js, claudeCode.js
  tools.js         tools for the models (Google, calendars, people, phone, projects, MCP…)
  triage.js        small-model interrupt check
  router.js        auto model routing
  quota.js         usage limits and the reserve
  automations.js   schedules and geofences
  mcp/             MCP client and registry (Claude plugins, Gemini extensions)
  integrations/    google, ics, contacts, feeds, skills, homeassistant
  mcp-server.js    bridge that gives Claude Code the harness tools and in-chat approvals
public/            the UI (plain ES modules, no build step)
client/, scripts/  bundles the Markdown editor into public/vendor (runs on npm start)
electron/          desktop shell
test/              node:test suites (fake Claude CLI and MCP server fixtures)
```

## Setting things up

- **Google**: in Google Cloud Console, enable the Calendar, Gmail, Drive and People APIs. Then create an OAuth client of type *Web application* with the redirect URI shown in Settings (`http://localhost:4317/api/google/callback`), paste the ID and secret into Settings, and click **Connect Google**.
- **Home Assistant**: create a long-lived access token (Profile → Security), enter your HA URL and token, and click **Find my phone** to pick your `person.*` entity and `notify.mobile_app_*` service.
- **Feeds**: paste feed URLs or site URLs. The app finds a site's RSS or Atom feed by itself.
