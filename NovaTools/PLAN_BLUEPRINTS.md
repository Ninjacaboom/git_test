# Blueprints Browser - Implementation Plan

Branch: `blueprints`
Status: Draft (next: `/plan-design-review` for layout proposals, then implementation)

A new tab after "Weapon Deflection" that lets a player find a blueprint
and see how to acquire it: which contracts/scenarios drop it, where they
operate, what faction grants them, what reputation gates them, and what
other blueprints share the same reward pool. Mirror navigation: pick a
mission, see all blueprints in its pool.

Data is sourced from five new files added to `data/PTU.zip` by
NovaSCDataExtractor: `blueprints.json` (now with `RewardSources[]`),
`missions.json`, `factions.json`, `standings.json`, `localities.json`,
`tags.json`. Live currently lacks the mission-graph data - feature is
PTU-only at v1.

---

## 1. Goals + non-goals

### Goals
- **Find a blueprint, see acquisition path.** Full mission-detail view per
  source: title, description, faction, locality, **standing window (min + max)**,
  effective drop chance, mission tags.
- **Ingredients per blueprint.** Aggregate resource costs across all the
  blueprint's slots so the user sees the full material requirement inline
  on the BP card / detail view ("Iron 64 cSCU · Riccite 9 cSCU · Titanium 32 cSCU").
- **Craft time per blueprint.** Display `Tiers[0].CraftTimeSeconds` as
  human-formatted ("1m 30s") on every BP entry.
- **Quality preview.** Per BP, surface "if I craft at quality N, my stats
  become X" - reuses `craftingModifiers.js` math from the Loadout Manager.
- **Mission perspective.** For any contract or scenario tier, list the
  other blueprints in the same reward pool sorted by chance.
- **Resource navigation (inline, Q1=C).** Click a resource pill on a BP
  card → filters the blueprint list to "BPs that require this resource".
  No dedicated resource sub-tab in v1.
- **Search both blueprints and missions.** Fuzzy match across names +
  mission titles.
- **Filter narrowly.** Faction, lawful/unlawful, locality, mission type
  (Contract / ScenarioTier).
- **Cross-link from Loadout Manager.** Overflow-menu (⋯) on an installed
  item's slot row → "Show acquisition paths" → jump to Blueprints tab
  with that item preselected.

### Non-goals (v1)
- Recommended missions (chance × ease scoring) - _deferred_
- Faction-reputation calculator (track player standing) - _deferred_
- Aggregate "best mission for this BP" suggestion - _deferred_
- Tag-tree browser (18 k tags) - _deferred_
- Mission location coordinates in space - _no extractor data_
- **"Mark as owned" / inventory tracking** - user-state feature, defer entirely (Q2=D)
- **Fabricator / wishlist queue** - user-state feature, defer entirely (Q2=D)
- **Mining locations per resource** - no extractor data yet; would be nice eventually (Q1 follow-up)
- **Mission type categorization** (mercenary / delivery / combat) - no extractor field yet; queued for extractor update (Q3=I)
- **Standing reward** (rep gained from completing a mission) - no extractor data yet; queued for extractor update
- **Multi-tier blueprints** - all current BPs have exactly 1 tier; iterate `Tiers[]` later if CIG ships T2/T3
- Reputation reward type - doesn't exist in the data; standings are only
  contract gates, not reward sources
- Dedicated Live-build gating - feature works on both builds, just with less data on Live (1 040 BPs / 356 with sources vs 1 537 / 670 on PTU)

---

## 2. Data model (verified against PTU.zip)

### Source files

| File | Entries | Role |
|---|---|---|
| `blueprints.json` | 1 537 | Per craftable item: `TargetClassName`, `TargetName`, `TargetType`, `TargetSize`, `TargetDescription`, `Tiers[]` (each tier has `CraftTimeSeconds` + `Slots[].Costs[]` + `Slots[].Modifiers[]`), **`RewardSources[]`** |
| `missions.json` | 691 | Contracts + ScenarioTiers. `Kind`, `ClassName`, `Title`, `Description`, faction/standing/locality refs, `TagFilter`, `BlueprintRewards[]` |
| `factions.json` | 37 | `FactionReputation`: `DisplayName`, `Logo`, `Lawful`, `IsNPC`, `Description`, HQ/Leadership/Area/Focus |
| `standings.json` | 374 | Reputation rank thresholds: `DisplayName` ("Friendly", "Hostile", …), `MinReputation` (signed int) |
| `localities.json` | 20 | Region records: `ClassName` (Nyx, Pyro_RegionA, …), `AvailableLocations[]` |
| `tags.json` | 18 579 | GUID-keyed: `TagName`, `Path` (e.g. `"Top > Mid > Leaf"`) |

### Key relationships (many-to-many)

```
blueprints.json                 missions.json                 factions.json
  TargetClassName    ─────►       ClassName       ─────►       ClassName
  Tiers[0]                        FactionClassName              DisplayName
    .CraftTimeSeconds             StandingMinClassName ──►     standings.json
    .Slots[]                      StandingMaxClassName ──►     standings.json
      .Costs[]    ──►             LocalityClassName    ──►     localities.json
        .GUID     ──► resources   TagFilter.Pos/NegTags ──►    tags.json (by GUID)
        .Quantity                 BlueprintRewards[]
        .Type ("Resource"|"Item")   .TargetClassNames[] ──►    blueprints.json (back-ref)
      .Modifiers[]                                              (sum per resource = total BP cost)
  RewardSources[]
    .MissionClassName
    .PoolClassName
    .EffectiveChance
    .Kind: "Contract" | "ScenarioTier"
```

### Aggregating resource costs per blueprint

A BP's total cost is the sum across every slot's `Costs[]`, grouped by
resource GUID. For most BPs that's a small handful (Borase, Gold,
Beradom, …). Same GUID appearing in multiple slots gets summed.

Example (10-Series Greatsword Cannon, from screenshot):
```
Slot SHELL    →  Iron 5.25
Slot FRAME    →  Riccite 0.72
Slot BARREL   →  Titanium 2.5
                 ─────────────
total          →  Iron 64 cSCU, Riccite 9 cSCU, Titanium 32 cSCU
                 (units depend on resource.UnitType - see resources.json)
```

(Numeric mismatch between raw quantity and displayed value is the
unit-of-measure conversion - to verify when implementing. Likely
`Quantity * 12.something` for SCU→cSCU, or a hardcoded multiplier in
the source data. Test against the screenshot during Phase 1.)

### Reward semantics

`EffectiveChance` is **per-run, per-BP probability**:

```
chance(BP in pool) = pool_fire_chance × (weight_in_pool / sum_weights)
```

Verified distributions across 677 missions with reward pools:
- `sum(EffectiveChance) < 1.0` - majority. Sometimes the run yields nothing.
- `sum(EffectiveChance) ≈ 1.0` - many. Weighted lottery, exactly one BP per success.
- `sum(EffectiveChance) > 1.0` - 157 / 677 (~23 %). Multiple independent rolls per run - can yield several different BPs or duplicates.
- `sum(EffectiveChance) == 1.0` and a single BP at 1.0 - only **3 missions** have a guaranteed drop.

→ UI must show per-BP chance AND surface the sum on multi-roll missions so users don't misread the lottery mechanic as a guarantee.

### Distribution of acquisition data

- **670 / 1 537 BPs (43 %)** have at least one `RewardSource`
- **520 / 1 537 (34 %)** have two or more
- **25 BPs are scenario-only** (Xenothreat 2 line: MXOX Neutron Repeater etc.)
- **867 BPs have no known source** - possibly future content, scenario-only that extractor hasn't mapped, or otherwise excluded. _Hidden by default; toggle to expose._
- Top mission pool: `Shubin_RG_Discovery_ShipMining_Stanton_Gold` rolls 35 BPs per run (sum = 4.0).

---

## 3. Architecture

### Data flow

```
PTU.zip
   │
   ▼
dataLoader.js (DB_VERSION bump → invalidates cache for new shape)
   ├─ vehicles, hardpoints, items, blueprints, resources  (existing)
   └─ missions, factions, standings, localities, tags    ── NEW
                                  │
                                  ▼
                   blueprintsData.js (NEW, pure logic, testable)
                                  │
                                  ├─ Lookup maps (built once at init):
                                  │    blueprintsByClass : Map<className, Blueprint>
                                  │    missionsByClass   : Map<className, Mission>
                                  │    factionsByClass   : Map<className, Faction>
                                  │    standingsByClass  : Map<className, Standing>
                                  │    localitiesByClass : Map<className, Locality>
                                  │    tagsByGuid        : Map<guid, Tag>
                                  │
                                  ├─ Reverse indexes (built once):
                                  │    missionToBlueprints : Map<missionCN, Blueprint[]>
                                  │       (sorted descending by EffectiveChance)
                                  │    blueprintToMissions : Map<bpCN, Mission[]>
                                  │
                                  ├─ Fuzzy search indexes (MiniSearch, ~25 KB dep):
                                  │    bpSearchIndex      → matches Name, ClassName, Description
                                  │    missionSearchIndex → matches Title, ClassName, Description
                                  │
                                  └─ Resolve helpers:
                                       resolveMission(cn) → fully joined Mission object
                                          with faction, BOTH min+max standing, locality,
                                          tag objects attached inline (one-shot join).
                                       formatStanding(s)  → "Friendly (75 000+)" or "75 000"
                                          (Decision 2 - hybrid display, applies to min AND max).
                                       isWIP(mission)     → drop unreleased entries.
                                       hasKnownSources(bp) → for the "show all" toggle.
                                       aggregateIngredients(bp) → Map<resourceGUID, totalQty>
                                          summed across every slot in Tiers[0].
                                       formatCraftTime(sec) → "1m 30s" / "10s" / "3m" / "1h 5m".
                                       getResource(guid)  → resource record by GUID.
                                       getBPsUsingResource(guid) → reverse index for the
                                          "click a resource pill → filter list" flow.
                                  │
                                  ▼
                   blueprintsUI.js (NEW, DOM + events)
                                  │
                                  ├─ Tab init + sub-tab switching ("Blueprints" / "Missions")
                                  ├─ Master-detail layout (Loadout Manager-style):
                                  │     left   = list (table-style, sortable columns)
                                  │     right  = detail panel for selected entry
                                  ├─ Search input per sub-tab (debounced 150 ms)
                                  ├─ Filter chips: Faction, Lawful, Locality, Mission Type
                                  ├─ Detail view (blueprint):
                                  │     - Item metadata (name, class, grade, type, CraftTime tag)
                                  │     - **INGREDIENTS** section: aggregated resource pills
                                  │       (name + quantity + unit), each pill clickable to
                                  │       filter the list to BPs requiring that resource
                                  │     - **QUALITY PREVIEW** section: quality slider 0-1000
                                  │       reusing `craftingModifiers.js` to compute live stats
                                  │     - Acquisition paths (mission cards, sorted by chance)
                                  │     - Each mission card (see §4.2 for full spec):
                                  │       title + info (i) icon, contractor + locality pills,
                                  │       chance %, standing window (min + max), "N BPs in
                                  │       pool - view pool" link, mission tags
                                  ├─ Detail view (mission):
                                  │     - Full mission Title + collapsible Description block
                                  │     - Faction, standing window, locality, tags
                                  │     - BlueprintRewards section: top-5 + expander
                                  │     - Sum-badge if sum(EffectiveChance) > 1.0
                                  └─ Cross-links: blueprint card ↔ mission card switch tabs
                                       Loadout Manager slot ⋯ menu → opens BP preselected

(Layout details deferred to /plan-design-review.)
```

### Cross-link from Loadout Manager

```
Loadout Manager - slot row
  ├─ crafting indicator (existing)
  └─ NEW: right-click / overflow-menu on the row → "Show acquisition paths"
       └─ openBlueprintsTab(className) - switches active tab + preselects BP
```

Hook in `weaponColumn.js` / `statsPanel.js` slot renderers. Trivial
addition; no new data model needed.

---

## 4. UI structure (layout details deferred to /plan-design-review)

### Tab nav

```
[ Loadout Manager ] [ Weapon Deflection ] [ Blueprints ] [ … build toggle … ]
```

`<button class="tab-btn" data-tab="blueprints">Blueprints</button>` -
added to `index.html` after the analyzer button. Existing tab-switch
logic in `ui.js` handles activation.

### Within the Blueprints tab - two sub-tabs

Layout details NOT locked. Two HTML mockups were produced in the
`/plan-design-review` pass (`~/.gstack/projects/ohman74-NovaTools/designs/
blueprints-tab-20260513/variant-a.html` and `variant-c.html`); neither
was accepted. The user pointed at sc-craft.tools as functional reference
and we expanded scope accordingly (this revision). A fresh design pass
will run once the new functional spec below is locked.

### 4.1 Blueprint card / row content (locked)

Every entry in the Blueprints list shows:

```
┌────────────────────────────────────────────────────┐
│ 10-Series Greatsword Cannon       [1m 30s]    [🔧] │
│ INGREDIENTS                                        │
│ [Iron 64 cSCU]  [Riccite 9 cSCU]  [Titanium 32 cSCU]│
│ ● 1 mission                                        │
└────────────────────────────────────────────────────┘
```

- Title (BP name) on left
- Craft-time tag from `Tiers[0].CraftTimeSeconds`, formatted via `formatCraftTime()`
- Wrench glyph (FA `wrench`) right side - affordance: indicates "craftable"
- **INGREDIENTS** sub-header (uppercase letter-spaced label, in `--gold`)
- Resource pills, each clickable → filters list to "BPs requiring this resource"
- Pill colour: resource-name text in cyan/gold (matches resource UnitType
  bucket - SCU resources cyan, harvestable Units gold)
- Bottom: drop indicator (`● N missions` or `○ no known drops`)

### 4.2 Mission card content (locked, mirrors sc-craft.tools screenshot 3)

Every mission card inside a BP's "Acquisition paths" section shows:

```
┌────────────────────────────────────────────────────┐
│ MERCENARY                                  (header pill, per type) │
├────────────────────────────────────────────────────┤
│ Destroy Headhunter Stolen Data            [i]      │
│ [Citizens for Prosperity]  [Pyro]                  │
│                                                    │
│ Min: Friendly (75 000+)   Max: Hostile (200 000−) │
│ Standing reward: +500 rep                          │ ← _Phase 2+ TODO_
│                                                    │
│ 100 %  ·  12 blueprints in pool - view pool        │
└────────────────────────────────────────────────────┘
```

- **Mission type group header** (e.g. "MERCENARY", from Q3 extractor field)
  groups missions within the BP's path list. Until the extractor ships
  this, fall back to grouping by `Kind` (Contract / ScenarioTier).
- Title + info (`i`) icon - click opens collapsible description block
- **Contractor pill** (cyan) + **Locality pill** (blue/purple) side by side
- **Standing window** - both `StandingMinClassName` and `StandingMaxClassName`
  joined to standings.json. Hybrid display: `RankName (NumericThreshold±)`.
  When min == max, show single line. Skip line when both null.
- **Standing reward** - _placeholder, Phase 2+ TODO once extractor surfaces_
- **Chance** prominently displayed in `--gold` or `--green`
- "**N blueprints in pool - view pool**" link expands the pool inline
  (top-5 by chance + "+N more" expander, as already locked in Decision 4)

Mission type header colour:
- `MERCENARY` / combat-ish → `--red` (matches sc-craft.tools)
- `DELIVERY` → `--cyan`
- `BOUNTY` / law-related → `--green`
- `SCENARIOTIER` (Xenothreat etc.) → `--orange`
- Fallback (`CONTRACT`, unknown) → `--text2`

### 4.3 Quality preview slider (locked, reuses Loadout Manager math)

On a BP's detail view, a quality slider 0-1000 lets the user preview
the stat impact of crafting at that quality. Pure read-only display
(no state mutation). Reuses `craftingModifiers.js`'s `computeBlueprintModifiers`
+ `applyModifiers` against a synthesized stdItem. Output:

```
QUALITY PREVIEW                                      [slider 0─●─1000]
At quality 750 (above default 500):
  · Max. Shield Strength:  3 168 hp → 3 484 hp  (+10.0 %)
  · Integrity:               210 hp →   220 hp  (+ 5.0 %)
```

No persistence - popover-style read-only. Per-slot quality starts at 500;
moving the master slider sets every slot to that value uniformly.
Per-slot fine-tuning lives in the Loadout Manager crafting popover.

### Reuse vs new

| Concern | Reused |
|---|---|
| Tab nav | `.tab-nav` + `.tab-btn` in [index.html:16-18](index.html:16) |
| Sortable column tables | `renderRows()` pattern in [weaponColumn.js:1417-1471](js/weaponColumn.js:1417) - abstracted out |
| Search-input styling | `.search-box` / `.ms-search` classes |
| Filter-dropdown styling | `.multi-select` / `.ms-dropdown` (used by ship picker) |
| Detail panel pattern | Loadout Manager `loStatsBanner` expanded-overlay style |
| Card / chip styling | Existing dark-card vars (--bg2, --bg3, --border, --cyan) |
| Color tokens (lawful/unlawful) | `--green` (lawful), `--red` (unlawful), `--gold` (mission gold) |

| Concern | New |
|---|---|
| `js/blueprintsData.js` | Pure logic - indexes, search, joins |
| `js/blueprintsUI.js` | DOM + events for the tab + sub-tabs + detail |
| Sub-tab styling | New `.bp-subtab` / `.bp-subtab-btn` classes |
| MiniSearch dep | `~25 KB` minified, self-hosted |

---

## 5. State + persistence

### Session state (in-memory only - not in localStorage)

```js
// blueprintsData.js / blueprintsUI.js
let activeSubTab       = 'blueprints' | 'missions';   // current sub-tab
let bpSelectedClass    = null;                         // currently selected BP
let missionSelectedCN  = null;                         // currently selected mission
let bpSearchQuery      = '';
let missionSearchQuery = '';
let bpFilters          = { factions: Set, lawful: null, localities: Set, missionTypes: Set };
let missionFilters     = { /* same shape */ };
let showUnmappedBPs    = false;                        // Decision 6
```

### URL hash for deep-link / shareability

```
#tab=blueprints&sub=blueprints&bp=SHLD_GODI_S01_AllStop_SCItem
#tab=blueprints&sub=missions&mission=Shubin_..._Gold
```

`sub` defaults to `blueprints`. Cross-links from Loadout Manager set
`#tab=blueprints&bp=<className>`.

### Not persisted across reloads

Filter state, search query, sub-tab. URL hash is the only persistence
layer - refresh restores from URL, not from history. Cleaner than
localStorage for read-only views like this.

---

## 6. Test strategy

### Pure logic (vitest)

```
PURE LOGIC (blueprintsData.js)
[+] Index construction (init-time)
  ├── [TARGET ★★★] BP-by-className map populated (1537 entries)
  ├── [TARGET ★★★] Mission-by-className map populated
  ├── [TARGET ★★★] Reverse index: missionToBlueprints sorted by chance desc
  ├── [TARGET ★★★] Reverse index: blueprintToMissions
  ├── [TARGET ★★ ] Empty/malformed source arrays handled (Live-build safety)
  └── [TARGET ★  ] Tag-GUID lookup populated (smoke)

[+] resolveMission(cn)
  ├── [TARGET ★★★] Full join with faction + standing + locality
  ├── [TARGET ★★★] Missing faction → returns null faction, no crash
  ├── [TARGET ★★★] PLACEHOLDER displayName fallback (Decision 2 hybrid)
  ├── [TARGET ★★ ] TagFilter resolution (positive + negative tags)
  └── [TARGET ★★ ] WIP/NotForRelease excluded from default queries

[+] Search (MiniSearch wrapper)
  ├── [TARGET ★★★] BP fuzzy match - "hammr" → "Hammerhead"
  ├── [TARGET ★★ ] Mission title match
  ├── [TARGET ★★ ] ClassName fallback when name is placeholder
  └── [TARGET ★  ] Empty query returns all

[+] Filter composition
  ├── [TARGET ★★★] Multi-filter AND semantics (faction AND locality)
  ├── [TARGET ★★ ] Same-filter OR semantics (faction A OR faction B)
  ├── [TARGET ★★ ] showUnmappedBPs toggle behaviour
  └── [TARGET ★  ] Empty filter set = no filtering

[+] EffectiveChance ranking
  ├── [TARGET ★★★] BPs sorted descending by chance within a mission
  ├── [TARGET ★★ ] Tie-break by BP name (deterministic)
  └── [TARGET ★  ] sum(EffectiveChance) computed for badge

[+] Cross-link helpers
  └── [TARGET ★★ ] openBlueprintsTab(className) sets state + URL hash

[+] Ingredients aggregation
  ├── [TARGET ★★★] Same resource across slots sums correctly
  ├── [TARGET ★★ ] Mixed Resource + Item types in one BP
  ├── [TARGET ★★ ] Empty Costs array handled (some slots may have none)
  └── [TARGET ★  ] Resource lookup by GUID, fallback "Unknown resource"

[+] Resource reverse index
  ├── [TARGET ★★★] getBPsUsingResource(guid) returns correct list
  └── [TARGET ★★ ] Resource pill click filters correctly (smoke + unit)

[+] formatCraftTime
  ├── [TARGET ★★★] 10 → "10s", 90 → "1m 30s", 180 → "3m", 3900 → "1h 5m"
  └── [TARGET ★  ] 0 / negative / NaN → "-" (graceful)

[+] formatStanding (extended for min + max)
  ├── [TARGET ★★★] Min + Max both present → "Friendly (75 000+) - Hostile (200 000−)"
  ├── [TARGET ★★ ] Only Min present → single-line render
  └── [TARGET ★★ ] Both null → row hidden entirely

UI SMOKE (Chrome MCP at localhost:8080 - per CLAUDE.md)
[+] Browse flow                                          [+] Cross-link flow
  ├── [GAP] Tab switch shows new pane                     ├── [GAP] Right-click in Loadout Manager
  ├── [GAP] Sub-tab switch + state reset                  ├── [GAP] "Show acquisition paths" item
  ├── [GAP] Pick BP → detail populates                    └── [GAP] Lands on correct BP in Blueprints tab
  ├── [GAP] Pick mission → detail populates
  ├── [GAP] Search debounce (no flicker)
  ├── [GAP] Filter chip combo
  └── [GAP] "Other BPs in pool" expander

COVERAGE TARGET: 100 % of blueprintsData.js
                 ~80 % of blueprintsUI.js public exports (rest is DOM events,
                 covered by manual Chrome QA)
```

### Test files

| File | Purpose |
|---|---|
| `test/blueprintsData.test.js` | All pure-logic tests above |
| `test/blueprintsData.fixtures.js` | Small JSON fixtures mimicking real PTU shape (5-10 blueprints, 3 missions, 2 factions, 2 standings, 1 locality, 5 tags) |

---

## 7. Implementation phases

Each phase ships in a clean state. Persistent build, never WIP, tests
green at every commit.

### Phase 1 - Data load + pure-logic module
- Extend `dataLoader.js` to read the 5 new JSON files (best-effort, like
  `blueprints.json` already does). Empty arrays on Live → feature dark.
- Bump `DB_VERSION` (was 6 → 7) to invalidate stale IndexedDB cache.
- New `js/blueprintsData.js` with lookup maps + reverse indexes +
  `resolveMission` + filter helpers.
- Vitest suite covering 100 % of the module.
- No UI yet. Verifiable via console: `blueprintsData.searchBlueprints('hammerhead')`.

### Phase 2 - Tab + blueprint sub-tab (list + search + filters)
- Add MiniSearch dep (~25 KB) - self-hosted in `vendor/minisearch/`.
- Add tab button + panel skeleton.
- Build the Blueprints sub-tab: sortable list, fuzzy search, 4 filters,
  "show unmapped" toggle.
- No detail view yet; clicking a row just highlights it.

### Phase 3 - Missions sub-tab + detail panels
- Build the Missions sub-tab (same shape as Blueprints, different
  search index and filters).
- Build detail panels for both: BP card with acquisition paths, mission
  card with BlueprintRewards.
- "Other BPs in this pool" expander (top-5 + +N more).
- Sum-badge for multi-roll missions with tooltip explaining mechanic.

### Phase 4 - Cross-link from Loadout Manager
- Right-click context menu on installed-item slot row OR slot overflow
  button (decision in `/plan-design-review`).
- `openBlueprintsTab(className)` switches active tab, selects BP, scrolls
  it into view.
- URL hash deep-link round-trip test.

### Phase 5 - Polish + docs
- Update `DATA_SOURCES.md` with the 5 new file schemas.
- Update `UI_GUIDE.md` with new CSS class table.
- Update `FORMULAS.md` with EffectiveChance formula + sum semantics.
- Update `CLAUDE.md` skill routing if relevant.
- Final Chrome QA pass.

---

## 8. Failure modes

| Codepath | Failure mode | Coverage |
|---|---|---|
| Missing `missions.json` (Live build) | Tab disabled with greyed-out label, tooltip "Available on PTU" | Test: empty array → tab.hidden |
| Mission references nonexistent faction GUID | `resolveMission` returns null faction, card shows "Unknown faction" | Unit test for missing-ref |
| Tag GUID not in `tags.json` | Card shows GUID literal as fallback | Unit test |
| Standing with PLACEHOLDER displayName | Falls back to "Min standing: 75 000" (no rank name) | Unit test for Decision 2 |
| BP with no RewardSources + toggle off | BP hidden from list (Decision 6) | Unit test |
| BP with no RewardSources + toggle on | Detail card shows "No known acquisition path" | Unit test |
| Multi-roll mission with sum > 1.0 | Sum-badge shows "Rolls ~N times per run" | Unit test for badge logic |
| URL hash with invalid BP class | Selection cleared, list shown without prefill | Test for unknown-className |
| Search query with 1 char | MiniSearch returns sensible results (prefix match) | Library handles natively |
| MiniSearch index build fails | Tab still loads, search falls back to substring filter | Try/catch + console.warn |

---

## 9. What already exists (reused, not rebuilt)

- **Tab switching** - `ui.js` `initTabNav()` handles activation
- **Table sortable headers** - pattern in `weaponColumn.js:1417+` (might
  abstract to a shared `renderSortableTable()` helper in Phase 2)
- **Search input + debounce** - pattern in shipFilter / weaponSearch
- **Filter dropdown (multi-select)** - `.multi-select` + `.ms-dropdown`
  pattern from ship picker
- **Detail-panel overlay** - Loadout Manager `stats-expanded` style
- **Card / chip CSS** - dark-card vars (--bg2, --bg3, --border, --cyan)
- **URL hash state** - `loadHash`/`saveHash` in `stateStore.js`
- **Tabs persistence** - extending pattern from `persistTabs` is *not*
  needed since we use URL hash, but the pattern is there if we change
  our mind

---

## 10. Open follow-ups (out of v1 scope)

### Extractor-side asks (blockers we'll send upstream)

| Ask | Why we want it | Current workaround |
|---|---|---|
| `MissionType` field per contract | Sc-craft.tools groups missions by type ("MERCENARY", "DELIVERY", "BOUNTY"). Drives the colour-coded section header in §4.2 and a future Mission Type filter. | Q3=I - fall back to grouping by `Kind` (Contract / ScenarioTier) until the field arrives. |
| `StandingReward` per contract | Players want to know how much rep they GAIN from completing a mission (not just the gate to enter). This drives "grind X mission to unlock Y missions" planning. | Phase 2+ TODO; show the row as `-` until populated. |
| Mining locations per resource | Sc-craft.tools shows "Borase is found in Nyx Glaciemring, Pyro Bloom, Stanton Lagrange Points, …". With this we could expand the resource-pill click flow into a real "where to find this material" tooltip. | Q1 follow-up; for now the pill click only filters BPs that use the resource. |

### v1+ NovaTools follow-ups (UI work, no data blocker)

| Item | Rationale for deferring |
|---|---|
| Resource detail sub-tab | Q1=C scope says inline-only in v1 - pill click filters list. A full "Resources" sub-tab (browse all resources + per-resource view) is the natural next iteration once mining-location data lands. |
| Owned / inventory tracking | Q2=D scope - user-state feature with localStorage persistence, share/export flow, possibly multi-user org. Significant UI add. Defer until users ask. |
| Fabricator / wishlist queue | Q2=D scope - bundles with "Owned". To-craft queue with total build time, total resource cost aggregation across multiple BPs. Defer with "Owned". |
| Recommended-mission scoring (chance × ease) | Needs heuristic for "ease" - mission length, standing requirements, lawfulness penalty. Doable once the extractor fields above ship. |
| Faction-reputation calculator | Track player's current standing per faction; gray out un-takeable missions. Data supports it; requires user input state (so it's in the Q2=D bucket). |
| Multi-tier blueprints | All current BPs have exactly 1 tier - switch the `Tiers[0]` accesses to a `Tiers[]` loop only when CIG ships T2/T3 receipes. |
| Tag-tree browser | 18 k tags - would need tree-UI component. Defer until users ask. |
| BP comparison view | "Which BP is better?" - different mental model. |
| Mission timer / cooldown awareness | Some missions have cooldowns CIG doesn't expose in this data. |

---

## 11. Decisions locked

| # | Topic | Decision |
|---|---|---|
| 1 | Filter scope | 4 filters (Faction, Lawful, Locality, Mission Type). WIP-missions always hidden. |
| 2 | Reputation display | Hybrid: "Friendly (75 000+)" when DisplayName is non-placeholder, otherwise just the number. |
| 3 | WIP / NotForRelease missions | Hidden always. No toggle. |
| 4 | Multi-BP-pool display | Top-5 by EffectiveChance + expander "+N more". Sum-badge on missions with `sum > 1.0` ("Rolls ~N times per run"). |
| 5 | Performance | MiniSearch (~25 KB) for fuzzy search + 150 ms debounce on input. Indexed maps built at load. |
| 6 | BPs without RewardSources | Hidden by default. "Show without known drops" toggle exposes them. Detail view explains "No known acquisition path". |
| 7 | Search UX | Two sub-tabs ("Blueprints" / "Missions"), each with own search + filters. Cross-links navigate between them. |

### Second-round decisions (after sc-craft.tools functional review)

| # | Topic | Decision |
|---|---|---|
| Q1 | Resource navigation | **C - inline only**. Display aggregated ingredient pills on every BP. Click a resource pill → filters list to "BPs requiring this resource". No dedicated Resources sub-tab in v1; that becomes a follow-up once mining-location data lands. |
| Q2 | User-state features (Owned / Fabricator) | **D - skip entirely**. Not in v1. Defer all inventory / wishlist / org-share features. |
| Q3 | Mission type categorization | **I - request from extractor**. Add `MissionType` field on contracts. Until then, fall back to grouping by `Kind` (Contract / ScenarioTier). |

### Functional spec additions from sc-craft.tools review

| Feature | Status |
|---|---|
| Craft time per BP (`Tiers[0].CraftTimeSeconds`) | Locked, §4.1 |
| Aggregated ingredient pills per BP | Locked, §4.1 + new `aggregateIngredients()` helper |
| Resource-pill click → filter | Locked, §4.1 + new `getBPsUsingResource()` reverse index |
| Quality preview slider on BP detail | Locked, §4.3 - reuses `craftingModifiers.js` |
| Standing window (BOTH min + max) | Locked, §4.2 - `formatStanding()` extended |
| Mission description (collapsible) | Locked, §4.2 - info (i) icon click |
| Mission type group header | Locked, §4.2 - colour-coded; depends on Q3 extractor field, falls back to `Kind` |
| Standing reward (rep gained) | Placeholder row only - `-` until extractor ships `StandingReward` |
| Mining locations per resource | Out of v1 (Q1 follow-up) - needs extractor data |

### Design review status

The HTML mockups produced in the first `/plan-design-review` pass
(variant-a.html, variant-c.html in `~/.gstack/projects/ohman74-NovaTools/
designs/blueprints-tab-20260513/`) were rejected by the user. A fresh
design pass should run once the expanded functional spec above is
fully reviewed.

---

## 12. Next steps

1. **Confirm functional spec** (§4.1, §4.2, §4.3 above + §10 follow-ups).
2. **Re-run `/plan-design-review`** with the expanded spec - focus on
   mission card density, ingredient pill colour-coding by UnitType,
   resource-pill click affordance, where the quality slider sits in
   the detail flow.
3. **Lock layout** via design review.
4. **Send extractor asks** (MissionType, StandingReward, mining locations).
5. **Begin Phase 1** once design + extractor schedule are clear.

---

## Review status

- Architecture: locked in this doc (Section 3)
- Functional spec: locked after sc-craft.tools review (Section 4, this revision)
- Design layout: NOT locked - needs second design-review pass
- Code quality: pending implementation
- Tests: covered in Section 6 (extended with new helpers' coverage)
- Performance: pending implementation
- Outside voice: not run
