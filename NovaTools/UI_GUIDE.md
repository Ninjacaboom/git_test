# Nova Tools - UI Styling Guide

## Section Headers

All section headers must follow the same pattern. The reference implementation is `.lo-section-header`.

### CSS Rules

```css
/* Container */
display: flex;
justify-content: space-between;
align-items: center;
padding: 10px 14px;
background: var(--bg3);          /* #1a2238 */
border-bottom: 1px solid var(--border);

/* Text */
font-size: .8rem;
color: var(--gold);              /* #ffc107 */
text-transform: uppercase;
letter-spacing: 1px;
font-weight: 600;

/* Icon inside header */
font-size: 1.1rem;
vertical-align: middle;
margin-right: 3px;
```

### Usage Pattern

```html
<h3><i class="spvi-{icon}"></i> Header Text</h3>
```

### Icon Alignment Rule (applies to ALL headers)

Every header that contains an `<i>` icon - section headers, the Ship Details
banner header, and expanded overlay sub-headers - **must** align the icon
with these three properties on the `<i>` element:

```css
font-size: 1.1rem;
vertical-align: middle;
margin-right: 3px;
```

The heading element (`h3`, `h4`, etc.) must **not** use `display: flex` for
icon alignment. Flexbox on the heading breaks `vertical-align` and produces
misaligned icons. Use flexbox only on the outer container (e.g.
`.lo-section-header`, `.stats-banner-header`) for spacing between the title
and sibling elements like buttons.

### Elements Using This Pattern

| Element | CSS Class | Icon |
|---|---|---|
| Shields section | `.lo-section-header` | `spvi-icon_common_generator_shield` |
| Power Plants section | `.lo-section-header` | `spvi-powerplant` |
| Coolers section | `.lo-section-header` | `spvi-icon_common_coolant` |
| Quantum Drive section | `.lo-section-header` | `spvi-icon_common_quantum` |
| Radar section | `.lo-section-header` | `spvi-icon_common_radar` |
| Life Support section | `.lo-section-header` | `spvi-icon_common_life_support` |
| Thrusters section | `.lo-section-header` | `spvi-Engineering_Icon_ItemThrusters` |
| Weapons section | `.lo-section-header` | `spvi-weapon` |
| Turrets section | `.lo-section-header` | `spvi-Engineering_Icon_ItemTurret` |
| Missiles section | `.lo-section-header` | `spvi-missile` |
| EMP section | `.lo-section-header` | `spvi-icon_common_EMP` |
| QED section | `.lo-section-header` | `spvi-icon_common_QED` |
| Mining section | `.lo-section-header` | `spvi-icon_common_mining` |
| Salvage section | `.lo-section-header` | `spvi-salvage` |
| Flight Blade section | `.lo-section-header` | `spvi-Engineering_Icon_ItemThrusters` |

## Section summary rows (Salvage)

The Salvage section header is followed by 1-3 `.lo-summary-row` rows showing
aggregated stats:

- **Storage Buffer** - `spvi-icon_common_3D_cargo_boxes` icon, value in SCU
- **Modifiers** - `spvi-salvage` icon, scaled Speed (`x`) / Radius (`m`) / Efficiency (`x`)
- **Salvage Rate** - `spvi-icon_common_warning_overheat` icon, value in `/min`

CSS: `.lo-summary-row` is a flex row with bg3 background, cyan label/value text,
and a gold-tinted border-bottom. Defined in `css/styles.css` next to
`.lo-stat-stack`. Used only by `renderSalvageSummary` in `js/statsPanel.js`.

## Auxiliary pip channels (Interdiction / Mining / Salvage)

Three new pip channels appear in the Power Distribution panel between the
`utility` channel and `radar`, only when the ship has the corresponding
hardpoints installed:

- `interdiction` (label `INT`) - EMP + QED items
- `mining` (label `MIN`) - mining hardpoint sub-ports
- `salvage` (label `SLV`) - salvage hardpoint sub-ports

All three default to `allocated: 0` (unpowered) - the user opts in via the pip
panel. Their EM scales linearly with `allocated / max` rather than through
PowerRanges, because the underlying items declare `RegisterRange = false`.

PIP_ICONS keys (`js/loadoutState.js`):
- `interdiction` → `spvi-icon_common_EMP`
- `mining` → `spvi-icon_common_mining`
- `salvage` → `spvi-salvage`
| Power Distribution | `.pip-header` | `spvi-electric` |
| Confirm dialog | `.lo-confirm-header` | (none currently) |
| Component picker | `.lo-picker-header` | (none currently) |

Note: the old `.lo-stats-card` (right-column Ship Stats panel) and
`.lo-settings-card` (Display Settings with the Burst/Sust toggle) have
been removed. Stats now live in the collapsible Ship Stats banner at
the top of the workspace (see "Ship Stats banner" below), and the
Burst/Sust DPS mode toggle is injected into the Weapons section header
by `injectWeaponCapBadge` in `statsPanel.js`.

## Top row - Power Distribution + Ship Stats banner

Above the main loadout grid, `#loTopRow` is a flex row wrapping two siblings
that share the same horizontal band:

- `#loPipMount` (content-sized, left) - the Power Distribution strip. Pip
  channels run horizontally, with cooling bar + EM/IR/CS signatures as a
  sidebar on the right of the card.
- `#loStatsBanner` (fills remainder, right) - the collapsible Ship Stats
  banner. See below.

Both are rendered from `renderStats()` in `js/statsPanel.js`. The pip card
html comes from `renderPipPanel()` and is post-processed to move cooling
and signatures from their stacked default position into a
`.pip-body-row` sidebar beside the channel columns.

The old 3-column main grid (weapons / systems / stats) is now
`grid-template-columns: 1fr 1fr` because the stats column moved into the
banner.

On narrow viewports (≤1100 px) the top row stacks vertically so the pip
card and banner don't squish into unreadable widths.

## Ship Stats banner

Rendered into `#loStatsBanner` by `renderStats()` as a `.ship-stats-banner`
wrapper containing:

1. **`.stats-banner-header`** - always-visible header bar at the top
   with a "Ship Details" gold title on the left (via `spvi-standard_control`)
   and a "Details ▼" toggle button (`.stats-tag-btn`) on the right.
2. **`.stats-collapsed`** - the compact row of grouped stat cells.
3. **`.stats-expanded`** - the absolutely-positioned drop-down detail
   overlay (hidden until toggled).

### Collapsed strip - 5 cells × 3-5 rows, label-first

`.stats-collapsed` renders 5 `.stats-group-cell` children separated by
vertical `.stats-sep` dividers, with `flex-wrap: nowrap` so cells never
drop to a second row. Cells are content-sized (`flex: 1 1 auto`) and
no longer carry per-cell icons - the single "Ship Details" icon in the
header bar is enough visual anchoring.

Each `.g-row` is a three-part flex row with the **label on the left**
and the value group pushed right via `margin-left: auto`:

```html
<div class="g-row">
  <span class="g-label">Pilot</span>
  <span class="g-val-wrap">
    <span class="g-val cyan">1 559</span>
    <span class="g-unit">DPS</span>
  </span>
</div>
```

Primitives:
- `.g-label` - category word (`Pilot`, `Turret`, `Shield`, `Deflection`,
  `SCM/Boost`, etc.) in muted text on the left
- `.g-val-wrap` - right-aligned container for one or more value groups
- `.g-val` - primary number (carries `.cyan`, `.red`, `.green`, or
  `.dim` modifier classes)
- `.g-unit` - unit after the value (HP, DPS, m/s, kg, °/s, %, SCU, DMG,
  ...). No `text-transform` - write units in correct casing directly.
  Acronyms uppercase (DPS, HP, SCU, DMG, MN), SI units lowercase
  (m/s, kg, °/s, m, Gm, km/s)
- `.g-sep` - compound-value separator (`/`, `×`) between multiple
  value groups inside the same row (e.g. "50 phys / 45 energy")

Every abbreviation carries a `title=` attribute from the `ABBR` tooltip
map at the top of `renderStats()`, so hovering any tight label reveals
the full term.

**Cell layout (left → right):**

| Cell | Rows |
|---|---|
| **Offense** | `Pilot` DPS · `Turret` DPS · `Missile` DMG · `Bomb` DMG |
| **Shield** | `Shield` HP · `Ballistic` % · `Energy` % · `Distortion` % |
| **Armor** | `Armor` HP · `Deflection` phys/energy · `Physical dur` % · `Energy dur` % |
| **Hull** | `Hull` HP · `Mass` kg · `Cargo` SCU · `Storage` K μSCU |
| **Flight** | `SCM/Boost` m/s · `Nav` m/s · `P/Y/R` °/s · `Boosted` °/s |

Shield resistance and armor durability rows colour by sign:
- Positive armor resistance (less damage taken) / positive shield
  resistance → **cyan**
- Negative (more damage taken / shield vulnerability) → **red**
- Zero → default text colour

Rows with no data render as a dim em-dash so the row grid stays
aligned across cells. The Offense cell's Bomb row dims on ships
without bomb payloads, the Shield rows dim when `stats.shieldCount === 0`,
and the Flight Nav / P·Y·R rows dim on ships that don't expose those
flight characteristics.

### Expanded detail overlay

When the header's "Details ▼" button is clicked, `.stats-expanded`
transitions in as an absolutely-positioned drop-down anchored to the
bottom edge of the banner (`top: 100%`). It sits above the pip card
and the main loadout grid at `z-index: 60` - the workspace below does
NOT shift. Click outside the banner or press Escape to dismiss.

Layout is a 3-column grid `.stats-grid-3col`:

- **Hull** (with nested `h4.h4-sub` `Carrying Capacity` block) -
  dimensions, mass, total HP, vital parts, damage / signature /
  penetration modifiers, then Cargo Grid (SCU) and Storage (K μSCU).
  Storage is converted from the raw `Cargo.Storage` SCU value by
  multiplying by 1000 to give a whole-K-μSCU readout.
- **Weaponry** (with nested `Shields` and `Armor` blocks) - pilot DPS +
  per-type breakdown (Ballistic / Energy / Distortion), turret DPS +
  same breakdown, missile damage, bomb damage, shield HP / regen /
  charge / resistance, then armor HP / deflection / durability damage
  modifiers.
- **Flight Performance** (with nested `Fuel` and `Insurance` blocks) -
  SCM / boost, NAV, angular velocity (pitch / yaw / roll with boosted
  variants), then fuel (Hydrogen + Quantum capacities in M / SCU, plus
  QD range in GM computed from the equipped QD's `MicroUnitPerSec`
  consumption rate and the ship's `QuantumFuelTanks.TotalQuantumFuelCapacity`),
  then insurance (Standard → Expedited claim times formatted as
  "XXm YYs", plus expedite cost in aUEC).

All `h4` headers share the same cyan + solid-underline style -
the nested `.h4-sub` headers differ only by added top margin.

### Icons used in the overlay sub-sections

| Section | Icon class | Codepoint |
|---|---|---|
| Hull | `spvi-shield` | `\ea2f` |
| Carrying Capacity | `spvi-icon_common_3D_cargo_boxes` | `\ea71` |
| Weaponry | `spvi-weapon` | `\ea41` |
| Shields | `spvi-icon_common_generator_shield` | `\ea60` |
| Armor | `spvi-Engineering_Icon_ItemShields` | `\ea6f` |
| Flight Performance | `spvi-standard_control` | `\ea7a` |
| Fuel | `spvi-fuelpump` | `\ea10` |
| Insurance | `spvi-insurance` | `\ea17` |

### Vital Parts name humanization

Raw `VitalParts` keys in the game data come from the ship model's asset
pipeline and are inconsistent (`geo_body`, `M_Body`, `body_mesh`,
`aegs_escape_pod_exterior`, `wing_base_left`, ...). The
`humanizeVitalPartName()` helper in `js/statsPanel.js` runs each key
through a 4-step pipeline before rendering:

1. Strip asset-engine prefixes: `geo_`, `dmg_`, `mesh_`, `aegs_`, `M_`
2. Strip cosmetic suffixes: `_geo`, `_mesh`, `_main`, `_exterior`
3. Extract trailing directional marker (`left`/`right`/`front`/
   `back`/`rear`) as a parenthesized qualifier (`back` → `Rear`)
4. Split on underscores and Title Case each word

Covered by unit tests in `test/statsPanel.test.js`.

### Stat row colour convention

`±%` modifier rows colour by **whether the value is good or bad for the
ship's owner**, consistently across the whole app:

- **Green** (`var(--green-soft)`) when it benefits the owner - less damage
  taken, more resistance, smaller signature, less incoming penetration.
- **Red** (`var(--red)`) when it's worse for the owner - more damage taken,
  bigger signature.
- **Neutral (0% / no effect)** has no colour class - it stays the default
  white/`--text`.

This applies to every `±%` modifier row everywhere - collapsed Ship Details
strip, expanded overlay (Hull / Damage / Signature / Penetration /
Resistance / Durability), and the Deflection Calculator mitigation table.
Implemented via the sign-based ternaries in `statsPanel.js` (fmtModPct,
resClass, the durability helper, the expanded shield-resistance rows) and
`deflectionCalcUI.js` (pcell / sign); each picks `green` for the good sign,
`red` for the bad, and no class for neutral.

Note this is the **owner-benefit** axis. Cyan stays the app's plain value
colour (HP, DPS, cargo - emphasis, not good/bad), and green's other use
(full power/pip bars) reads the same way: green = good.

The hull damage modifiers come from `Armor.DamageMultipliers` (top-level),
distinct from `Armor.Durability.DamageMultipliers` used by the Armor
block - see `FORMULAS.md` "Armor and Hull Stats".

## Section header consistency

All `.lo-section` headers (WEAPONS, TURRETS, MISSILES, SHIELDS, POWER
PLANTS, COOLERS, QUANTUM DRIVE, RADAR, LIFE SUPPORT, THRUSTERS, SALVAGE,
etc.) render with the same gold uppercase style via `.lo-section-header
h3`. No per-section muting - every system is equally swappable through
the picker and should read as an interactive section.

An earlier iteration added a `.reference` modifier class that rendered
Coolers / Radar / Life Support with smaller grey headers to de-emphasize
"set-and-forget" sections. That was a UX bad-call - the muting wrongly
implied "read-only" when the rows are fully editable. The modifier was
removed and all sections now share the same header treatment.

## Buttons

### Standard Button (default for all new buttons)

Reference: `.lo-picker-empty` ("Leave empty" button in component pickers)

```css
background: var(--bg3);
border: 1px solid var(--border);
border-radius: 4px;
color: var(--text2);
padding: 6px 14px;
cursor: pointer;
font-size: .82rem;
white-space: nowrap;
transition: all .15s;
```

Hover state:
```css
border-color: var(--cyan);
color: var(--cyan);
```

### Reset Button (exception)

Small inline reset buttons use their own lighter styling and are fine as-is.

### Button Icons

Same alignment rules as headers:
```css
font-size: 1.1rem;
vertical-align: middle;
margin-right: 3px;
```

## Color Variables

All colors are defined as CSS custom properties in `:root` at the top of `styles.css`. **No hardcoded hex/rgba values should appear outside of `:root`.**

### Core Palette
```css
--bg:       #0a0e1a   /* Page background */
--bg2:      #111827   /* Panel/card background */
--bg3:      #1a2238   /* Header bars, input backgrounds, button backgrounds */
--bg-dark:  #0d1525   /* Header gradient dark end */
--cyan:     #00e5ff   /* Active/selected state, hover highlights */
--gold:     #ffc107   /* Section header text, partial power bar */
--orange:   #ffa726   /* Warnings; aliased as the Heavy Fighter deflection tier */
--text:     #e0e6ed   /* Primary text */
--text2:    #8899aa   /* Secondary/muted text, button text */
--text3:    #666      /* Disabled/placeholder text */
--text4:    #555      /* Tab close buttons */
--text5:    #444      /* Drag handles */
--border:   #1e3050   /* All borders */
--red:      #ff4d6a   /* Negative values, delete actions */
--red-soft: #e04040   /* Softer red for stat values */
--green:    #00e676   /* Positive values, full power bar */
--green-soft: #40c040 /* Softer green for active toggles */
```

### Transparency Variants
```css
--cyan-04/06/08       /* Cyan at 4%/6%/8% opacity (hover, selection, active bg) */
--red-bg / --green-bg / --orange-bg  /* 10-12% opacity backgrounds for banners */
--pip / --pip-border   /* Pip block active colors (#e8871e / #c06a10) */
--pip-bg-15/30/35      /* Pip hover/available states */
--pip-shield / --pip-shield-border  /* Shield pip colors */
--overlay              /* Modal backdrop rgba(0,0,0,.6) */
--hover-bg             /* Subtle hover rgba(255,255,255,.03) */
```

### Deflection tier ramp
```css
--defl-none: #5a6473       /* Beats nothing */
--defl-lf:   var(--red)    /* Light Fighter    #ff4d6a */
--defl-mf:   #ff7a3d       /* Medium Fighter */
--defl-hf:   var(--orange) /* Heavy Fighter    #ffa726 */
--defl-gs:   #ffd740       /* Gunship */
--defl-hg:   #b8e356       /* Heavy Gunship */
--defl-sc:   var(--green)  /* Sub Capital      #00e676 */
--defl-cp:   #40c4ff       /* Capital - deliberately not --cyan, which reads as "selected" */
```
Ordered ramp, so hue AND lightness both climb with the tier. See "Immune ships
tooltip" below for the classes that consume these.

## Dialogs

Every modal dialog in the app shares one frame and one set of typographic
conventions. New dialogs MUST follow these rules so the experience stays
consistent across Materials, Deflection, Save/Load loadout, Confirm,
and anything we add later. Examples to crib from: `js/craftingSummaryUI.js`,
`js/deflectionCalcUI.js`.

### Frame

- Overlay: `<div class="lo-build-dialog">` - fixed, full-screen, dark backdrop
- Panel: `<div class="lo-build-dialog-panel lo-build-wide">` for the standard
  560 px width. Background `var(--bg2)`, solid border, drop shadow inherited
- Close button: `&times;` character via `.lo-build-dialog-close`,
  text colour, cyan on hover

### Header (top bar of the dialog)

```html
<div class="lo-build-dialog-header">
  <h3><i class="fa-solid fa-wrench"></i> Crafting Summary</h3>
  <button class="lo-build-dialog-close" aria-label="Close">&times;</button>
</div>
```

Rules:

- **Title text is the feature name only**. Do NOT append the active ship
  name (e.g. `Crafting Summary - Aegis Sabre Firebird`). The current ship
  is already visible in the loadout panel behind the overlay; repeating it
  is noise and forces a layout shift when the name is long.
- Title renders as gold uppercase via `.lo-build-dialog-header h3`
  (same `.8rem`, letter-spacing 1px, font-weight 600 as section headers).
- Icon is REQUIRED. Use an `<i>` element. Prefer `spvi-*` icons when the
  concept has a SPViewer glyph (shield, weapon, missile, etc); fall back
  to FA (`fa-wrench`, `fa-circle-info`, etc) when there isn't a match.
- Icon size follows the same rule as section headers: `font-size: 1.1rem;
  vertical-align: middle; margin-right: 3px`. The header `<h3>` must NOT
  use `display: flex` - flex on the heading breaks `vertical-align`.

### Section headers inside a dialog

When a dialog has internal sub-sections (e.g. "Total Resources" in
Crafting Summary, "My loadout" in Deflection Calculator), reuse the
exact section header pattern from the main loadout panel:

```html
<div class="lo-section-header">
  <h3><i class="spvi-weapon"></i> My loadout</h3>
</div>
```

The `.lo-section-header h3` rule applies gold uppercase + letter-spacing.
Icon is required (same as the main UI - see "Section Headers" above).

### Field labels (form labels above a control)

Sentence case, muted text. NO uppercase, NO letter-spacing, NO `<label>`
element (the generic `label{}` rule on line ~119 of styles.css would
force uppercase via inheritance).

```html
<div class="defl-field">
  <span class="defl-field-label">Opponent vehicle</span>
  <div class="ms-toggle">...</div>
</div>
```

The right reading is "this is metadata for the input below", not "this
is a section heading". Section headings already have a strong gold
treatment, so field labels stay quiet.

### Inline labels in compact data rows

Same rule: sentence case, muted. The deflection per-weapon chain reads
`Shield 6.4 -> Armor DEFLECTED -> Vital 0.0` and the ammo line reads
`Shield 144  Armor inf  Vital inf`. Status flags inside a value cell
(`DEFLECTED`) keep their existing uppercase treatment because they're
emphatic state markers, not labels.

### Table column headers inside a dialog

Use the picker-table convention: gold uppercase via `.defl-mitig-table th`
or `.lo-picker-table th` (whichever matches the table type). `.68-.72rem`,
letter-spacing `.5px`, gold. This is the only place inside a dialog where
small uppercase text is appropriate beyond the dialog header.

### Action buttons inside a dialog

- Primary action: standard button (`.lo-build-save-btn` or the
  `.lo-picker-empty` standard style)
- Inline reset / select-all / minor toggles: `.lo-reset` style
  (`.65rem` muted uppercase, no background)

### Checkboxes (app-wide)

All in-app checkboxes - Crafting Summary, Deflection Calculator's
"Apply armor durability", any future form - use the reusable
`.app-check` class on the native `<input type="checkbox">`. It
renders as a 14 px square with a `var(--border)` outline; when
checked the border + background turn cyan and a cyan checkmark
glyph fills the box.

```html
<input type="checkbox" class="app-check">
```

The native input stays in the DOM so existing JS that reads `.checked`
keeps working - only the appearance is custom. Visually it mirrors the
`.ms-option::before` checkmark used in multi-select dropdowns so the
two checkbox patterns in the app read as one family.

Do NOT use `accent-color: var(--cyan)` directly on `<input>` elements -
that produces the inconsistent browser-default checkbox visual the
`.app-check` class was introduced to replace.

### Sliders (app-wide)

Every range input renders as a 4 px `var(--bg-dark)` rail with a 14 px
cyan thumb ringed in `var(--bg2)`. The visual is shared between
`.cc-slider`, `.defl-slider` and any future slider via the `.app-slider`
class - all three names map to the same `-webkit-slider-thumb` and
`-moz-range-thumb` styling so the user sees one slider design across
the whole app.

```html
<input type="range" class="app-slider" min="0" max="100" value="50">
```

Existing aliases (`.cc-slider`, `.defl-slider`) are kept because the
surrounding layout still references them, but they are visually
identical to `.app-slider` and new code should reach for the generic
class. Do NOT use `accent-color: var(--cyan)` on the bare `<input>` -
that produces the browser-default rail with a cyan fill on the left
of the thumb, which doesn't match the polished thumb-on-rail look the
rest of the app uses. The custom thumb pattern is the standard.

Green thumbs are never correct - that colour is reserved for the
power-distribution feedback bar and the pip-allocation green-soft
toggle state.

### What NOT to do

- Don't put the active ship name in the header title
- Don't write field labels in `text-transform: uppercase`
- Don't use `<label>` for non-form text that should stay sentence case
- Don't introduce custom `.xyz-*` classes when an existing main-UI
  pattern (`.lo-section-header`, `.ms-toggle`, `.lo-name`, `.lo-count`,
  `.lo-slot`) already covers the use case
- Don't use em dashes (`-` is the project convention - see
  `feedback_no_em_dash.md` in personal memory)
- Don't mix FA and `spvi-*` icons in the same row - pick whichever
  family the surrounding section already uses

## Component Picker Tables

- Use `.lo-picker-table` class
- Header row: gold uppercase text
- Body rows: cursor pointer, bg3 on hover
- Current/selected item: cyan left border, subtle cyan background
- Loot-only items: `opacity: .45` via the `.loot-only` class (driven by
  `sold === 0` in `data/sold_status.json` via `mergeSoldStatus()`)

### Category grouping for multi-type ports

Some ship hardpoints accept more than one item category in a single slot
(e.g. Anvil Super Hornet Mk II center: `Types: ["Turret.BallTurret",
"Module"]` - the port swaps between a ball turret and a cargo module).
When `openPicker()` detects more than one category with rows, it renders
a `.lo-picker-group-header` `<tr>` above each category's first row with
a gold uppercase label ("Turrets", "Modules", "Weapons", "Missile Racks",
etc.). Categories appear in the order they're declared in the port's
`Types` array so primary intent wins.

Styling:

```css
.lo-picker-group-header td {
  color: var(--gold);
  font-size: .72rem;
  text-transform: uppercase;
  letter-spacing: 1px;
  font-weight: 600;
  padding: 10px 14px 6px;
  background: var(--bg3);
}
```

### Deprecated-item blocklist

`js/weaponColumn.js` keeps a hand-curated `DEPRECATED_ITEMS` Set at the
top of the file. `openPicker()` filters every class in the set out of
the compatible list before rendering. See `DATA_SOURCES.md → Deprecated
items blocklist` for the criteria an entry must meet before being added,
the current list, and the TODO for replacing it with a data-driven flag
once SPViewer exposes deprecation info.

## Burst / Sustained DPS mode toggle

Lives in the Weapons section header next to the power efficiency bar.
Injected by `injectWeaponCapBadge()` in `js/statsPanel.js` as a
`.lo-weapon-dpsmode` span containing two `.lo-dpsmode-btn` buttons.
Replaces the old standalone Display Settings card, which has been
removed.

```css
.lo-weapon-dpsmode {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
  height: 22px;
}
.lo-weapon-dpsmode .lo-dpsmode-btn.active {
  background: var(--cyan);
  color: var(--bg);
}
```

The selected mode is persisted to `localStorage` key `sc-dps-mode` and
read back by `loadoutState.js` at module init.

## Storage module short-circuit

When a hardpoint slot is swapped for a storage module (Stor*All Big Box,
Retaliator Cargo Module, Apollo Module, etc.) whose only sub-ports are
all `Cargo`-typed, `renderWeaponSlot()` renders the module as a single
leaf row with the total SCU capacity inline as the right-side stat -
same visual language as `45 dps` on a weapon or `243 000 hp` on a
shield.

The detection is `slot.ports.every(sub => sub has at least one type AND
every type is Cargo or Cargo.*)`. The "at least one type" half matters:
`[].every()` is true, so a turret whose gimbal ports carry Tags but no Types
would otherwise count as a storage module and render with its guns hidden.
The check is also guarded against item models with cosmetic DoorPart /
SeatPart / DisplayPart / LightPart / DecalPart ports. Those cosmetic
ports are filtered out during `rebuildSlotPorts()` via an
`isLoadoutPort()` helper - without it, a Stor*All Big Box would show
13 phantom sub-rows for its door machinery (control panels, charge
handles, close buttons, proximity sensors, light groups, decals).

## Confirm Dialog

Reusable confirmation overlay for destructive actions (e.g., deleting loadouts).

- `.lo-confirm-overlay` - fixed full-screen overlay (same as `.lo-build-dialog`)
- `.lo-confirm-panel` - centered panel with `background: var(--bg2)`
- `.lo-confirm-header` - uses section header pattern
- `.lo-confirm-ok` / `.lo-confirm-cancel` - action buttons

## Build Dropdown (Inline Loadout Save/Load)

Inline dropdown bar in the ship selector row, replacing the old all-ships dialog.

- `.lo-build-bar` - container row
- `.lo-build-dropdown` - input + dropdown list wrapper
- `#loadoutNameInput` - text input for build name / dropdown trigger
- `#loadoutList` - dropdown list, toggled via `.open` class
- `.lo-build-list-item` - list row, `.selected` for active build
- `.lo-build-item-delete` - delete button (× character), visible on hover
- `#loadoutSaveBtn` - "Save" or "Update" depending on whether name exists

## Weapon Power Bar

Power efficiency bar + percentage in the WEAPONS section header, showing how well current pip allocation meets weapon energy demand.

- `.lo-weapon-power` - flex container with bar + label, `margin-left: auto`
- `.lo-weapon-power.full` - green bar/text (100% efficiency, pips ≥ needed)
- `.lo-weapon-power.partial` - gold bar/text (under-powered, pips < needed)
- `.lo-weapon-power.off` - empty bar, muted text (0 pips allocated)
- `.lo-wpn-bar` - 80×6px track, `var(--bg)` background
- `.lo-wpn-bar-fill` - animated fill, color set by state class

Tooltip shows raw values: "Weapon power: X needed / Y assigned"

Injected via `injectWeaponCapBadge()`, called from both `renderStats()` and `renderWeaponColumn()` to survive column re-renders.

## Power Toggle Button

Per-shield power toggle in the shield section.

```css
.lo-power-toggle {
  /* Standard button base */
}
.lo-power-toggle.active {
  color: var(--green-soft);
  text-shadow: 0 0 6px var(--green-soft);
}
```

## Pip States

- `.pip-block.unpowerable` - shields that cannot receive power (faded, non-clickable)
- `.pip-column.powered-off` - channel with 0 pips allocated (dimmed icons and blocks)

## Weapon Picker Filters

The weapon picker has a filter row (`.lo-picker-filters`) with:
- Multi-select size dropdown
- Multi-select type dropdown (`.ms-wrap`, `min-width: 220px`)
- Min/Max speed number inputs

## Tabs (Quick-Switch Workspaces)

Dynamic tabs for switching between multiple ship configurations without losing state. Session-persisted to localStorage (`sc-tabs`).

- `.lo-tab-bar` - flex row with `flex-wrap: wrap`, above the ship selector
- `.lo-tab` - individual tab button, `draggable` for reordering
- `.lo-tab.active` - cyan bottom border, brighter text
- `.lo-tab-close` - × button, visible on hover, hidden when only 1 tab
- `.lo-tab-add` - + button to create new tab
- `.lo-tab.dragging` - faded opacity during drag
- `.lo-tab.drag-over-left` / `.drag-over-right` - cyan inset shadow showing drop position

Each tab stores: `shipName`, `loadout`, `pips`, `shields`, `loadoutName`.

## Section Drag-and-Drop Reordering

Component sections (Weapons, Turrets, Missiles, Shields, etc.) can be reordered via drag and drop, including across columns (left ↔ right).

- `.lo-drag-handle` - `spvi-drag_indicator` icon in each section header, grab cursor, initiates drag
- `.lo-section[data-section-key]` - section wrapper with key for order tracking
- `.lo-section.dragging` - faded opacity during drag
- `.lo-section.drag-over-top` / `.drag-over-bottom` - cyan inset shadow showing drop position

Order stored in `sectionOrder` array of `{ key, col }` entries where `col` is `'left'` or `'right'`. Persisted to localStorage (`sc-section-order`). New sections from game updates are appended to the end automatically.

## Tooltips

All tooltips use `data-tip` attributes (not `title`) with a CSS `::after`
pseudo-element for styling. No browser default tooltips appear anywhere.

```css
[data-tip]:hover::after { /* dark bg, border, rounded, .72rem, z-index:999 */ }
```

**Wording convention:** Keep tooltips short - sentence-case, no trailing
period. Acronyms stay uppercase (DPS, HP, SCU). Don't repeat what's
already visible (e.g. "Pilot weapons" not "Pilot-controlled pilot weapons").

### Immune ships tooltip (`.defl-tip`)

Deflection tier markers - the slot dots (`.defl-dot-immune`) and the picker
badges (`.defl-badge`) - show which ships are immune to that weapon on hover.
The tooltip is a real DOM element appended to `document.body` with
`position: fixed` (escapes all stacking contexts). Auto-flips below the marker
when there isn't enough space above, and clamps horizontally to the viewport.

Every tier except the top one (`cp`, "Capital") carries a tooltip; at the top
tier no ship is immune, so `data-immune` is absent and no listener binds.
`cursor: help` follows `data-immune` for the same reason.

Multi-column layout based on count: 1 column for ≤ 8 ships, 2 for ≤ 20,
3 for 20+. Uses the expanded Ship Details shadow style. Names are ordered
toughest-first on the deflection that applies to the weapon (see
[FORMULAS.md](./FORMULAS.md)), not alphabetically, so the columns read top-down
from the hardest target to the softest.

Created by `bindImmuneDotTooltips()` in `js/weaponColumn.js` - called
by both `bindSlotClicks()` (weapon slots) and `renderRows()` (picker). It
selects on `[data-immune]`, so it picks up dots and badges alike.

### Deflection tier ramp

Eight steps from grey through red to blue, one CSS variable each
(`--defl-none` ... `--defl-cp`) and one background class each
(`.defl-tier-none` ... `.defl-tier-cp`). Ordering carries the meaning: the
further along the ramp, the tougher the ships a weapon still damages. See
"Weapon Deflection Tiers" in [FORMULAS.md](./FORMULAS.md) for what each step
means and where the thresholds come from.

Three steps reuse existing palette entries (`--defl-lf` = `--red`,
`--defl-hf` = `--orange`, `--defl-sc` = `--green`); the rest are new. Nothing
sets these colours inline - the class is what carries the colour, in all three
surfaces below.

| Surface | Marker |
|---|---|
| Weapon slot (`.lo-name`) | `.defl-dot.defl-dot-immune.defl-tier-<key>` - 0.5em dot |
| Weapon picker `Defl` column | `.defl-badge.defl-tier-<key>` - two-letter badge (LF/MF/HF/GS/HG/SC/CP) plus `.defl-count` |
| Weapon Deflection tab | `.weapon-item.tier-<key>` - 3px `border-left`, plus the `.legend` dot row |

The picker spells the tier out because eight ramp colours are more than a 0.5em
dot can carry. Badge ink is `var(--bg)` on every step except `none`, whose grey
is too dark for it and uses `var(--text)`.

## Unit casing convention

Units follow standard notation - no `text-transform` on `.g-unit` or `.mini`:

- **Acronyms uppercase**: DPS, HP, DMG, SCU, MN
- **SI / measurement lowercase**: m/s, kg, °/s, m, Gm, km/s
- **Descriptive lowercase**: phys, energy, pw, cool
- **Mixed**: K μSCU, aUEC

## Component crafting popover

The crafting indicator + inline popover live on every loadout slot row
whose installed item has a blueprint. CSS classes (all in
`css/styles.css`, grouped under the "Component crafting" comment):

| Class | Purpose |
|---|---|
| `.cc-indicator` | The clickable badge on the slot row (FA wrench + mean-quality number). Asymmetric `padding: 3px 6px 1px` compensates for the digit baseline sitting near the line-box bottom. |
| `.cc-indicator.cc-deviating` | Highlighted (cyan) state when the port's mean quality ≠ 500. |
| `.cc-quality-badge` | Numeric mean inside the indicator (`font-variant-numeric: tabular-nums`). |
| `.crafting-popover` | Floating popover, body-attached, `position: fixed`, z-index 1000. Auto-flips left when right-edge overflows the viewport. |
| `.cc-pop-head` | Popover header strip (component name + Class/Grade + mean badge). |
| `.cc-pop-title` / `.cc-pop-subtitle` | Cyan title + muted Class/Grade ("Civilian A" format - converted from numeric `Grade` via `String.fromCharCode(64 + n)`, matching weapon-picker `gradeLabel`). |
| `.cc-pop-mean` | Right-side quality badge, cyan border + `bg-cyan-08` fill. |
| `.cc-pop-summary` | Top crafted-value summary: one row per unique affected `PropertyName`. Hidden when empty via `:empty{display:none}`. |
| `.cc-summary-row` | One row inside the summary - label on left, crafted value + colored %-delta on right. |
| `.cc-slot` | Per-slot block (one per crafting slot in the blueprint). Dashed bottom border between slots. |
| `.cc-slot-head` / `.cc-slot-title` / `.cc-slot-cost` | Slot title (uppercase, letter-spaced) + resource cost on the right (gold). |
| `.cc-slot-pct` | Percentage line under the title (e.g. "+7.15% pool health"). Updated in place on slider input. |
| `.cc-slot-controls` | Grid row: `MIN` slider `MAX` − [num] +. |
| `.cc-slider` | Native range input restyled with a green thumb on a dark track. |
| `.cc-num` | Numeric input mirroring the slider. |
| `.cc-step` | ±10 step buttons. |
| `.cc-pop-foot` | Footer strip with three action buttons. |
| `.cc-bulk`, `.cc-bulk-min`, `.cc-bulk-reset`, `.cc-bulk-max` | Standalone action buttons in the `.lo-reset` style (subtle border, transparent bg, uppercase). Per-button hover colour: red / cyan / green. Always two lines via `<br>` so the three buttons match height. |
| `.cc-pct-pos` / `.cc-pct-neg` / `.cc-pct-zero` | Modifier-delta colour: green / red / muted. |

### Indicator placement

Embedded inside `.lo-name` (not as a sibling of the keyStat) so it
visually anchors to the component name on the left, not the stats
column on the right. `vertical-align: middle` keeps it aligned with
the surrounding text.

### Surgical update (drag safety)

Slider `input` events fire continuously while dragging. The popover
**must not** re-render its own `innerHTML` on input - that would destroy
the slider mid-drag. `craftingUI.refreshInPlace` rewrites only
`.cc-slot-pct` + `.cc-pop-summary` + the header mean; slider + numeric
input elements survive the entire drag.

### Bulk crafting (grouped weapons)

The indicator on a grouped weapon row (turret rack x4, ball turret x2,
etc.) carries the full peer-port list in `data-craft-peers`. Slider
edits fan out to every port in the group via `commitAndRefresh`. Single
port slots omit the attribute and use the simpler path.
