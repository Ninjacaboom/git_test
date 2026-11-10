# Deferred Work

Items that were intentionally skipped and should be revisited.

## Open

### TTK - simplify the optimal cooling/reloading-time reasoning

`computeOptimalPauseLen` currently runs a per-step simulation search and applies
three rules (largest-tie, regen cap, fastest-gun recovery cap) - see
`PLAN_TTK_PILOT_FIRE.md` "Optimal cooling / reloading time". User proposed
collapsing it to a single principle:

> **The shortest pause that sustains the longest burst your guns can fire
> without overheating - but never long enough to let the target's shield start
> regenerating.**

That is a closed form - `min(fastest-gun full recovery, just under shield regen
onset)` - and removes the need for the search entirely. Two things to settle
before adopting it:
- **Robustness:** the search handles exotic loadouts (distortion-hold Mode B,
  mixed energy+ballistic recovery) empirically; the closed form is an
  approximation there. Decide whether to drop the search or keep it as a
  fallback.
- **Mixed-gun tiebreak:** "longest burst without overheating" is limited by the
  most-constrained gun, but the recovery pause is set by the *fastest* gun (so
  it isn't left idle) - document/confirm that choice.

If adopted: rewrite the doc section to the two-clause framing and replace the
search with the closed form (keep the sim as a fallback if we want safety).

### TTK / Deflection - penetration-distance reach model

Component damage (power-plant disable) currently uses an empirical
approximation in `runArmorPipeline` (`js/deflectionCalc.js`):
`penRatio = RESIDUAL_PEN_RATIO (6%) at full armor, rising to 100% as armor
strips`, then `componentDmg = rawThrough × Hull.PenetrationDamageMultiplier
.Component × penRatio`. `Weapon.Ammunition.Penetration.BasePenetrationDistance`
is only used as a binary gate (`basePen > 0`) + a display value - its
magnitude does NOT differentiate weapons. So a 6.6 m Deadbolt and a 0.4 m
repeater reach components identically, and a power plant can be damaged
through 100% armor.

**Proposed physical model** (deferred - keep the current approximation for now):
- `effPen = basePen × (1 − armorFrac)` (user's formula - penetration grows as
  armor strips; zero through full armor).
- Component reachable only when `effPen ≥ componentDepth`. Once reached,
  `componentDmg = rawThrough × Hull.Component-mult` as today.
- `componentDepth` = "how deep the power plant sits from the nearest hull
  surface at a realistic attack angle". No extractor data for this (no armor
  thickness / component positions; Paladin even has Dimensions 0/0/0), so it
  must be a heuristic.

**Depth heuristic options discussed:**
1. Per-`Size` lookup table (robust - every ship has Size), tunable like
   `SALVAGE_HEAD_BASES`. Rough anchors from user intuition: S1 ~0.15, S2 ~0.25
   (Arrow "barely any pen needed"), S3 ~0.5, S4 ~1.0, S5 ~1.5, S6 ~2.0 m
   (Idris from a good rear/top angle).
2. **User-input field** for "penetration distance to reach power plant" - lets
   the player set it per matchup (front-on Idris ≈ whole ship length; rear/top
   ≈ ~2 m). Simplest and sidesteps the angle-dependence problem.

**Consequences to note when implementing:**
- Power plant can no longer be disabled through 100% armor (must strip armor
  first) - more physical, but changes current behaviour.
- Short-pen weapons (e.g. 0.4 m repeater) would never reach a capital ship's
  power plant regardless of armor - correct, but verify it reads sensibly.
- Distortion is unaffected (bypasses armor; only needs the shield down).
- `runArmorPipeline` is shared by the Deflection dialog, so a real model
  should update both (the Deflection component-damage column would also
  reflect depth). Decide scope (shared vs TTK-only) at implementation.

**Status:** deferred by user 2026-06-01. Current approximation kept. Revisit
with either the per-Size table or the user-input field (the latter is lower
risk and more flexible given the angle dependence).

**Update 2026-07-09 (PTU 4.9.0.12180844):** CIG zeroed
`BasePenetrationDistance` on all 11 distortion weapons (Live 4.8.3 still
ships 0.42-3.15 m). In-game testing (S1 distortion repeaters vs Anvil
Asgard) shows distortion still disables when the shot lands on the hull
section where the components sit, even at 0 penetration - reach is
aim-based, not penetration-based. The TTK `ppReach` gate was accordingly
changed to exempt distortion (it now gates physical component damage
only), and the Deflection calc no longer reports a pen distance on
distortion rows. Any future depth-based reach model should keep
distortion out of scope, as this entry already assumed.

### TTK dialog - "include manned turrets" (no-gunner) toggle

The Loadout Advisor (PLAN_LOADOUT_ADVISOR.md, eng-reviewed 2026-07-29)
gets an "include manned turrets" toggle: toggle OFF excludes turret
weapon groups from both candidates and the TTK sim (no gunner = those
guns don't fire). The TTK dialog has no such option - it always counts
manned turrets - so the same loadout will show different TTK in two
dialogs side by side, which reads as a bug.

**What:** add the same toggle to the TTK dialog, driving the same
group filter (`enumerateLoadoutWeaponsForTtk` groups carry `category`).
**Why:** consistency between Advisor and TTK numbers for solo pilots.
**Depends on:** Advisor Phase 2 (builds the group filter) - implement
right after, the marginal cost is a checkbox + prefs field.
**Decided:** 2026-07-29 during /plan-eng-review TODO pass (option A).

### Ships without personal lockers show 0 Storage SCU

The expanded overlay's Hull → Carrying Capacity → Storage row uses
`vehicle.Cargo.Storage` (in SCU) as its source, which mirrors
`Hardpoints.Components.Storage.InstalledItems[].Capacity` from the
hardpoints data. All 100+ ships with storage items in the hardpoints
already have a matching `Cargo.Storage` value - there are zero
mismatches, so the NovaTools code is correct.

However, some ships that have personal storage in-game are missing
it entirely from CIG's source data. Examples: Anvil F7C Hornet Mk II,
F7C-S Hornet Ghost Mk II, and F7A Hornet Mk II all show
`Cargo.Storage = 0.0` in `vehicle_stats.json` (Live + PTU verified
2026-05-08), while the F7C-M Super Hornet Mk II correctly shows
`1.29`. The same gap was present in SPViewer's export and persists
post-Extractor-migration, so this is a CIG-source data hole, not a
tooling issue.

**Status:** blocked on CIG. Nothing actionable on our side until the
source data includes the missing storage entries. When CIG fills
them in, it will flow through automatically via `Cargo.Storage`.

### Mining section header (parity with Salvage)

The Salvage section now shows Storage Buffer + Modifiers + Salvage Rate header
rows, plus per-modifier inline stats (Speed/Radius/Efficiency/Rate) and a
dedicated picker. The Mining section still uses the generic turret renderer and
has no header summary. Add an equivalent for mining: walk `slots.mining`,
aggregate from each `MiningModifier` item's `Module` field, and surface useful
stats (laser power, optimal range, instability, resistance, etc.). The
modifier-row picker should also get a Mining-specific column set.

### Salvage scraping math - open questions

The salvage rate formula is provisional. Current implementation in
`js/statsPanel.js → getSalvageSummary`:

```
salvageRate = sum(rpm × eff_i) / slowest_scraper_eff / head_base.efficiency
```

where `rpm = SpeedMultiplier × 60` and `head_base.efficiency = 0.55` for the
standard Baler. The picker per-row Speed/Radius/Efficiency display matches
SPViewer for ships using the Baler head. The aggregate rate has not been
matched against an authoritative reference for any specific real loadout -
we don't yet have a confirmed test case where the formula's output equals
an SPViewer or game-source value.

**Open questions / things to verify:**

1. **Per-ship head base constants.** SPViewer shows the MOTH salvage section
   with base values **3.6 × Speed / 1.25 × Radius / 0.71 × Efficiency**, while
   the Reclaimer uses the standard Baler **10 / 2.18 / 0.55**. Both ships
   actually equip `Salvage_Head_standard` in the source data - so the constants
   are not stored on the head item. They appear to be hardcoded per-ship (or
   per-turret-class) somewhere we haven't found. NovaTools currently shows the
   Baler defaults for both ships. Fixing this needs either a per-ship override
   map or reverse-engineering where SPViewer pulls the constants from.
   See `SALVAGE_HEAD_BASES` in `js/statsPanel.js` for the place to plug it in.

2. **Rate formula correctness on mixed loadouts.** With a Reclaimer custom
   loadout of 1× Trawler + 3× Cinch (standard), user reported the displayed
   rate as ~35.4 and was unsure if this was right. They proposed an alternative
   formula `slowestRpm / slowestEff × scraperCount / headEff` and a variant with
   an extra "general head loss" factor (~0.6). For 6 Abrades on the MOTH the
   user's tentative formula gives `9 / 0.9 × 6 / 0.55 ≈ 109`, while the
   proposed loss-factor variant gives `≈ 65.45`. Neither has been confirmed
   against game data. **User said: "this is something I need to do more
   thinking about"** - wait for confirmation before changing the formula.

3. **`SpeedMultiplier` is being treated as SPS.** The `× 60` to get RPM is
   based on the user's hypothesis that SPViewer's exported `SpeedMultiplier`
   is actually shots-per-second despite the name. No source-data field
   literally named `SPS`/`RPM` exists on salvage modifier items.

4. **Salvage head base values aren't on the head item.** Looked at every
   numeric field on `Salvage_Head_standard.stdItem` - none of `2.18`, `10`,
   or `0.55` appear anywhere. The `SALVAGE_HEAD_BASES` constants in
   `js/statsPanel.js` are hardcoded for now.

### Per-turret modifier propagation - possible bug, cannot reproduce

User reported that "changing modifier on the moth and the reclaimer also
changes the default scraper of the same kind on the rest of the turrets,
this should be a per-turret thing instead." Investigation:

- Direct JS mutation, single picker click, sequential picker clicks,
  save+reload via the actual picker handler, and fresh-state tests on both
  MOTH and Reclaimer all show **correct per-turret isolation** in both the
  data layer (`currentLoadout`) and the rendered DOM.
- Each modifier sub-port has a unique `data-port` attribute and no
  `data-rack-ports` is set on salvage modifier slots, so the rack-port
  batch-update path in the picker click handler can't fire here.
- May be a UI quirk we're not exercising in automation, or the user might
  have been observing the section header **Modifiers** row updating
  (which is correct: it recomputes from the new min across all modifiers)
  and interpreting it as "the other turrets changed".

If it resurfaces, get exact reproduction steps: which ship, which turret,
which modifier picked, and whether the data or only the displayed name
changes.

### Other component slots not yet wired

Deferred from the EMP/QED/Mining/Salvage/Thrusters pass on 2026-04-07:

- **`Systems.Countermeasures`** - chaff/flare/decoys, every ship has them
- **`Systems.FuelIntakes`** - every ship
- **`Propulsion.HydrogenFuelTanks`** - every ship
- **`Propulsion.QuantumFuelTanks`** - every ship (capacity already used by QD range calc, but the slot itself isn't shown)
- **`Avionics.SelfDestruct`** - every ship (uneditable)

All would slot into the same pattern as the new Mining/Salvage extraction in
`loadoutManager.extractSlots`. Most are read-only blobs without `Types`, so they'd
need a thruster-style summary renderer rather than going through the picker.

### Boosted Angular Velocity - IFCS PowerRanges

**Current formula** (`js/statsPanel.js:1185-1188`):
```js
engFrac = clamp((enginePips - engineMin) / (engineMax - engineMin), 0, 1)
boostedPitch = pitch × (1 + (boostPitchMult - 1) × engFrac)  // and yaw / roll
```

**Why it's an approximation:** The game uses `IFCS.PowerRanges` to control how
boost multipliers scale with power pip allocation. In the current
NovaSCDataExtractor output (verified 2026-05-08 against Live.zip), **0 ships**
have non-trivial PowerRanges - every IFCS surfaces with `Start: 0.0,
Modifier: 1.0` across all tiers. The C2 Hercules used to be the lone
exception under SPViewer; it's trivial now too. The linear-engFrac formula
is therefore the best we can do until the upstream data changes.

**When to revisit:** If the Extractor surfaces non-trivial IFCS PowerRanges
(check `vehicle_hardpoints.json → Components.Systems.Controllers.Ifcs[].PowerRanges`
across ships), replace `engFrac` with `getPowerRangeModifierAll(powerRanges, enginePips)`
from `loadoutManager.js`. The function is already exported and handles
arbitrary ranges.

**Reference:** `loadoutManager.js` → `getPowerRangeModifierAll()`

### Update banner - no progress feedback during download

The update banner's "Update" button in `js/app.js → checkForUpdates()`
streams output from `update_data.py` via chunked transfer encoding but
doesn't render any of it back to the UI. For the user the button just
changes text from "Update" → "Updating..." and then sits there for the
duration of the run.

Post-Extractor migration `update_data.py` no longer downloads or
decrypts ZIPs (the Extractor produces them); it now reads embedded
`metadata.json` to refresh `versions.json` and fetches sold/shop
status from `finder.cstone.space`. The CStone fetch is the slow part -
hundreds of HTTP requests for shop locations - so the "feels frozen"
problem still applies, just for a different reason.

Ideas:
- Show the streamed lines in a small log dropdown below the banner
- Animated progress dots / spinner while reading the stream
- A counter parsed from known output lines (e.g. shop-fetch progress)
- A simple "still working..." heartbeat that pulses while bytes are flowing

### Unify `flattenPort` and `buildPort` port-tree builders

`js/loadoutManager.js → flattenPort` (initial slot extraction) and
`js/weaponColumn.js → rebuildSlotPorts → buildPort` (picker-swap
rebuild) are near-identical port-tree walkers - both filter via
`isLoadoutPort`, both walk children, both produce the same flattened
slot shape. They diverge in small ways: `flattenPort` calls
`syntheticPortsFromItem` for mining/salvage modules; `buildPort` falls
back to `InstalledItem.Ports` and applies the stricter
`isVisibleLoadoutPort` (which adds a locked-Mining/Salvage filter
on top).

This pair has already drifted twice - the `Display` filter fix and
the `InstalledItem.Ports` fallback both had to land in two places.
One unified helper with an `initial` vs `swap` mode flag would be the
durable fix.

**Risk: medium-high.** The divergence is intentional in places
(synthetic ports only fire on initial load, the locked-module filter
only on swap). Needs careful consolidation; budget a focused session.

### Investigate `PortTags` vs `Tags` field handling

The vehicle hardpoint data uses `Tags` for port-side tag declarations
(surfaced during the IFR-A77 / Idris-P investigation), but
`flattenPort` and `buildPort` only read `p.PortTags`. Several places
miss the `Tags` field entirely, which can cause picker compatibility
checks to silently fail when an item's `requiredTags` would otherwise
be satisfied by the port's `Tags`.

**Action:** introduce `getPortTags(p) = p.PortTags || p.Tags || []`
helper and route both `flattenPort` and `buildPort` through it. **Risk:
medium** - could change picker contents in subtle ways. Sample a few
ships before rolling it out.

### Split `openPicker` into composable steps

`js/weaponColumn.js → openPicker` (~470 lines, lines 1525-1994)
handles search, sort, filter, mixed mounts/weapons table rendering,
both click handlers, and empty-pick all in one function. Splittable
into `buildPickerData` (query allItems + filters), `renderPickerRows`
(table HTML), and `bindPickerHandlers` (event wiring).

**Risk: medium** - many interlocking closures over local state. Big
readability payoff but not urgent.

### Split `applyDefaultAllocation` budget helpers

`js/loadoutManager.js → applyDefaultAllocation` is readable as six
numbered priority blocks, but the inner `addPips` closure has a dual
`budgetCost` mode that's hard to follow. Split into `addPipsBudgeted`
(caller specifies budget cost separately from visual pip count - used
for shields where only powered shields consume budget) and
`addPipsFree` (cost equals visual amount). **Risk: low.** Medium
readability payoff.

### Blueprints tab - extractor-side asks (sent upstream)

The Blueprints feature (see [PLAN_BLUEPRINTS.md](./PLAN_BLUEPRINTS.md))
needs three fields added to NovaSCDataExtractor's output. None of them
block v1 implementation, but each unlocks a specific UI feature once
they ship:

1. **`MissionType` per contract in `missions.json`** - sc-craft.tools
   groups contracts as MERCENARY / DELIVERY / BOUNTY / etc. and we want
   the same grouping. Without this we fall back to grouping by `Kind`
   (Contract / ScenarioTier), which is much coarser. The data source
   is likely a ClassName-suffix convention in CIG XML (`_DC_` =
   DataChase / Delivery, `_RG_` = ResourceGathering, `_TSG_` = ?, …);
   extractor team to verify and emit as a normalized enum.

2. **`StandingReward` per contract in `missions.json`** - the reputation
   POINTS the player gains for completing the mission. Critical for
   "do mission X to unlock mission Y" planning. Sc-craft.tools shows
   this prominently on every mission card. We'll show a `-` placeholder
   row until this field arrives.

3. **Mining locations per resource in `resources.json`** - sc-craft.tools
   shows "Borase is found in Nyx Glaciemring, Pyro Bloom, Stanton
   Lagrange Points, …" on every resource. Nice-to-have follow-up once
   the resource sub-tab lands (Q1 follow-up from the plan). Lower
   priority than the two above.

**Status:** asked, awaiting extractor work. Track here so we revisit
the Blueprints UI follow-ups when each lands.

### Blueprints tab - multi-tier blueprint support

All 1 537 BPs in current PTU data have exactly 1 tier in
`blueprints.json` `Tiers[]`. The Phase 1 implementation reads
`Tiers[0]` directly. When CIG ships T2/T3 recipes, switch to iterating
the `Tiers[]` array and adding a tier-selector UI to the BP detail
panel. **Status:** blocked on CIG data - nothing actionable until
multi-tier appears.

### Blueprints tab - Resources sub-tab + resource detail view

Q1=C in the plan scoped the v1 to "inline resource pills only".
A dedicated **Resources** sub-tab (alongside Blueprints / Missions)
becomes the natural next iteration once `mining locations per resource`
extractor data lands. Each resource entry would show: name, unit
type, category, mining locations, and the reverse list of BPs that
use it. Cross-link the inline resource pills to deep-link into this
view. **Status:** scope follow-up; revisit after extractor mining-
location data and after v1 ships.

### Blueprints tab - Owned / Fabricator (user-state features)

Q2=D in the plan deferred these entirely. Sc-craft.tools has them:
- "Mark as owned" toggle per BP, with persistent state (localStorage
  per device; possibly org-shared in their case).
- "Add to Fabricator" - a wishlist / to-craft queue with total resource
  cost aggregation and total build time across multiple BPs.

Significant UI add (queue panel, share/export flow, owned filter),
substantial value for power users. **Status:** deferred; revisit
after v1 ships and we see how the feature gets used.

### Blueprints tab - recommended-mission scoring

Once `StandingReward` (extractor ask above) ships, we can produce a
"best mission for this BP" score: `EffectiveChance × ease_factor`
where ease combines mission length, standing required, and lawfulness.
Surfaces a sorted "fastest grind" view per BP. **Status:** blocked on
extractor `StandingReward`.

---

## Completed

### Boost time - capacitor usage curve

**Completed:** 2026-07-29 - Boost time was first shipped as
`Size / IdleCost`, which matched SPViewer on most ships but gave 25 s for
the Drake Buccaneer against SPViewer's 33.33 s.

The missing term was `Capacitor.Curves.Usage`, exported as a bare record
GUID rather than as points (unlike the sibling `Curves.AngVelocity`, which
the extractor already resolves inline). Reading the records out of the
extractor cache under `Data/Libs/Foundry/Records/capacitorassignment/`
showed only two curves are referenced by flight blades:

  CapacitorAssignmentInputOutput_Always_1       (0,1) -> (1,1)     drain 1.0
  CapacitorAssignmentInputOutput_Linear_100_75  (0,1) -> (1,0.75)  drain 0.75

Final formula: `Size / (IdleCost x UsageModifier x UsageCurve(engFrac))`.
The curve input is the **engine power assignment** - the record type is
literally `CapacitorAssignmentInputOutputDef` - so boost length moves with
engine pips on the 35 `Linear_100_75` blades and is flat on the other 190.
A first pass wrongly treated the curve as a constant; see the one-pip
measurement below for what corrected it.

The curve is load-bearing rather than cosmetic: the Buccaneer and the F7C
Mk II have identical capacitor parameters apart from size (25 vs 20, ratio
1.25) yet their full-pip boost times differ by a ratio of 1.67, so no
size-only model can produce both.

A companion `calculateBoostRegenTime` was added at the same time, using
`Curves.Regen` (`Linear_50_100` on all 225 blades, 0.5 -> 1.0). Recharge is
the mirror of drain: more engine pips make the capacitor both drain slower
and refill faster.

**Confirmed in-game** on Live 4.9.0.12326004, three measurements:
- **Drake Buccaneer at full engine pips, ~33 s** (computed 33.33). This one
  discriminates all three candidate models - `afterburnerNew` would have
  given 20 s, and integrating the curve as the capacitor drains would have
  given `25 x 4 x ln(4/3)` = 28.8 s. Every flight controller record carries
  both an `<afterburner>` and an `<afterburnerNew>` block; the extractor
  reads the legacy one and this confirms that is correct. **Do not switch
  to `afterburnerNew`.**
- **Drake Buccaneer at one engine pip, ~25 s** (computed 25.00), exactly the
  curve's other endpoint. This is what established that the input is the
  engine assignment rather than a constant.
- **Drake Cutlass Black 2m20s = 140 s** (computed 140). Confirms the legacy
  capacitor scale (2800 / 20) is genuinely live on the Cutlass
  Black/Blue/Red, and that **SPViewer's 18.48 s for that ship is wrong**.
  This was the last open discrepancy; it resolved in our favour.

- **Drake Buccaneer refill at one engine pip, ~66 s** (computed 66.7,
  against 33.3 s at full pips). Closes the regen curve the same way, so both
  endpoints of both curves are now measured rather than inferred.

Nothing about the boost/regen model is left inferred. The only outstanding
item is the extractor ask below, which is a data-plumbing cleanup rather
than a correctness question.

`LinearCost` / `AngularCost` are deliberately excluded. Both the Idris-P and
the Cutlass Black carry them yet match without - the Cutlass measurement
proves it directly, since including them would have cut 140 s down sharply.

**Still open - extractor ask:** resolve
`Ifcs.AfterBurner.Capacitor.Curves.{Usage,Regen,RegenNavMode}` from GUID to
curve points, the way `Curves.AngVelocity` already is in
`nova/builders/stditem.py`. The 16 records are already in the extractor
cache. Until then NovaTools carries a two-entry GUID map
(`USAGE_CURVE_DRAIN` in `js/loadoutManager.js`) which should be deleted once
the points arrive. Not urgent: the two curves cover all 225 blades and
unknown GUIDs fall back to 1.0.

### Salvage arm names show as raw class names
**Completed:** 2026-05-08 - Added `BESPOKE_ARM_NAMES` map in
`js/loadoutManager.js` (analogous to `CLASS_PATCHES`) that gives the 7
known ship-specific salvage arms ship-prefixed display names: Reclaimer,
MOTH, Vulture (L+R), Fortune, and Salvation (L+R). Wired before the
existing generic ToolArm fallback so bespoke names take precedence; the
fallback still catches anything new.

Verified on Live - Drake Vulture renders `Vulture Salvage Arm (Left)` and
`Vulture Salvage Arm (Right)` in the salvage section, with no raw
classNames leaking anywhere in the DOM.

### Aurora Mk II - empty module slot
**Completed:** 2026-05-08 - Aurora Mk II is the only modular Aurora chassis (Mk I variants
are fixed-loadout ships); its `hardpoint_module` port had no
`defaultLoadout` entry and was being dropped by the Extractor walker,
which left `Hardpoints.Components.Modules: {}` in the zip and zero
`RSI_Aurora_Mk2_*` items in `vehicle_equipment.json`.

Both halves of the Extractor fix landed:

1. **Walker now surfaces unloaded ports.** `Hardpoints.Components.Modules`
   for `RSI_Aurora_Mk2` now contains `InstalledItems[0]` =
   `hardpoint_module` (S1, types=['Module'], requiredTags=['$RSI_Aurora_Mk2_Module'])
   with no `BaseLoadout`.
2. **Item filter preserves tag-matched modules.** `vehicle_equipment.json`
   now has 15 `RSI_Aurora_Mk2_*` entries, including the three Module-typed
   items (`RSI_Aurora_Mk2_Module`, `_Module_Cargo` = TS Transport,
   `_Module_Missile` = DM Damage).

Verified in browser on Live: Aurora Mk II shows a `MODULES` section
with an `S1 Empty` slot; the picker offers the DM and TS modules
(the bare `_Module` base entry is filtered as a non-pickable fallback).
NovaTools needed no changes - the Module-slot rendering pre-existed.

### Shared build restore - needs dedicated tab
**Completed:** 2026-05-08 (audit) - Verified the fix is in place:
`loadoutUI.js:135-139` calls `addTab()` before `selectShip(restoredShip)` +
`applySharedBuild(sharedBuild)` when a share ID is detected, so the shared
loadout always opens in a fresh tab instead of clobbering the user's
restored tab state.

### IndexedDB Orphaned Entries
**Completed:** 2026-05-08 (audit) - `dataLoader.js:52 → pruneOtherEntries(build, keepKey)`
already deletes every cache entry for `build` except the current `cacheKey`
after each successful load (called at line 144). Cleanup happens on every
load, not only on startup, which is strictly better than the original
proposal.

### Audit `CLASS_PATCHES` post-Extractor migration
**Completed:** 2026-05-08 - Audited 13 patched classNames against fresh
`Live.zip` + `PTU.zip` from the Extractor: 6 of 13 are still in the data
with `Class=''` (empty), 7 are not yet surfaced by the Extractor. The 6
populated cases are CIG-source omissions, not a SPViewer-extraction quirk,
so the patch map stays. The 7 dead entries are no-op lookups and may
become live again as the Extractor catches up with capital ships; they
cost nothing to keep.

**No code change.** The block's comment ("Patch missing Class fields in
game data") was already neutral re: data source.

### Verify `ToolArm` placeholder fallback still needed
**Completed:** 2026-05-08 - 7 of 14 ToolArm items in Live (15 in PTU)
still have `Name === ClassName` in the fresh Extractor output -
Reclaimer / MOTH / Vulture (L+R) / Fortune / Salvation (L+R) salvage
arms. The fallback is still load-bearing.

**Comment refreshed** to cite CIG source data + Extractor surfacing
instead of "the SPViewer dump". No behaviour change.

### Verify BOM strip in `dataLoader.js`
**Completed:** 2026-05-08 - All 6 JSON entries in fresh `Live.zip` +
`PTU.zip` start with `[\r\n` or `{\r\n` - no UTF-8 BOM (`EF BB BF`)
anywhere. The strip was a relic of SPViewer's encrypted ZIP format.

**Removed** the `text.replace(/^﻿/, '')` from
`dataLoader.js → readJsonEntry`.

### FlightBlade slot
**Completed:** 2026-04-12 - Added as a system category in `extractSlots()`
under `Avionics.FlightBlade`. Renders via `renderSystemSlot` like other
system components. Uses the thrusters icon
(`spvi-Engineering_Icon_ItemThrusters`) since no dedicated flight blade
icon exists in the font. Tag filtering (`portTags`/`requiredTags`) wired
so each ship only sees its compatible blades (e.g. Arrow sees
`$ANVL_Arrow_Blade` items).

### Ship Details title + expanded h4 icon alignment
**Completed:** 2026-04-11 - Unified icon alignment across all headers.
The banner header (`.stats-banner-header h3`) and expanded overlay
sub-headers (`.stats-grid-3col .stats-group h4`) were using
`display:flex; gap:8px` on the heading element for icon alignment,
which produced misaligned icons compared to the `.lo-section-header`
pattern. Removed flex from the heading elements and added
`vertical-align:middle; margin-right:3px` to the `<i>` icon rules
(matching `.lo-section-header h3 i`). Bumped overlay h4 icon size
from `1rem` to `1.1rem` for consistency. Updated `UI_GUIDE.md` with
an explicit "Icon Alignment Rule" section documenting that all
headers must use `vertical-align:middle` on the icon, never flex on
the heading.

Touched: `css/styles.css`, `UI_GUIDE.md`, `TODOS.md`.

### Banner + expanded overlay restructure (5-cell label-first)
**Completed:** 2026-04-09 - second pass on the Ship Stats banner
based on live feedback:

- **5-cell label-first layout** - banner rewritten from 4 cells
  (Offense / Shield / Structure / Flight) to 5 cells (Offense /
  Shield / Armor / Hull / Flight), with row format flipped so the
  label sits on the left in muted text and the value+unit group
  is right-aligned. New row primitives: `.g-label`, `.g-val-wrap`,
  `.g-sep`. Per-cell icons removed (the single ship-controls icon
  in the new header bar is enough anchoring). Cells are
  content-sized with `flex: 1 1 auto` so wide rows (Armor's
  Deflection, Flight's P/Y/R) get the space they need.

- **Always-visible header bar** - new `.stats-banner-header` sits
  above the collapsed strip with a gold "Ship Details" title on
  the left and the Details ▼ toggle button on the right (replaces
  the old ship-name pill that lived inside the left edge of the
  strip, and the button that used to live at the bottom of the
  Flight cell).

- **Missile / Bomb damage split** - `calcCombatStats` renamed
  `sumSlotMissileDmg` to `sumSlotPayloadDmg` and now returns
  `{ missile, bomb }` separately. Offense cell gains a dedicated
  Bomb row; the expanded Weaponry column shows a new "Bomb Damage"
  line after "Missile Damage" when present.

- **Armor cell rows** - now HP / Deflection (phys/energy) /
  Physical dur % / Energy dur %, with durability rows coloured by
  sign (negative = cyan, positive = red).

- **Hull cell rows** - dropped Dimensions (kept in the expanded
  overlay only); now HP / Mass / Cargo.

- **Expanded overlay restructure**:
  - Armor block MOVED from Hull column to under Shields in the
    Weaponry column.
  - Thermal & Cargo section REMOVED from Flight column.
  - NEW Carrying Capacity section under Hull column showing
    Cargo Grid (SCU) and Storage (K μSCU). Storage converts
    raw `Cargo.Storage` SCU → K μSCU via `× 1000`.
  - NEW Fuel section under Flight column showing Hydrogen and
    Quantum capacities (M / SCU format) plus QD range in GM.
    Range is computed from the equipped QD's `MicroUnitPerSec`
    consumption rate and `state.currentQFuelCapacity`.
  - NEW Insurance section under Flight column showing
    Standard → Expedited claim times and expedite cost.

- **Icon refresh**: added `spvi-fuelpump` (\\ea10) and
  `spvi-insurance` (\\ea17) to the CSS mapping. Insurance
  sub-header switched from `spvi-health` to `spvi-insurance`.

- **Castillo bomb rack fix** (`js/weaponColumn.js:1516`):
  `BombLauncher` was missing from the `rebuildSlotPorts` trigger
  condition, so equipping a CST-313 "Castillo" (or any bomb rack)
  left the parent slot with no sub-ports and the user couldn't
  pick a bomb. Added `BombLauncher` to both the equip and unequip
  branches of the picker click handler.

- **Ship Details overlay title** - intermediate step: added a
  "Ship Details" title inside the expanded overlay, then moved it
  to the always-visible banner header when it became clear the
  user wanted it on the collapsed state too.

- **`.reference` section modifier removed** - Coolers, Radar, and
  Life Support no longer render with muted grey headers. The
  muting wrongly implied "read-only" when the rows are fully
  editable. All system sections now share the same gold header
  treatment.

- **Ship config extraction** - `selectShip` in `loadoutUI.js`
  stashes `config.cargo` (containers / grid / storage),
  `config.fuel` (hydrogen + quantum capacities from
  `FuelManagement`), and `config.insurance` (standard /
  expedited claim times + expedite cost).

Touched: `js/statsPanel.js`, `js/weaponColumn.js`, `js/loadoutUI.js`,
`css/styles.css`, `index.html` (cache bumps), `UI_GUIDE.md`,
`ICONS.md`, `TODOS.md`.

### Top-row stats banner + picker UX pass
**Completed:** 2026-04-09 - major UI rewrite of the Loadout Manager
workspace around a compact top row and a collapsible stats banner:

- **Top-row layout**: removed the right-column Ship Stats card and the
  Display Settings card. Pip card and new stats banner now share a
  horizontal band above the main grid via `#loTopRow`. Main grid
  collapsed from 3 cols to 2. Workspace starts ~85 px higher.
- **Ship Stats banner**: 4 grouped cells (Offense / Shield / Structure
  / Flight) with 4-5 rows each and `flex-wrap: nowrap`. Tooltip map
  (`ABBR`) annotates every abbreviation for accessibility. Details
  toggle button lives at the bottom of the Flight cell, directly under
  the cargo row. Expanded overlay is absolutely-positioned `z-index:60`
  so opening it doesn't shift the workspace below.
- **Expanded 3-col overlay**: Hull / Weaponry / Flight Performance spec
  sheet with nested Armor / Shields / Thermal & Cargo sub-blocks. All
  six h4 headers share the same cyan + solid-underline style. Turret
  DPS gets the same Ballistic / Energy / Distortion breakdown as Pilot
  DPS. Armor uses `spvi-Engineering_Icon_ItemShields` (\ea6f) to
  disambiguate from the shield icon. Vital Parts keys are humanized
  (geo_body → Body) by `humanizeVitalPartName()` with 32 unit tests
  covering all 27 observed key shapes.
- **Reference sections**: COOLERS, RADAR, LIFE SUPPORT tagged with a
  `.reference` class and rendered with a muted header (smaller,
  grey, no gold bar) so combat-critical sections read as primary.
- **Burst/Sust DPS toggle**: moved from the deleted Display Settings
  card into the Weapons section header via `injectWeaponCapBadge`.
- **Click-outside + ESC to close** + fade/slide animation on the
  overlay. Expanded state persists across pip/loadout re-renders.

Picker UX:
- **Category grouping** for multi-type ports: when a port accepts more
  than one item category (e.g. Super Hornet Mk II center:
  `Turret.BallTurret` + `Module`), the picker renders gold section
  headers ("Turrets", "Modules") above each category's rows.
- **Storage module short-circuit**: modules whose only sub-ports are
  `Cargo`-typed render as a single leaf row with the total SCU
  capacity inline on the right, no child rendering.
- **DoorPart filter**: `rebuildSlotPorts` drops cosmetic port types
  (`ControlPanel.DoorPart`, `Sensor.DoorPart`, `Decal.DoorPart`, etc.)
  during `buildPort`, fixing the 13-phantom-sub-rows bug when
  equipping a Stor*All Big Box.
- **Turrets + modules sold status**: `update_data.py` now fetches
  `GetSTurrets` + `GetShipModule` from CStone, so the picker's
  `.loot-only` dimming treatment covers those item types too.
- **DEPRECATED_ITEMS blocklist**: hand-curated Set at the top of
  `weaponColumn.js` with 1 entry (Stor*All Big Box Model H) that
  no ship references and no shop sells. Doc'd in DATA_SOURCES.md.

Touched: `css/styles.css`, `index.html`, `js/statsPanel.js`,
`js/weaponColumn.js`, `js/loadoutUI.js`, `js/pipPanel.js`,
`update_data.py`, `data/sold_status.json`, `test/statsPanel.test.js`
(new, 32 tests), `DATA_SOURCES.md`, `UI_GUIDE.md`, `ICONS.md`.

### Salvage section pass - picker, summary, per-row stats, EM, pip channel
**Completed:** 2026-04-07 - comprehensive salvage section work:
- **Section header summary** (`renderSalvageSummary` in `js/statsPanel.js`):
  Storage Buffer (SCU), Modifiers row (Speed × Radius × Efficiency from min
  across scrapers, with radius fallback to tractor when no scrapers), and
  Salvage Rate (`/min`).
- **Per-modifier inline stats** in `renderSubWeaponSlot` (`js/weaponColumn.js`):
  scaled Speed / Radius / Eff / Rate on the meta line. Tractors keep Speed only.
- **Picker** (`PICKER_COLUMNS.SalvageModifier`): Size / Name / Speed / Radius /
  Extraction Efficiency / Rate columns, sorted by Speed desc, hideZero handling
  for tractor blanks. Variant-aware dedup so all 3 Cinch variants survive.
- **Per-head base lookup** (`SALVAGE_HEAD_BASES`): keyed by head className for
  future expansion. Currently both known heads default to Baler `2.18 / 10 / 0.55`.
- **Aux pip channels**: new `interdiction` / `mining` / `salvage` channels in
  `buildPipAllocation`, sandwiched between utility and radar, default unpowered.
  EM scales linearly with `allocated/max` instead of via PowerRanges (the items
  declare RegisterRange=false on every entry - Reynie QED's 17 000 EM was being
  zeroed out by the standard formula).
- **PIP icons**: `interdiction → spvi-icon_common_EMP`, `mining → spvi-icon_common_mining`, `salvage → spvi-salvage`.
- **Pepperbox / missile rack fix**: `buildPort` walks `InstalledItem.Ports` only
  for `MissileLauncher`/`MissileRack` types, not for weapon attachment ports.
  Fixes both the post-swap "Empty x4" weapon attachment leak AND keeps Pepperbox
  rendering its 16 missiles after a turret swap.
- **Locked sub-port auto-pick**: when a swapped turret has uneditable sub-ports
  with no defined `InstalledItem`, `setDefaults` now auto-picks the first
  compatible item from the items db (e.g. PDC swap to a turret variant whose
  weapon slot isn't pre-defined).
- **ToolArm + ship-specific turret name patches**: ship-specific salvage/mining
  arms (`ARGO_MOTH_Salvage_Arm`, `AEGS_Reclaimer_Salvage_Arm`, etc.) now render
  as "Salvage Arm" instead of the raw className. Generic turret items
  (`ARGO_MOTH_Turret_Right`) get prefixed with the ship code → "MOTH Manned Turret".

Touched: `js/loadoutManager.js`, `js/statsPanel.js`, `js/weaponColumn.js`,
`js/loadoutState.js`, `css/styles.css`, `FORMULAS.md`, `DATA_SOURCES.md`, `UI_GUIDE.md`.

### EMP / QED / Mining / Salvage / Thrusters slots
**Completed:** 2026-04-07 - Added five new component sections:
- **EMP** + **QED** (left col) - extracted from `Hardpoints.Weapons.InterdictionHardpoints.{EMP,QED}`
- **Mining** + **Salvage** (left col) - extracted from `Hardpoints.Weapons.{Mining,Salvage}Hardpoints.{PilotControlled,CrewControlled}`. Outer ToolArm mounts are uneditable but inner sub-ports (mining lasers, salvage heads, salvage modifiers) are editable through the existing picker.
- **Thrusters** (right col) - read-only summary aggregated by (kind, size, grade) from `Hardpoints.Components.Propulsion.Thrusters.{Main,Retro,Maneuvering,VTOL}Thrusters`. Cannot be edited because SPViewer data omits `PortName`/`Types`/`BaseLoadout` for thrusters.

Touched: `loadoutManager.extractSlots`, `loadoutState.DEFAULT_SECTION_ORDER`, `loadoutUI.getSectionDefs/SECTION_ICONS/resetCategory`, new `renderThrusterSlot` in `statsPanel.js`, four new icon CSS rules in `styles.css`.

### loadoutUI.js Modularisation
**Completed:** 2026-04-07 - `loadoutUI.js` went from ~3245 lines to ~200,
split into `js/buildManager.js`, `js/loadoutState.js`, `js/pipPanel.js`,
`js/statsPanel.js`, and `js/weaponColumn.js`. The remaining `loadoutUI.js`
is an orchestrator that wires the sub-modules together.

### Vitest Test Coverage for loadoutManager.js
**Completed:** 2026-04-07 - `test/loadoutManager.test.js` (431 lines) covers
pip allocation, cooling stats, EM signature, shield pip distribution, and the
steal-loop regression. Run with `npm test` (single run) or `npm run test:watch`.

### IndexedDB Rename (SCWeaponAnalyzer → NovaTools)
**Completed:** 2026-04-07 - `DB_NAME` renamed in `js/dataLoader.js`. Cache
entries are now keyed by `${build}_${gameVersion}` instead of a time-based TTL,
so a new game version naturally invalidates without needing a stale-cache check.

### deriveType() bare fallbacks lack a damage prefix
**Deferred:** 2026-07-02 - `weaponParser.deriveType()`'s last-resort branches
return bare `'Cannon'`/`'Repeater'`/`'Gatling'`/`'Beam'` (no `Ballistic`/`Laser`
prefix), which `tierEngine.categorize()` classifies as `'Other'` → bypass tier,
so such a weapon would silently lose its deflection dot. Verified unreachable
on Live 4.8.3 (the WEAPON_TYPE_MAP className/tag checks catch every item), so
not changed now to avoid inventing behavior without a real case. If a future
item lands there, route through `prefixByDamage(damagePerShot, kind)` like the
scattergun branch. Related: the underscore form `MASS_DRIVER` never occurs in
game data, and tierEngine only ever sees deriveType() output - documented in
`test/tierEngine.test.js`.

### Dev/test hulls filtered client-side pending an extractor fix
**Deferred:** 2026-08-01 - `dataLoader`'s `DEV_PATTERNS` (`_TEST$`,
`_Bomb_Test$`) drops seven vehicles CIG ships in the export but never makes
obtainable: `AEGS_Eclipse_BMBRCK_S03/S05/S10_TEST`,
`ANVL_Gladiator_BMBRCK_S03/S05_TEST`, `BANU_Defender_Bomb_Test`,
`RSI_Mantis_Bomb_Test`. They were inflating the deflection immune-ship lists
and the ship picker. NovaSCDataExtractor is being changed to stop emitting
them, after which those two patterns match nothing. Keep them as a second line
of defence until a couple of extractor drops have confirmed they are gone, then
remove them. `DEV_PATTERNS` itself stays: it also carries `_Display$`
(showroom display hulls), which is a permanent client-side filter and not part
of the extractor change.

### Perseus distortion pool: generators too far apart for one blast
**Deferred:** 2026-08-03 - the TTK sim treats the power-plant distortion pool
as a single generator's `MaximumDamage`, because distortion is explosive and
one shot saturates every generator inside the blast at full value rather than
splitting between them. The RSI Perseus mounts its two generators far enough
apart that a single blast cannot cover both, so its real distort-to-disable
time is roughly double what the calculator shows. Modelling it needs generator
positions (component offsets), which the extractor does not currently emit -
`vehicle_hardpoints.json` carries no coordinates. Revisit if positions land,
or hard-code the Perseus as a 2× distortion case if it becomes a common
matchup.
