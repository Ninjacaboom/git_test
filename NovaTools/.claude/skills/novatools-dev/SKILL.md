---
name: novatools-dev
description: >
  Development process for the NovaTools repo (Star Citizen ship loadout
  configurator - vanilla JS front-end + small Flask/WSGI backend). Use this
  skill for ANY change in this repository - bug fixes, new features,
  refactors, security work, data refreshes, dependency updates or deploys -
  even one-line edits. It defines the security rules (HTML escaping, server
  allowlists, JSON payload sanitizing, CSP), where code belongs (pure-logic
  modules vs UI modules), the verification protocol (vitest + in-browser
  checks via Chrome MCP against localhost:8080), the commit/push/deploy
  rules, and how to handle Star Citizen game-data oddities. Consult it BEFORE
  writing code, not after.
---

# NovaTools development process

This skill encodes the working practices this repo is maintained with. The
codebase is small enough that one sloppy change degrades it noticeably, and
the app is publicly deployed with auto-deploy on push - so verification
discipline is what keeps production safe. When in doubt, do the smaller,
better-verified change.

## Environment quickstart

- `python` is NOT on PATH here. Always use the `py` launcher:
  `py server.py` (dev server on http://localhost:8080), `py update_data.py`.
- Tests: `npm test` (Vitest, one-shot). All tests must pass before every
  commit - no exceptions, the deploy pipeline assumes green.
- Browser testing: use the Chrome MCP tools (`mcp__Claude_in_Chrome__*`)
  against localhost:8080. Never use `preview_*` tools in this project.
- Syntax-check every edited JS file with `node --check <file>` before
  running the app - it catches broken edits in seconds.
- After replacing `data/Live.zip` or `data/PTU.zip`, ALWAYS run
  `py update_data.py` before testing or committing, and commit
  `data/versions.json` together with the ZIPs. The browser cache key
  includes `extractionTimestamp`; skipping this makes new data silently
  invisible.

## The change workflow

1. **Understand before editing.** Read the function you're changing and its
   callers. Line numbers in old notes drift - verify against current code.
2. **Edit**, keeping the change as small as the task allows.
3. **Verify mechanically**: `node --check` on touched JS, then `npm test`.
4. **Verify in the browser** if the change is user-visible (see
   "Browser verification" below). Server changes: exercise the routes
   (Flask test client or curl) instead.
5. **Commit** with a conventional-commit style message
   (`fix(scope): ...`, `security(scope): ...`, `refactor(scope): ...`) whose
   body explains the WHY, and end with the Co-Authored-By trailer the repo
   history uses. One logical change per commit.
6. **Never push unprompted.** "commit" means commit only. Pushing to master
   triggers the production deploy on PythonAnywhere. Only push when the user
   explicitly asks, and run the post-deploy checks afterwards (see "Deploy").

## Where code belongs

The architecture separates pure computation from DOM code. Keep it that way -
it is what makes the math testable.

| Kind of code | Belongs in |
|---|---|
| Loadout/stat math, parsing, simulation | `loadoutManager.js`, `combatCalc.js`, `ttkCalc.js`, `deflectionCalc.js`, `sustained.js`, `craftingModifiers.js`, `craftingSummary.js`, `tierEngine.js`, `weaponParser.js`, `shipParser.js` |
| Pure loadout/opponent queries | `loadoutQuery.js` |
| DOM rendering & event wiring only | `*UI.js`, `statsPanel.js`, `weaponColumn.js`, `pipPanel.js`, `ui.js`, `loadoutUI.js`, `buildManager.js` |
| Tiny dependency-free helpers (`escapeHtml`, `fmtNum`, `fmtStat`, `thouSep`, `gradeLetter`, `bindGlobalDropdownCloser`) | `utils.js` |
| Shared dropdown widgets (`buildMultiSelect`, `attachSearchableDropdown`) | `uiWidgets.js` |
| ZIP load, IndexedDB cache, roster filters (which hulls the app ever sees) | `dataLoader.js` |
| Persistence (localStorage, URL hash, share API) | `stateStore.js` |
| In-memory runtime state | `loadoutState.js` |

Rules that follow from this:

- **No pure math inside UI files.** If a function in a `*UI.js`/panel file
  touches no DOM, it belongs in a logic module where it can be unit-tested.
- **Check `utils.js` and `uiWidgets.js` before writing a helper.** This repo
  used to carry four copies of the same dropdown and three copies of
  `escapeHtml`; that duplication has been paid down once - do not reintroduce
  it. If two files need the same helper, move it to `utils.js`, don't copy it.
- **Functions stay under ~150 lines.** When one grows past that, split along
  its `// ── section ──` comment boundaries into named module-private
  helpers, exactly like `renderStats`/`renderSystemSlot` in `statsPanel.js`.
- **Import cycles**: statsPanel ↔ weaponColumn ↔ combatCalc are close to a
  cycle. If an import would create one, keep a documented private copy (see
  `turretClassOf` in `combatCalc.js`) rather than forcing the import.

## Security rules (non-negotiable)

### XSS / innerHTML

Every string interpolated into an `innerHTML`/`insertAdjacentHTML` template
goes through `escapeHtml()` from `js/utils.js`. Threat model:

- **Untrusted**: anything a user typed (build names), anything restored from
  localStorage (tab names, saved builds), anything fetched from the share
  API. These have produced real XSS sinks before.
- **Semi-trusted**: names from the game-data ZIPs (ships, weapons,
  manufacturers). Escape these too - defense in depth against a future
  extractor change.
- `showConfirmDialog(title, message)`: `title` is auto-escaped; `message`
  accepts trusted markup, so callers MUST `escapeHtml()` any user value they
  interpolate into it.

Prefer building elements with `textContent` when no markup is needed.

### CSP

index.html and both servers ship a CSP
(`script-src 'self'; worker-src 'self' blob:; ...`). `worker-src blob:` is
required by zip.js. Consequences: no inline `<script>`, no inline event
handler attributes (`onclick="..."`) in generated HTML, no external script
origins. If a change needs a CSP relaxation, stop and ask the user.

### Server (wsgi.py / server.py)

- The static catch-all serves ONLY the `STATIC_DIRS` allowlist and never
  `.db`/`.py`/dotfiles. New static content goes in an allowed directory; if
  a new directory is truly needed, add it to `STATIC_DIRS` in wsgi.py AND
  mirror the policy in server.py (dev/prod parity).
- Secrets are compared with `hmac.compare_digest`, never `==`/`!=`.
- Error responses to unauthenticated callers are generic; details go to the
  server log.
- IDs that act as capability tokens (share links) come from `secrets`, not
  `random`.
- Never reintroduce `debug=True` anywhere Flask might run.

### Parsed JSON → live state

Any JSON that crosses a trust boundary (share API payloads, imported builds)
is sanitized before touching state: type-check every field and drop
`__proto__`/`constructor`/`prototype` keys (assigning `__proto__` via
`Object.assign` rewires the target's prototype). Follow the
`sanitizeSharedBuild` pattern in `buildManager.js` and unit-test the
sanitizer, including the `JSON.parse('{"__proto__": ...}')` case.

## UI event-listener discipline

Listeners leak when bound on code paths that re-run. Before adding a
listener, ask: "does this code run more than once?"

- `document`-level listeners: bind once behind a module-level guard flag, or
  use the shared `bindGlobalDropdownCloser()` (delegated, idempotent).
  Reference guard pattern: `_dropdownInited` in `buildManager.js`.
- Listeners on persistent containers (elements whose innerHTML is replaced
  on re-render but which themselves survive): bind exactly once at init
  (see `bindColumnDrag` in `loadoutUI.js`).
- Listeners on freshly created elements that die with their overlay: fine to
  bind per render. Modal `keydown` handlers must be removed on close (see
  the dialog close pattern in `ttkCalcUI.js`).

## Testing rules

- New pure-logic functions get unit tests in `test/` in the same commit.
  Follow the existing style: header comment, `// ─── section ───` dividers,
  minimal fixture helpers (`makeCoolerItem`-style).
- Bug fix = regression test that fails on the old code. Verify mentally that
  it would have failed before your fix.
- **Characterization tests over speculative fixes.** When code behavior
  looks odd (e.g. a regex that misses a hypothetical input form), do NOT
  "fix" it. Write a test asserting current behavior with a comment, and
  verify against the actual game data whether the odd input can occur at
  all before changing anything. Past example: `MASS_DRIVER` (underscore)
  categorizes as Other - verified harmless because the form never occurs in
  game data and the call site receives normalized input.
- If the test count looks wrong (e.g. suddenly doubled), check for stray
  worktrees under `.claude/worktrees/` - vitest picks up their `test/`
  directories too. `git worktree list` + `git worktree remove` fixes it.

## Browser verification

Required for any user-visible change. Start `py server.py` in the
background, drive Chrome via the MCP tools, and always REPORT which build
(Live or PTU) you verified against, including the version shown in the header.

Practical recipes (all via `javascript_tool` with `action: "javascript_exec"`):

- **Wait for load**: after navigation/reload, wait ~3s and check
  `document.querySelectorAll('.lo-slot').length > 0` before asserting
  anything.
- **Value comparison**: capture the numbers you care about (banner DPS,
  shield HP, slot values) BEFORE your change and compare after. If a value
  differs unexpectedly, suspect **state drift** before regression:
  localStorage (pips, tabs, builds) changes as you interact with the app.
  Disambiguate with an A/B test: `git stash` your change (or
  `git checkout <old> -- js/`), reload, read the value on old code against
  the SAME state, then restore. Only a difference between old and new code
  on identical state is a regression.
- **XSS probe** after touching any name-rendering path: save a build named
  `<img src=x onerror=window.__xss=1>`, render the list and the delete
  dialog, assert `window.__xss !== 1`, then clean the test build out of
  `localStorage['sc-named-builds']` (leave the user's real builds intact).
- **Console check**: `read_console_messages` with `onlyErrors: true` after
  every scenario - zero errors is the bar (CSP violations show up here too).
- On the localhost dev instance there is no need to restore tabs or the
  selected ship afterwards - that state is throwaway. Do clean up test
  artifacts that could skew later results (probe builds, see above) before
  finishing.

## Commit / push / deploy

- Push to master = production deploy (GitHub Actions → PythonAnywhere
  `git pull` + reload). Health check after every push:
  1. `GET https://novatools.pythonanywhere.com/` → 200
  2. `GET /data/shared_builds.db` → 404 (must stay blocked)
  3. `curl -sI /` shows CSP + `X-Content-Type-Options` + `X-Frame-Options`
  4. `curl -sI /js/app.js` shows `Cache-Control: no-cache` + ETag. If those
     headers are missing (and `X-Clacks-Overhead` appears), a PythonAnywhere
     static-file mapping is intercepting the path - it must be removed in
     the PA Web tab (user action) so assets route through Flask. Only
     `/img/` is intentionally nginx-mapped.
- `gh run list --limit 1` confirms the deploy workflow succeeded.
- If production misbehaves after deploy, check the PA reload happened (the
  `/deploy` endpoint touches the WSGI file; the path hardcodes the
  `novatools` username).

## Game-data judgment calls

- Game data comes from the NovaSCDataExtractor sibling project. When a
  data-dependent question arises ("can this input form occur?"), answer it
  by sweeping the JSON inside `data/Live.zip` (and PTU.zip when present),
  not by guessing.
- CIG renames items between patches but keeps the `reference` GUID stable.
  Blueprint/recipe lookups must go through `getBlueprint()` (GUID-first),
  never directly through `blueprintsByClass` - a direct className lookup
  silently breaks after a rename.
- Weapon type strings are normalized by `deriveType()`/`WEAPON_TYPE_MAP`
  before they reach classification code. Raw `stdItem.Type` taxonomy strings
  ('WeaponGun.Gun') carry no damage keyword - never classify off them.
- Defer known-unreachable foot-guns to `TODOS.md` with rationale instead of
  inventing behavior without a real case (see the deriveType entry there).
- Prefer a rule derived from the data over a hand-kept className list, and
  measure it before committing: run old and new code over every hull in the
  ZIP and list exactly what changes. A className fragment in a blocklist
  matches more than intended (a ship name also hits that ship's own blades and
  mounts).
- Honour port locks when emulating a picker outside the browser. Tag and size
  compatibility alone says what would fit; an `Uneditable` port never opens a
  picker, so a "wrong item is offered" finding on a locked port is not real.
- Changing a roster filter in `dataLoader.js` needs a `DB_VERSION` bump - the
  cache holds the already-filtered arrays and its key only tracks the data
  version.
- Saved loadouts, tabs and named builds are keyed by the ship's display Name
  and store the full port map. Anything that changes which hull a Name points
  at must be checked against `isLoadoutForOtherHull`, or old stock items get
  laid over the new hull.
