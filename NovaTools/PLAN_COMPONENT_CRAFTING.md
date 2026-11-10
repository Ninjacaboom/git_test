# Component Crafting - Implementation Plan

Branch: `component-crafting`
Status: **Implemented**. Canonical docs:
- Modifier math + composition + per-port deflection recompute → [FORMULAS.md "Component Crafting"](./FORMULAS.md#component-crafting)
- `blueprints.json` + `resources.json` schemas → [DATA_SOURCES.md](./DATA_SOURCES.md)
- CSS classes + indicator placement + drag-safety + bulk crafting → [UI_GUIDE.md "Component crafting popover"](./UI_GUIDE.md#component-crafting-popover)
- Font Awesome 6 Free Solid setup → [ICONS.md](./ICONS.md)
- Refresh workflow (`update_data.py` after every ZIP refresh) → [CLAUDE.md](./CLAUDE.md)

Kept for historical reference (decision history, scope-deferral list,
phase-by-phase plan). The sections below describe the design that was
shipped; refer to the canonical docs above for current truth.

---

This plan adds per-component material-quality crafting to the Loadout
Manager. A user picks a quality value 0-1000 for each slot of each
component blueprint; computed modifiers flow through the existing stat
pipeline so shield HP, weapon DPS, cooler rating, QD speed, etc. all
react in real time.

References: spviewer.eu and erkul.games crafting UIs. Game data lives
in `data/PTU.zip` (`blueprints.json` + `resources.json`).

---

## 1. Game-data model (confirmed against PTU.zip)

`blueprints.json`: list of 1 537 entries. Of those, 486 target ship items
(types `WeaponGun`, `Cooler`, `PowerPlant`, `Shield`, `Radar`,
`QuantumDrive`, `WeaponMining`, `TractorBeam`, `SalvageModifier`,
`SalvageHead`, `DockingCollar`, `WeaponAttachment`, `Misc`); 438 match
ClassNames in `vehicle_equipment.json`.

```jsonc
{
  "TargetGUID":      "…",                    // UUID of the targeted item
  "TargetClassName": "SHLD_GODI_S01_AllStop_SCItem",
  "TargetName":      "AllStop",
  "TargetType":      "Shield",
  "TargetSize":      1,
  "Tiers": [                                  // always length 1 in current data
    {
      "Slots": [
        {
          "Name":        "FIELD ARRAY",       // canonical slot key
          "DisplayName": "Field Array",       // UI label
          "Costs":     [ { "Type": "Resource", "GUID": "…", "Quantity": 0.24 } ],
          "Modifiers": [
            {
              "GPP":            "GPP_Shield_MaxHealth",
              "PropertyName":   "Max. Shield Strength",
              "QualityRange":   [0,   500],
              "ModifierRange":  [0.9, 1.0]
            },
            {
              "GPP":            "GPP_Shield_MaxHealth",
              "PropertyName":   "Max. Shield Strength",
              "QualityRange":   [501, 1000],
              "ModifierRange":  [1.0, 1.1]
            }
          ]
        }
      ]
    }
  ]
}
```

Quality semantics:
- `quality = 500` → modifier = `1.0` (baseline, no change from `stdItem`)
- `quality < 500` → linear interpolate in `[mod_low, 1.0]` (penalty)
- `quality > 500` → linear interpolate in `[1.0, mod_high]` (bonus)
- One slot may declare multiple modifiers (different `PropertyName` entries)
- **Slots with the same `PropertyName` compose multiplicatively**
  (verified: AllStop Field Array @ q=1000 × Freq Controller @ q=1000 = 1.10 × 1.10 = 1.21 → +21% matches screenshot 3 833 hp from base 3 168 hp)

`resources.json`: 37 entries with `GUID`, `Name`, `UnitType` (SCU/Item),
`Category`, `GroupGUID`. Lookup table only - we display resource names
beside Cost rows; no aggregation across the loadout in v1.

## 2. PropertyName → stat-field mapping (verified against PTU.zip)

Only the **ship-relevant** properties. FPS-only (character armor,
WeaponPersonal) and `Fire Rate` (FPS-only in current PTU data) are
out of scope - listed in §10.

| PropertyName            | TargetType             | stdItem path                                                              |
|-------------------------|------------------------|---------------------------------------------------------------------------|
| `Integrity`             | All                    | `Durability.Health`                                                       |
| `Max. Shield Strength`  | Shield                 | `Shield.Health`                                                           |
| `Coolant Rating`        | Cooler                 | `ResourceNetwork[].Conversion[]` where `Resource:"Coolant"` → `UnitPerSec`|
| `Quantum Speed`         | QuantumDrive           | `QuantumDrive.StandardJump.Speed`                                         |
| `Quantum Fuel Burn`     | QuantumDrive           | `QuantumDrive.StandardJump.QuantumFuelRequirement`                        |
| `Min. Assist Distance`  | Radar                  | `Radar.AimAssist.DistanceMin`                                             |
| `Max. Assist Distance`  | Radar                  | `Radar.AimAssist.DistanceMax`                                             |
| `Beam Force`            | TractorBeam, SalvageHead | `TractorBeam.Tractor[0].MaxForce`                                       |
| `Full Strength Dist.`   | TractorBeam, SalvageHead | `TractorBeam.Tractor[0].FullStrengthDistance`                           |
| `Max. Distance`         | TractorBeam, SalvageHead | `TractorBeam.Tractor[0].MaxDistance`                                    |
| `Max. Volume`           | TractorBeam, SalvageHead | `TractorBeam.Tractor[0].MaxVolume` (cm³, not SCU - currently unsurfaced) |
| `Efficiency`            | SalvageModifier        | `SalvageModifier[0].ExtractionEfficiency`                                 |
| `Radius`                | SalvageModifier        | `SalvageModifier[0].RadiusMultiplier`                                     |
| `Speed`                 | SalvageModifier        | `SalvageModifier[0].SpeedMultiplier`                                      |
| `Impact Force`          | WeaponGun, WeaponMining | `Weapon.Ammunition.ImpactDamage.*` (multiply every sub-field: Energy, Physical, Distortion, …) |

The map lives in a new module `js/craftingModifiers.js` and is the
**single source of truth** for which raw stat each blueprint modifier
touches. Unknown `PropertyName` values are logged once to console and
ignored (graceful degradation if CIG ships new modifiers).

### 2.1 Data-source decision (Decision A)

CIG ships the same crafting modifier data in two places:

- `blueprints.json` - top-level list, human-readable `PropertyName`
  ("Max. Shield Strength"), piecewise 0-500 / 501-1000 ranges.
- `vehicle_equipment.json` → `stdItem.Crafting` - co-located with each
  item, but uses raw GPP tokens (`GPP_Shield_MaxHealth`) and
  `@StatName_GPP_…` localization placeholders.

**Plan uses `blueprints.json`** - the resolved PropertyName strings
avoid maintaining a GPP-to-display map by hand, and the data is already
normalized by CIG.

### 2.2 Extractor-side cleanup (deferred TODO)

Since the modifier data is duplicated, the extractor (NovaSCDataExtractor
sibling project) could strip the `Crafting` block from
`stdItem` in `vehicle_equipment.json` once `blueprints.json` is the
canonical source. Estimated saving: a few MB on `vehicle_equipment.json`
(currently 15 MB raw / 2 MB compressed). Not blocking the plan - flag
in TODOS.md.

## 3. Architecture

### 3.1 Data flow

```
PTU.zip
   │
   ▼
dataLoader.js
   ├─ vehicles, hardpoints, items (existing)
   └─ blueprints, resources  ── NEW
                                  │
                                  ▼
                            blueprintsByClass: Map<className, Blueprint>
                            resourcesByGuid:   Map<guid, Resource>
                                  │
                                  ▼
loadoutState.js
   ├─ currentLoadout:   { portName: className }    (existing)
   ├─ currentCrafting:  { portName: {slotName: qualityValue} }  ── NEW
   │     • absent port  → component uses defaults (all q=500)
   │     • absent slot  → that slot uses q=500
   ├─ persisted in tabs (extended `persistTabs`)
   └─ encoded in share URL (extended `shareUrl` schema)
                                  │
                                  ▼
craftingModifiers.js  ── NEW
   ├─ getCraftingState(portName) → {slotName: qualityValue}
   ├─ computeModifiers(blueprint, craftingState) → Map<PropertyName, modifier>
   ├─ applyModifiers(stdItem, modifiers) → modifiedStdItem (deep, cached)
   └─ propertyNameToPath: Map<PropertyName, (item) → setter/getter>
                                  │
                                  ▼
loadoutManager.js
   getCraftedItemStats(className, portName)
   = applyModifiers(getItemStats(className), computeModifiers(bp, crafting))

   Every read site (calculateStats, weaponColumn, statsPanel) switches
   from getItemStats(cn) to getCraftedItemStats(cn, portName).
                                  │
                                  ▼
statsPanel.js / weaponColumn.js render with already-modified values.
   Inline popover (next section) drives currentCrafting and triggers
   re-render via the existing _renderStats / _renderWeaponColumn /
   _renderSystemsColumn callbacks already wired in loadoutUI.js.
```

### 3.2 The modifier wrapper (single injection point)

```js
// craftingModifiers.js - pseudo-code

export function computeSlotModifier(slot, quality) {
  // Find the modifier whose QualityRange contains `quality` and lerp.
  // Returns Map<PropertyName, number>  (modifier per property at this slot)
}

export function computeBlueprintModifiers(blueprint, craftingState) {
  // For each slot, compute its per-property modifier at its quality.
  // Multiply same-PropertyName entries across slots.
  // Returns Map<PropertyName, finalModifier>
}

export function applyModifiers(stdItem, modifiersByProperty) {
  if (modifiersByProperty.size === 0) return stdItem;        // fast path
  const clone = deepCloneStatPaths(stdItem, AFFECTED_PATHS);  // only clone what we mutate
  for (const [prop, mult] of modifiersByProperty) {
    const setter = PROPERTY_TO_SETTER[prop];
    if (setter) setter(clone, v => v * mult);
  }
  return clone;
}
```

A WeakMap-backed cache (key: `[stdItem, JSON.stringify(modifiers)]`)
short-circuits the rebuild when the same crafting state is read twice in
a render pass.

### 3.3 Why this shape

- **One injection point** (`getCraftedItemStats`): we don't have to find
  and patch every aggregation site for shields, coolers, QDs separately.
  The caller asks for stats, the wrapper returns stats with modifiers
  baked in. Aggregation logic in `calculateStats` is untouched.
- **Immutable**: we never mutate the underlying `stdItem`. Two ports
  with the same className but different quality stay independent.
- **Default = identity**: if `currentCrafting[port]` is missing or every
  slot is q=500, `computeBlueprintModifiers` returns an empty map and
  `applyModifiers` returns the original `stdItem` (fast path, no clone).
- **PropertyName-driven**: extending the system later (new CIG modifier
  type) is a single entry in `PROPERTY_TO_SETTER`.

## 4. State + persistence

### 4.1 Loadout state

```js
// loadoutState.js - additions

export let currentCrafting = {};                    // { port: {slot: q} }
export function setCurrentCrafting(v) { currentCrafting = v; }
export function setPortCrafting(port, slotMap) { … }
export function clearPortCrafting(port) { … }       // called on item swap
```

`selectItemForPort(port, className)` in the existing picker flow must
call `clearPortCrafting(port)` so swapping an item resets quality to
defaults - matches the per-port decision.

### 4.2 Tab persistence

`persistTabs()` already serializes `currentLoadout`, `pipAllocation`,
`shieldOverrides`, `disabledPorts`. Add `currentCrafting` alongside.
Backwards-compat: missing field on existing tabs reads as `{}` (all
defaults).

### 4.3 Share URL

The hash-based share URL needs a compact encoding for crafting state
since URL length matters. Proposed packing:

```
craft=<port>:<slot1>=<q1>,<slot2>=<q2>;<port>:<slot1>=<q1>;…
```

Only non-default (q ≠ 500) values are written. Slot names are emitted
as their canonical `Name` (uppercase, but with `_` replacing spaces for
URL safety: `FIELD_ARRAY`). Decoder normalizes back.

Worst case length: ~30 chars per fully-customized component × ~10
components on a big ship ≈ 300 chars - well within URL limits.

### 4.4 Backwards-compat with existing shared builds

Old share URLs without `craft=` are read as "no crafting" → all
defaults → no behavior change. Existing builds keep working.

## 5. Build-toggle behavior

`blueprints.json` and `resources.json` currently only ship in
`PTU.zip`. Until they land in Live:

- `dataLoader.js` reads both files with the same best-effort try/catch
  pattern already used for `vehicle_metadata.json`. Missing files leave
  `blueprintsByClass` empty.
- Empty blueprint map → the inline popover button (the small "C"
  indicator next to each slot) is **hidden**, and clicks on the slot
  open the regular picker (current behavior).
- No degraded-mode UI message. Cleaner that way, and matches Decision 3
  (option a). When CIG ships data to Live, the feature lights up
  automatically with no code change.

## 6. UI

Initial release: **inline popover** matching screenshots 1-2 / 5-7.

### 6.1 Where it attaches

Every loadout slot row in `weaponColumn.js` (weapons) and
`statsPanel.js` (systems) gets a **clickable indicator** if a blueprint
exists for the installed item. The indicator combines:

- **Icon**: Font Awesome `screwdriver-wrench` (solid) - semantically
  matches "crafting tools"
  (https://fontawesome.com/icons/classic/solid/screwdriver-wrench)
- **Quality badge**: numeric mean across all slots of the component,
  rounded to integer (e.g., AllStop with Shell=756, Field Array=926,
  Frequency Controller=827 → mean 836, matches screenshot 2 top-left)
- Default unmodified component (all slots q=500) shows badge `500`
- Click → opens inline popover on top of the slot row

This requires adding Font Awesome support to the project - see §6.4.

Popover content:

- Header: component name + Class (e.g., "AllStop · Military C")
- Header right: total-quality value (avg of slot qualities, shown as
  number badge - matches screenshot top-left "836")
- Per slot section:
  - Slot label (FIELD ARRAY) + cost ("Gold 0.24 SCU")
  - Slider 0-1000, +/- buttons, numeric input
  - **MAX. SHIELD STRENGTH** header line (the PropertyName)
  - Range cards: `0-500: -10% → +0%` and `501-1000: +0% → +10%`
  - Bottom row: `Base 3168 hp → Crafted 3485 hp (+10%)` (matches
    screenshots 5-7)
- Bottom buttons: `Min quality` / `Reset quality` / `Max quality`

### 6.2 Why inline first

Screenshots 5-7 (which the user supplied for the math) are the inline
variant. They contain everything needed to drive stat changes. The
larger modal in screenshots 3-4 adds:

- Aggregated "Crafted Modifiers" section (Integrity +34.6 / Max. Shield
  Strength +477)
- Global `Item Quality` slider that drives all sub-sliders proportionally
- MIN / DEFAULT / MAX preset buttons
- Per-slot resource cost rollup

Each of those is independent UX value-add, not blocker. v2 promotes the
inline popover to a modal-mode toggle.

### 6.3 Styling

Reuse existing dark-card pattern from `css/styles.css`. New classes:

```
.crafting-popover, .cc-slot, .cc-slider, .cc-range-card,
.cc-range-low, .cc-range-high, .cc-base-crafted, .cc-quality-badge,
.cc-indicator
```

Document in `UI_GUIDE.md`.

### 6.4 Font Awesome setup (one-time, enables future FA icons)

Adding the FA Solid webfont locally - same self-hosted pattern as
`spv-icons`:

1. Drop `fonts/fa-solid-900.woff2` (~80 KB, free tier) into the repo
2. In `css/styles.css` add:
   ```css
   @font-face {
     font-family: "Font Awesome 6 Free";
     font-weight: 900;
     src: url(../fonts/fa-solid-900.woff2) format("woff2");
   }
   .fa-solid, .fas {
     font-family: "Font Awesome 6 Free";
     font-weight: 900;
     font-style: normal;
     -webkit-font-smoothing: antialiased;
   }
   .fa-screwdriver-wrench:before { content: "\f81a"; }
   ```
3. Use as `<i class="fa-solid fa-screwdriver-wrench"></i>`
4. Document the convention in `ICONS.md` alongside `spvi-` so future
   FA icons follow the same pattern (add the `.fa-<name>:before` rule
   per icon as it's needed)

We host only the Solid set in v1. Brands / Regular can be added later
if specific icons require them.

## 7. Module layout

```
js/craftingModifiers.js   NEW  - pure logic, no DOM
js/craftingUI.js          NEW  - popover render + event binding
fonts/fa-solid-900.woff2  NEW  - Font Awesome 6 Free Solid webfont
js/dataLoader.js          edit - read blueprints.json, resources.json
js/loadoutState.js        edit - currentCrafting + setters
js/loadoutManager.js      edit - getCraftedItemStats wrapper
js/statsPanel.js          edit - switch read sites to getCraftedItemStats
js/weaponColumn.js        edit - switch read sites + add craft-indicator
js/loadoutUI.js           edit - wire crafting-popover open / persist hooks
index.html                edit - popover container element (if needed)
css/styles.css            edit - popover styling + FA @font-face
FORMULAS.md               edit - document modifier math
UI_GUIDE.md               edit - document new CSS classes
DATA_SOURCES.md           edit - document blueprints.json + resources.json
ICONS.md                  edit - add FA convention alongside spvi-
```

11 files, 2 new modules, 1 new asset. At the upper edge of the
eng-review complexity budget but each file's change is tightly scoped
to one concern (data load, state, math, render, persist, style, docs,
icon font).

## 8. Implementation phases

Each phase ends with a clean state - tests green, app usable, ready to
ship even if work stops there.

### Phase 1 - Data + math (no UI)
- Add `blueprints.json` + `resources.json` reads to `dataLoader.js`
- Build `blueprintsByClass`, `resourcesByGuid` lookups
- Implement `craftingModifiers.js` (pure module, testable in vitest)
- Unit tests for `computeSlotModifier`, `computeBlueprintModifiers`,
  `applyModifiers` (math correctness, fast-path identity, multiplicative
  composition)
- No UI yet - feature is dark.

### Phase 2 - Wire to stats pipeline
- Add `currentCrafting` to `loadoutState.js` with setters + clear-on-swap
- Add `getCraftedItemStats(className, portName)` to `loadoutManager.js`
- Switch every relevant read site in `statsPanel.js` /
  `weaponColumn.js` / `loadoutManager.js` aggregations to
  `getCraftedItemStats`
- Tests: with empty `currentCrafting`, all existing stats tests pass
  byte-identically (identity invariant)

### Phase 3 - Inline popover UI
- Add `fonts/fa-solid-900.woff2` + `@font-face` rule in `css/styles.css`
  + `.fa-screwdriver-wrench:before` mapping
- Update `ICONS.md` with the FA convention
- `craftingUI.js`: render + event binding
- Slot indicator (FA icon + mean-quality badge) on every applicable
  loadout row
- Sliders + range cards + base/crafted display
- Hook to `setPortCrafting` → triggers existing re-render callbacks
- Visual QA at localhost:8080 in Chrome (per CLAUDE.md)

### Phase 4 - Persistence
- Extend `persistTabs` payload with `currentCrafting`
- Extend share URL schema with compact `craft=…` encoding
- Round-trip tests (encode → decode → encode stable)
- Backwards-compat test: existing share URLs decode without crafting
  field, behavior unchanged

### Phase 5 - Polish + docs
- Build toggle: hide popover indicator on Live (empty blueprint map)
- Update `FORMULAS.md` with modifier math
- Update `DATA_SOURCES.md` with blueprints/resources schema
- Update `UI_GUIDE.md` with new CSS classes
- Update `CLAUDE.md` data-refresh section if any new touchpoints

## 9. Test strategy

| Layer                          | Approach                                                                          |
|--------------------------------|-----------------------------------------------------------------------------------|
| `computeSlotModifier`          | Vitest unit tests - boundary at q=0, 500, 1000 + interior + invalid input         |
| `computeBlueprintModifiers`    | Multi-slot composition test with AllStop (q=1000 each → 1.21 expected)            |
| `applyModifiers` identity      | Empty modifier map returns the input reference (fast path)                        |
| `applyModifiers` immutability  | Input `stdItem` unchanged after call (regression guard)                           |
| `getCraftedItemStats` integration | With `currentCrafting = {}`, `calculateStats(loadout)` outputs match the pre-feature baseline (existing tests stay green) |
| URL encode/decode round-trip   | Vitest - non-default values survive round-trip; defaults are omitted              |
| UI smoke                       | Manual via Chrome MCP at localhost:8080: open popover → drag slider → confirm header value updates → swap component → confirm reset |

Coverage target: 100% of `craftingModifiers.js` lines and branches.
Existing `test/loadoutManager.test.js` extends with one identity-mode
test confirming nothing regresses when feature is dormant.

## 10. NOT in scope (explicitly deferred)

| Item                                    | Why deferred                                                          |
|-----------------------------------------|-----------------------------------------------------------------------|
| Full modal UI (screenshots 3-4)         | Inline popover delivers the math + per-component editing. Modal adds MIN/DEFAULT/MAX presets and total-quality slider - UX polish, not gameplay value |
| Resource cost aggregation across loadout | "What does this whole build cost to craft?" is a different feature  |
| Crafted-modifier totals header          | Sum of all positive/negative modifiers per property - display polish, easy to add once inline ships |
| Per-slot resource cost rollup           | Already shown per-slot. Cross-component aggregation is a follow-up   |
| Craft time display                      | Cosmetic, no impact on stats                                          |
| Item Quality master slider              | Drives all sub-sliders proportionally - modal-mode feature           |
| Live build support before CIG data lands | Decision 3 (a): feature is PTU-only until blueprints reach Live      |
| Character armor + personal weapons      | Not currently displayed in the Loadout Manager                       |
| Tier > 1 support                        | All current blueprints have exactly one tier. Future-proofing isn't needed yet - KISS |
| Predictive stat compare (A/B quality)   | Power-user feature. Defer                                             |

## 11. What already exists (reused, not rebuilt)

- **Per-tab state isolation** - `tabs[].state` carries everything; we
  add one field to the existing payload, no new persistence layer
- **Item lookup** - `itemsByClass` Map in `loadoutManager.js`
- **Render callback wiring** - `_renderStats / _renderWeaponColumn /
  _renderSystemsColumn` from `loadoutUI.js` already trigger on state
  changes; crafting mutations slot in without new plumbing
- **Slot row rendering** - `renderSlot` / `renderWeaponSlot` etc. - we
  add a small indicator, not a new row type
- **CSS dark-card pattern** - popover reuses `.lo-slot` shading vars
- **Share URL hash parser** - extends with one new field

## 12. Failure modes

| Codepath                            | Failure mode                              | Coverage                              |
|-------------------------------------|-------------------------------------------|---------------------------------------|
| `blueprints.json` missing from ZIP  | Build toggle on Live, deliberate          | Test: empty map → indicator hidden    |
| `PropertyName` not in setter map    | Modifier silently ignored                 | Log once; unit test covers logging    |
| Quality value out of [0, 1000]      | Clamped at input boundary                 | Unit test for clamp                   |
| Two ports share same blueprint className, different quality | State per port keeps them independent | Integration test                   |
| Share URL with corrupt `craft=`     | Parse error → fall back to defaults       | Test: malformed string → empty state  |
| `stdItem` mutation by accident      | Wrapper deep-clones touched paths only    | Vitest immutability assertion         |

## 13. Decisions locked

- **Per-port crafting state**, default q=500, reset on item swap
- **Multiplicative composition** across slots sharing a PropertyName
  (verified against screenshot 3 833 hp = 3 168 × 1.10 × 1.10)
- **Live build**: no crafting UI until blueprints land in Live (option a)
- **Inline popover first**, modal deferred to v2
- **Data source**: `blueprints.json` (resolved PropertyName) - not the
  embedded `stdItem.Crafting` (raw GPP tokens)
- **Indicator**: `fa-screwdriver-wrench` + mean-quality badge
- **Font Awesome 6 Free Solid** added in Phase 3 (~80 KB woff2)

## 14. Open follow-ups (not blockers)

- **Extractor-side cleanup**: strip `stdItem.Crafting` from
  `vehicle_equipment.json` since it duplicates `blueprints.json`. Saves
  a few MB. Add to TODOS.md.
- **Surface `MaxVolume` and `AimAssist.Distance{Min,Max}` in UI** -
  the modifiers exist in PTU data but the underlying stats aren't
  currently rendered in the Loadout Manager. Either surface them so
  the crafting effect is visible, or hide them from the popover until
  there's a destination to display.

---

## Review status

To be filled by `/plan-eng-review` after first pass:

- Architecture: pending
- Code quality: pending
- Tests: pending
- Performance: pending
- Outside voice: pending
