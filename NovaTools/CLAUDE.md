# CLAUDE.md

## Project

Nova Tools is a Star Citizen ship loadout configurator. Vanilla JS front-end
in `js/`, served by a small Python server (`server.py` for local dev, `wsgi.py`
for PythonAnywhere). Game data is produced by the NovaSCDataExtractor sibling
project, which drops `Live.zip` and `PTU.zip` (plain ZIPs of named JSON files)
into `data/`. `js/dataLoader.js` reads them directly in the browser.

## Dev server

```bash
python server.py   # serves http://localhost:8080
```

## Tests

```bash
npm test           # one-shot vitest run
npm run test:watch # watch mode
```

Tests live in `test/`, one file per logic module (`loadoutManager`,
`dataLoader`, `weaponColumn`, `tierEngine`, `ttkCalc`, ...). They cover pure
logic - stat math, slot extraction, picker compatibility, roster filters,
saved-state guards - not DOM wiring.

## Refreshing game data

Whenever `data/Live.zip` or `data/PTU.zip` is replaced (extractor drop, manual
refresh, etc.), ALWAYS run `py update_data.py` immediately afterwards before
committing or testing in-browser.

`update_data.py` rewrites `data/versions.json` with each archive's current
`gameVersion`, `buildVersion`, `extractionTimestamp`, and `sha256`. The
in-browser IndexedDB cache key includes `extractionTimestamp`, so without
this step clients keep serving the previous snapshot from cache and the new
ZIP data appears not to load (e.g. data fixes silently invisible).

Commit `versions.json` together with the refreshed ZIPs.

## Project docs

- [DATA_SOURCES.md](./DATA_SOURCES.md) - NovaSCDataExtractor archives, ZIP structure, CStone shop data
- [FORMULAS.md](./FORMULAS.md) - All the math (pips, shields, IR/EM, cooling, DPS)
- [UI_GUIDE.md](./UI_GUIDE.md) - CSS conventions, section headers, colour variables
- [ICONS.md](./ICONS.md) - `spv-icons` font reference and CSS mapping
- [TODOS.md](./TODOS.md) - Deferred work with rationale

## Browser

Use localhost:8080 (Flask dev server) + Chrome MCP tools (`mcp__Claude_in_Chrome__*`) for all browser testing. Never use `preview_*` tools.

## gstack

### Available skills

/office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

**Any code, config or data change in this repo → read the `novatools-dev` skill
first** (`.claude/skills/novatools-dev/SKILL.md`). It defines the security rules,
module layout, verification protocol and deploy checks this repo is maintained
with - including for small one-line edits.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken" → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, visual audit → invoke design-review
- Architecture review → invoke plan-eng-review

## Deploy Configuration (configured by /setup-deploy)

- Platform: PythonAnywhere
- Production URL: https://novatools.pythonanywhere.com
- Deploy workflow: `.github/workflows/deploy.yml` (auto-deploy on push to `master`)
- Merge method: push directly to master (no PR required)
- Project type: web app (Python WSGI + vanilla JS)
- Post-deploy health check: https://novatools.pythonanywhere.com

### Custom deploy hooks

- Pre-merge: `npm test` (Vitest - must pass before push)
- Deploy trigger: automatic on push to `master`
- Deploy status: SSH `git pull` + `POST /api/v0/user/novatools/webapps/novatools.pythonanywhere.com/reload/`
- Health check: https://novatools.pythonanywhere.com

### GitHub Secrets required

| Secret | Where to get it |
|--------|----------------|
| `PA_DEPLOY_SECRET` | Any strong random string - set the same value in PA Web tab → Environment variables as `DEPLOY_SECRET` |

### PythonAnywhere setup (one-time)

1. Open a PA Bash console and run:
   `echo "your-secret-here" > ~/.deploy_secret`
2. Reload the web app once manually
3. The `/deploy` POST endpoint is now live and secured by that token
