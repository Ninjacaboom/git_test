# Plan: Time to Kill (TTK) Calculator

A new dialog, opened from the loadout build bar next to **Deflection**, that
takes **your current loadout's full weapon set firing simultaneously** at a
configurable enemy ship and reports the **time** to reach each kill/disable
outcome. Where the Deflection dialog answers *"can each weapon get through, and
how many shots?"*, TTK answers *"with my whole loadout firing, how many seconds
until it's dead or disabled?"*

Logic lives in [`js/ttkCalc.js`](js/ttkCalc.js) (pure) +
[`js/ttkCalcUI.js`](js/ttkCalcUI.js) (modal), mirroring the
`deflectionCalc.js` / `deflectionCalcUI.js` split.

## Outcomes

| Outcome | Definition |
|---|---|
| **Break shields** | Enemy shield face → 0 HP |
| **Kill (vital)** | Smallest vital part → 0 HP (ship destroyed) |
| **Disable: power plant** | Enemy power-plant component physical HP → 0 (reached through shield → armor → hull → penetration) |
| **Disable: distortion** | Enemy power-plant distortion pool filled to `MaximumDamage` |

## Locked design decisions

- **Engine:** multi-group discrete-event simulation - all weapon groups fire on
  their own cadences against shared, **monotonic** enemy pools.
- **Disable-by-fire:** model the enemy power plant as a component with its own
  `Durability.Health`, reached only after the shield → armor → hull →
  penetration chain delivers `componentDmg` to it.
- **Enemy config:** full component loadout (ship + shield + power plant + …),
  built in the dialog. Phased - see [Phasing](#phasing--effort).

### Ideal-conditions assumptions (sustained pressure)

The simulation assumes the attacker keeps damage on target continuously, so the
defender's recovery timers never start:

- **No enemy shield regen.** Shield pools only ever decrease.
- **No enemy distortion recovery.** The distortion pool only ever fills.

Consequences: every outcome is **monotone vs. fire time**; there are no
"DPS < regen → never breaks" gates. An outcome is `Infinity` only when no weapon
can make progress on that stage (every shot deflected) - the same no-progress
condition `simulateShot` already surfaces. A single UI footnote records the
assumption: *"Assumes sustained fire - enemy shield/distortion regen not
modeled (best-case TTK)."*

## What we reuse vs. build

**Reuse as-is from `deflectionCalc.js`:**
- `buildOpponentProfile()` (extended - see below), `simulateShot()`,
  `runArmorPipeline` logic, `effectiveMitigation()`, `shieldFaceCount()`.
- `simulateShot()` already returns `componentDmg` and `distortionDmg` per shot -
  exactly the two quantities the power-plant and distortion pools consume. **This
  is the key enabler: the per-shot chain already computes everything; TTK just
  accumulates it over a clock against new pools.**

**Reuse from `deflectionCalcUI.js`:**
- `listOpponentShips()`, `listShieldItems()`, `lookupOpponentShip()`,
  `attachSearchableDropdown()`, the `.lo-build-dialog` shell, close/ESC handlers.

**Reuse from `sustained.js`:** `calcSustainedDPS`, `computeBurstDPS`, and the
`effectiveAmmo` cadence pieces.

**New / changed files:**
- `js/ttkCalc.js` - pure engine (discrete-event sim + extended enumerators).
- `js/ttkCalcUI.js` - modal.
- `test/ttkCalc.test.js` - vitest coverage.
- `js/stateStore.js` - add `saveTtkPrefs` / `loadTtkPrefs` (key `sc-ttk-prefs`).
- `index.html` - add `#loadoutTtkBtn` to `.lo-analysis-cluster`.
- `js/loadoutUI.js` - add `initTtkButton()` alongside `initDeflectionButton()`.
- `FORMULAS.md`, `TODOS.md` - document the math and any extractor follow-ups.

## Phase 0 - Data confirmation ✅ DONE

Verified against the current `data/Live.zip` → `vehicle_equipment.json`
(2026-05-31). **All three critical fields resolve - no missing-field risk:**

- **PowerPlant items (`type === 'PowerPlant'`): 79 total.** 79/79 carry
  `stdItem.Durability.Health`; 77/79 carry
  `stdItem.Durability.Distortion.MaximumDamage`. The 2 without distortion are
  edge/test items (e.g. `satellite_power_plant_test`, Health 1.0) - real ship
  power plants have both (Idris S4 = 56 000 HP / 47 500 dist; Reclaimer S4 =
  6 300 / 17 000; Defiant S0 = 98 / 2 600).
- **WeaponGun items (`type === 'WeaponGun'`): 185 total.** 184/185 carry
  `stdItem.Weapon.Firing` (the one without has no alpha and is already skipped).
  Both cadence models confirmed present: **energy** (e.g. `AMRS_LaserCannon_S1`,
  rpm 150, `Consumption` = MaxAmmo/MaxRegenPerSec/Cooldown, capacity 0) and
  **ballistic** (e.g. `APAR_BallisticScatterGun_S1`, rpm 60, capacity 2040,
  `HeatParameters.OverheatFixTime` 0.746). All already consumed by `sustained.js`.

Notes for implementation:
- The PP `Durability` block also contains a `SelfRepair` key - MANUAL repair
  of destroyed components (engineer/pilot operation), NOT distortion decay.
  Automatic distortion decay lives in `Durability.Distortion.{DecayDelay,
  DecayRate, RecoveryTime}`. Both are intentionally ignored here under the
  sustained-pressure assumption (see `PLAN_LOADOUT_ADVISOR.md` decision 6
  for the mechanics distinction).
- Enumerators should filter out test/edge items (e.g. `…_test`, Health ≈ 1) the
  same way `listShieldItems` filters cosmetic variants, and fall back to `-`
  when `Distortion.MaximumDamage` is absent.
- (Only `Live.zip` is present in `data/`; `PTU.zip` was absent at confirmation.
  Schema is shared - re-confirm against PTU when it returns.)

Original checklist (all satisfied):

1. **Power-plant physical HP** - `stdItem.Durability.Health` on the installed PP
   (`Hardpoints.Components.Systems['Power Plants'].InstalledItems[].BaseLoadout.ClassName`
   → `getItemStats`). Already surfaced in the weapon-picker columns.
2. **Power-plant distortion pool max** - `stdItem.Durability.Distortion.MaximumDamage`.
   Already surfaced as `distHp` in `weaponColumn.js` picker columns.
3. **Per-weapon cadence** - `Weapon.Firing[0].RoundsPerMinute` (+ burst RPM),
   `Ammunition.Capacity`, `HeatParameters` (overheat / `OverheatFixTime`),
   `Consumption` (energy regen / cooldown). All already consumed by `sustained.js`.

Deliverable: a one-paragraph findings note confirming the fields resolve (and
flagging any ship/PP where they're zero or absent, for graceful `-` handling).

## The engine - `js/ttkCalc.js`

### Extended weapon enumeration

`enumerateLoadoutWeaponsForTtk(loadout, slots, disabledPorts)` - same slot walk
as `enumerateLoadoutWeapons`, but each group also carries the **cadence** needed
to place shots on a clock:

```
{ ...existing (className, name, dmgByType, basePen, count, category),
  rpm,         // Weapon.Firing[0].RoundsPerMinute (burst-adjusted if applicable)
  magazine,    // rounds before overheat (ballistic) or energy ammo pool
  reloadTime,  // OverheatFixTime (ballistic) or energy regen + cooldown
  isEnergy }
```

Factor the cadence extraction out of `sustained.js` so the sim and the existing
DPS path share one source of truth (avoids the kind of drift `flattenPort` /
`buildPort` suffered).

### Discrete-event simulator

```
simulateTtk(weaponGroups, opponent, options) -> {
  breakShields, killVital, disablePowerplant, disableDistortion,  // seconds or Infinity
  limiting: { ... },   // why each ∞ outcome stalled (which stage blocked)
  timeline,            // optional: pool HP vs time, for a future chart
}
```

**Algorithm - event loop over a shared, monotonic state:**

1. **State:** `shieldHp` (one face - the breakable pool), `armorHp`,
   `vitalHp` (smallest vital), `powerplantHp`, `distortionPool`. Each weapon
   group gets a `nextFireTime` and an ammo/heat counter.
2. **Loop:** pop the earliest `nextFireTime` across all groups. Fire that
   group's `count` shots (volley) via `simulateShot` against current pools;
   subtract `shieldDmg` / `armorDmg` / `hullDmg`, route `componentDmg` →
   `powerplantHp` and `distortionDmg` → `distortionPool`.
3. **No regen tick.** Pools change only on a hit (sustained-pressure
   assumption). Pools are monotone.
4. **Record** the clock time each pool first crosses 0 (or the distortion pool
   first reaches `MaximumDamage`).
5. **Cadence advance:** `nextFireTime += 60/rpm`; when a group exhausts its
   magazine, add `reloadTime` (energy → regen-limited sustained fire; ballistic
   → `OverheatFixTime` downtime).
6. **Termination:** stop when all four outcomes resolve, OR when a volley makes
   zero net progress on every unresolved pool (all shots deflected) - those
   outcomes are `Infinity`. A `HARD_CAP` on iterations is the backstop (mirrors
   `computeAmmoToBreak`).

Because pools are monotone, TTK reduces to *combined shots-to-break each pool ×
cadence*. The multi-group event loop is simply the cleanest way to combine
weapons firing at different rates against shared pools. The only remaining
per-shot non-linearity is ballistic shield absorption scaling with shield HP
fraction - already handled inside `simulateShot`.

### Outcome semantics

- **Break shields** - clock when `shieldHp` first hits 0.
- **Kill** - clock when `vitalHp` hits 0 (requires shield down + armor/hull
  penetrated, exactly as the deflection chain sequences it).
- **Disable (power plant)** - clock when `powerplantHp` hits 0, fed by
  accumulated `componentDmg`. Naturally `Infinity` if no weapon penetrates to
  components.
- **Disable (distortion)** - clock when `distortionPool ≥ MaximumDamage`, fed by
  `distortionDmg`. `Infinity` only if no weapon deals distortion at all.

## Opponent model - `buildTtkOpponentProfile`

Wrap the existing `buildOpponentProfile` and augment (keep the original's output
byte-identical so the Deflection calc is untouched):

```
{ ...buildOpponentProfile(...),
  powerplant: { hp, maxHp, distortionMax } }   // from the selected PP item
```

No `shieldRegen` block - regen is out of scope. The enemy power plant resolves
like the default shield: first installed PP's `BaseLoadout.ClassName`,
overridable via a dialog dropdown.

## UI - `js/ttkCalcUI.js`

Mirror the Deflection dialog structure:

- **Header:** "Time to Kill" with a relevant icon.
- **Opponent row (Phase A):** ship dropdown + shield dropdown + **power-plant
  dropdown** (new - `listShieldItems`-style enumeration filtered to
  `type === 'PowerPlant'`). **Phase B** expands this into a fuller component
  editor.
- **Toggles:** reuse "Apply armor durability". (No "Model regen" toggle -
  regen is always off.)
- **Footnote:** *"Assumes sustained fire - enemy shield/distortion regen not
  modeled (best-case TTK)."* Weapons fire at full power in v1, consistent with
  the Deflection dialog.
- **Results panel:** a compact summary table - four rows (Break shields / Kill /
  Disable-PP / Disable-distortion) each showing **time** + the limiting factor
  (e.g. "∞ - all shots deflected"). Optionally a per-outcome breakdown of which
  weapon groups contribute.
- **Wiring:** add `#loadoutTtkBtn` to `.lo-analysis-cluster` in `index.html`;
  `initTtkButton()` in `loadoutUI.js` alongside `initDeflectionButton()`.
- Prefs persisted via `saveTtkPrefs` / `loadTtkPrefs`.

## Tests - `test/ttkCalc.test.js`

- Cadence extraction: ballistic overheat vs energy regen vs no-downtime.
- Event ordering: two groups with different rpm interleave correctly on the
  clock.
- Monotonicity: every outcome's time is finite and decreases (or holds) as DPS
  rises; ∞ only when all shots deflect.
- Power-plant disable: finite only when a weapon penetrates to components;
  ∞ otherwise.
- Distortion disable: fills monotonically; ∞ only when no distortion damage.
- One real reference scenario (a fighter loadout vs a known ship) sanity-checked
  against hand math, mirroring the Deflection test's reference cases.

## Risks / open questions

1. **"Reaching" the power plant** - modeling component HP as reachable purely via
   the penetration chain is an approximation (real positional / facing mechanics
   are out of scope). Document it like the Deflection calc's
   `RESIDUAL_PEN_RATIO` note.
2. **Sim cost** - capital ships (huge HP, low incoming DPS) iterate longer; the
   `HARD_CAP` and all-deflected early-out prevent runaway loops.
3. **Full component loadout UI** (Phase 3) is the largest surface - phased to
   de-risk; coolers / radar barely affect TTK, so it's mostly UX completeness.

## Phasing & effort

- **Phase 0 - Data confirmation** (~0.25 day): verify the three fields resolve on
  a real ship + PP. Gates Phase 1.
- **Phase 1 - Engine + tests** (~1-1.5 days): `ttkCalc.js` event sim, extended
  enumerator, profile extension, vitest. Pure logic, fully testable headless.
- **Phase 2 - Dialog, Phase A config** (~1.5 days): modal with ship + shield +
  power-plant dropdowns, results table, durability toggle, button wiring, prefs.
  **This is a shippable v1.**
- **Phase 3 - Full enemy component loadout** (~2-3 days): expand the opponent
  picker into a fuller component editor, building on the Phase 2 dropdown
  pattern.
- Docs: add a TTK section to `FORMULAS.md`; note any extractor asks in
  `TODOS.md`.

**Recommendation:** ship **Phase 0 → 1 → 2** as the milestone (a working, tested
TTK dialog with ship / shield / power-plant selection - which drives essentially
all TTK numbers), then schedule Phase 3 as a breadth follow-up.
