# Nova Tools - Calculation Formulas

## Power Distribution (Pip System)

### Channels
Each ship has power distribution channels: Weapons, Boost (Engine), Shields, Quantum Drive, Radar, Life Support, Coolers (one per cooler), and optionally Utility.

### Power Budget (the pip pool)

The total number of pips available to distribute is the power plants' combined
output, computed in `calculateStats()`:

```
powerOutput = Σ round(segment_i / numPPs) + (numPPs - 1) × Σ size_i
```
- `segment_i` = `ResourceNetwork[].Generation[Power].Segment` of each equipped
  power plant, read from the CRAFTED item (so the additive `Power Pips`
  crafting property feeds straight into the budget)
- `size_i` = the power plant's item Size
- Single PP (the common case) collapses to `round(segment)` - the second term
  vanishes. Multi-PP ships get a super-linear bonus term.
- `stats.ppSeg = powerOutput`, i.e. the divisor in the PP EM formula below is
  the same number as the pip budget.
- Disabled ports are skipped entirely, so powering off a PP shrinks the budget.

### Per-Channel Properties
- **Segment (seg)**: Maximum pips the component can consume
- **MinConsumptionFraction (minFrac)**: Minimum power fraction (locked pips = `round(seg * minFrac)`)
- **PowerRanges**: Three tiers (Low, Medium, High) each with `Start` (pip threshold), `Modifier` (0.7/0.85/1.0), and `RegisterRange` (boolean)

### PowerRanges Modifier
At a given pip level, the modifier is determined by the highest `Start` threshold reached:
- If `pips >= High.Start` → modifier = High.Modifier (typically 1.0)
- Else if `pips >= Medium.Start` → modifier = Medium.Modifier (typically 0.85)
- Else if `pips >= Low.Start` → modifier = Low.Modifier (typically 0.7)
- Else → modifier = 0

### RegisterRange Filter
The `RegisterRange` boolean on each PowerRanges entry controls which calculations use that entry:

| Calculation | Filter | Rationale |
|---|---|---|
| **EM signature** | `RegisterRange = true` only | Only High range typically registers EM |
| **Operational heat (IR)** | `RegisterRange = true` only | Same filter as EM |
| **Cooling output** | **ALL entries** (no filter) | Non-linear Low/Medium/High scaling |
| **Shield resistance** | **ALL entries** (no filter) | Non-linear Low/Medium/High scaling |

In code: `getPowerRangeModifier()` filters by RegisterRange (for EM/heat). `getPowerRangeModifierAll()` uses all entries (for cooling/resistance).

---

## Shield System

### Shield Types
- **Bubble shields**: Single shield face - damage from any direction affects the entire shield equally
- **Quadrant shields**: Four independent shield faces (front, back, left, right) - each can be damaged and regenerated independently

Note: Shield generators and shield faces are distinct concepts. A ship may have multiple shield generators (components), and each generator may produce a bubble or quadrant shield with its own face(s).

### Shield Power Selection (Which 2 Get Powered)
Only **2 shields** are actively powered at any time. Selection priority:
1. **Lowest min pips** (ascending)
2. **Highest HP** (descending)
3. **Best grade** (ascending, Grade 1 is best)
4. **Slot order** (ascending, first equipped first)

### Shield Pip Pool
- **Display**: Sum of POWERED shield segments only - unpowered generators are
  hidden from the pip view since they can't be powered (4×AllStop seg=3 with
  2 powered → 6 pips shown, not 12).
- **Locked pips**: Sum of powered shield min pips
- **Effective power draw**: Only top 2 powered shields' segments count toward PP load
- **Underlying `allocated` value**: Auto-allocation sets `allocated = max` (sum of
  ALL shield segments) while click handlers cap at `poweredMax`. The distribution
  function (top-2 powered) caps at the visible pip count either way, so both
  states yield identical heat/EM - the visible `allocated / max` ratio is the
  source of truth for users.

### Shield Pip Distribution

Both IR (cooling demand) and EM use the **top-2 powered shields only**
distribution. Unpowered shield generators don't run, so they contribute 0
heat and 0 EM. Distribution:
1. Give 1 pip to each powered shield, largest segment first
2. Distribute remaining evenly, capped at each shield's segment max
3. Excess pips beyond what the powered shields can absorb are simply unclaimed

This matches Erkul/SPViewer and explains why our previous "all shields share
for IR" formula reported ~25 percentage points too much cooling demand at
auto-allocation on multi-shield ships.

### Shield Charge Time
```
chargeTime = totalHP (all equipped shields) / sum(regen of powered shields)
```
- **All equipped shield generators** contribute their HP to the total (including unpowered ones) - the full shield pool must be recharged regardless of which generators are powered
- **Only powered shield generators** contribute regeneration - unpowered generators add 0 regen
- **Up to 2 shields** can be powered and provide regeneration (minimum 0, maximum 2)
- The powered shields are determined by the power selection priority (min pips → HP → grade → slot), but users can manually override which shields are powered (including powering only 1)
- At reduced power regen scales **linearly** with the channel pip fraction, with
  NO PowerRanges modifier (unlike resistance and cooling):
  ```
  shieldPipFrac    = min(allocated, poweredMax) / poweredMax
  scaledShieldRegen = Σ(RegenRate_i × shieldPipFrac)   over powered shields
  ```
  Note `shieldPipFrac` is one channel-level fraction shared by both powered
  shields, not a per-shield ratio.
- This is universal - max 2 recharging simultaneously regardless of ship size
- Implementation: `computeShieldData()` in `js/statsPanel.js`. Regen and
  resistance read `getItemStats` (uncrafted); only shield HP goes through
  `getCraftedItemStats`.

### Manual Power Toggle Behavior
- Each shield has a power toggle button; only 2 can be powered at any time
- **Turning off a powered shield**: Simply unpowers it (may leave only 1 or 0 powered)
- **Turning on an unpowered shield when <2 powered**: Powers it on directly
- **Turning on an unpowered shield when 2 already powered**: Swaps - removes the lowest-priority currently-powered shield and powers on the selected one
- Manual overrides persist in localStorage per ship and survive page reload
- Resetting shields clears the manual override and reverts to automatic selection

### Shields ↔ Quantum Drive Mutual Exclusion

The shield and QD channels cannot both be powered. Raising one to any non-zero
allocation forces the other to 0, both in the click handler and in the
double-click restore path (`bindPipInteraction` in `js/pipPanel.js`). The pip
panel greys the excluded column with the `mutual-off` class.

### Shield Resistances
Calculated from the **2 powered shields only** (not all equipped shields). Uses PowerRanges modifier (non-linear).

#### Pip Distribution for Resistance
Pips are distributed greedily to powered shields (max 2):
1. Give each powered shield its minimum pips first
2. Fill remaining pips to the first shield up to its max, then the next
   - Example (2 shields, min=1, max=4): 3 pips → [2, 1], 5 pips → [4, 1], 6 pips → [4, 2]
   - Total effective pips = min(allocated, poweredMax)

#### Per-Shield Contribution
```
contribution = modifier(pips) × pips / max
```
- `modifier` from PowerRanges using **ALL entries** (no RegisterRange filter - that filter is for EM only)
- Below the lowest PowerRanges Start threshold, modifier = 0 → contribution = 0

#### Overall Resistance
```
resistance = Minimum + (Maximum - Minimum) × avg(contribution_i)
```
- Average is across powered shields only
- `Minimum` / `Maximum` are themselves the average of `Shield.Resistance.[type]
  .{Minimum,Maximum}` across the powered shields
- At 0 shield pips, all resistances = 0

**Note on `calculateStats`:** the aggregate `stats.shieldRes*` fields in
`loadoutManager.calculateStats()` average across ALL equipped shields and are
not what the panel displays. The Ship Stats card uses the powered-only values
computed by `computeShieldData()`; the aggregate fields survive as raw inputs.

---

## Infrared (IR) Signature

### Formula
```
IR_total = coolingDemand × totalIR_Nominal / totalCoolingOutput × signalMultiplier
```

### Cooling Demand
```
coolingDemand = powerHeat + operationalHeat
```
- **powerHeat** = sum of allocated pips across **non-cooler** channels (1 unit
  per pip). Cooler pips are NOT counted here; the heat the cooler emits while
  running is captured by its own PowerRanges curve in `operationalHeat` (counting
  both the pip cost AND that operational output would double-count). The shield
  channel contributes `min(allocated, poweredMax)` - only powered generators
  actually draw from the PP.
- **operationalHeat** = sum of `segment × modifier × pipFrac` for each component
  with `RegisterRange = true` in its PowerRanges, **including coolers** - the
  cooler itself emits heat while it operates (verified against Erkul/SPViewer).

### Shield Contribution to IR
Uses the **top-2 powered shields distribution** (same as EM). Unpowered shield
generators don't run, so they contribute 0 heat. Each powered shield's
operational heat is included if it has RegisterRange = true entries.

### Signal Multiplier
Ship-level property from `Armor.SignalMultipliers.Infrared`:
- Example: Super Hornet Mk II = +13% (multiplier = 1.13)
- Stealth ships like Sabre/Eclipse = -40% (multiplier = 0.60)
- Many ships = 0% (multiplier = 1.0)

### IR Nominal / Cooling Output terms
Both sums walk the COOLER slots only, reading `ResourceNetwork[0]` of the
**uncrafted** item (`getItemStats`):
- `totalIR_Nominal` = Σ `Signatures.Infrared.Nominal`
- `totalCoolingOutput` = Σ `Conversion[Coolant].Generation.UnitPerSec` - the
  nominal rating, NOT the pip-scaled `coolingSupply` used for the cooling %.

Consequence: a crafted Coolant Rating changes `coolingSupply` (and therefore
the cooling %) but does not move the IR denominator.

### Per-Cooler IR Breakdown
Each cooler contributes proportionally:
```
IR_per_cooler = coolingDemand × cooler_IR_Nominal / totalCoolingOutput × signalMultiplier
```
IR values are linear per pip - no PowerRanges modifier effect on IR output.

---

## Electromagnetic (EM) Signature

### Formula
```
EM_total = (PP_EM + component_EM_sum + weapon_EM) × signalMultiplier
```

### Power Plant EM
```
PP_EM = PP_EM_Nominal × (totalEffectivePips / PP_segment)
```
- `totalEffectivePips` = sum of all allocated pips, but shields only count the **top 2 powered shields' pips** (not all shields)
- PP EM is **not capped** - can exceed 1.0 ratio when total demand > PP output

### Component EM (Shields, Coolers, Radar, Life Support)
```
component_EM = EM_Nominal × modifier × pipFrac
```
- `modifier` = PowerRanges modifier using only `RegisterRange = true` entries
- `pipFrac` = allocated pips / segment
- Components with all `RegisterRange = false` (engine, most weapons) contribute 0 direct EM

### Interdiction / Mining / Salvage / Quantum Drive EM
```
component_EM = EM_Nominal × (allocated / max)
```
- These four channels (EMP/QED, mining, salvage **and the quantum drive**) use
  **linear** scaling because their items intentionally declare
  `RegisterRange = false` on every PowerRanges entry (they're binary on/off
  devices, not modulated). The standard PowerRanges path would zero them out -
  e.g. the Reynie QED's 17 000 EM would never appear.
- The QD channel is `binary: true`, so its ratio collapses to exactly 0 or 1.
- Verified on Mantis: QED powered = 10 532 + PP load delta + 17 000 = 29 017 EM

### EM Nominal per item
`getComponentEM()` takes the **maximum** `Signatures.Electromagnetic.Nominal`
across an item's `ResourceNetwork` nodes, not the sum. Quantum drives ship two
nodes with identical nominals (one per operational mode, spool / cruise) and
only one mode runs at a time; every single-node item collapses to its own
value. `calculateStats` applies the same max-across-nodes rule per item for
both EM and IR.

Exception: `getWeaponMeta()` in `js/weaponColumn.js` SUMS across nodes for the
per-weapon EM readout. Every weapon in the current data has one node, so the
two agree in practice.

### Shield EM
Uses the **top-2 powered shields only** distribution. Unpowered shields contribute 0 EM.

### Weapon EM
```
weapon_EM = sum(weapon_EM_Nominal) × min(allocated, needed) / needed
```
- Weapons scale with weapon power fraction (allocated/needed), not individual pip fraction
- Many weapons have EM=0 (e.g., Panther Repeater); some have small values (e.g., Revenant EM=33)

### Signal Multiplier
Ship-level property from `Armor.SignalMultipliers.Electromagnetic` (same value as IR multiplier for most ships).

---

## Salvage System

### Per-modifier scaled stats
Each `SalvageModifier` item has raw `SpeedMultiplier` / `RadiusMultiplier` /
`ExtractionEfficiency` that are scaled by the parent salvage head's base constants
for display. The standard Baler head (`Salvage_Head_standard`) uses:
```
displayed_speed       = SpeedMultiplier      × 10
displayed_radius_m    = RadiusMultiplier     × 2.18
displayed_efficiency  = ExtractionEfficiency × 0.55
```
Constants live in `SALVAGE_HEAD_BASES` (`js/statsPanel.js`) - keyed by head className,
defaulting to Baler. Both entries present today (`Salvage_Head_standard`,
`Salvage_Head_Salvation`) carry identical values, so the map is effectively one
constant set until per-head numbers are found. SPViewer mislabels the radius value as "Diameter" on its
hardpoint info row, but the source field is `RadiusMultiplier` so NovaTools uses
"Radius" with units in meters.

**Note**: SPViewer shows different constants on the MOTH (3.6 / 1.25 / 0.71) even
though the MOTH equips the same `Salvage_Head_standard` item. The actual source for
those per-ship constants hasn't been found - see TODOS.md → "Salvage scraping math".

### Per-modifier scrape rate
```
rpm  = SpeedMultiplier × 60     (treats SpeedMultiplier as SPS)
rate = rpm / ExtractionEfficiency
```

### Section summary
- **Storage Buffer**: sum of `Hardpoints.Weapons.SalvageHardpoints.SalvageBuffer.InstalledItems[].Capacity` (SCU)
- **Modifiers row**:
  - `Speed` = `min(SpeedMultiplier across scrapers) × head.speed`
  - `Radius` = `min(RadiusMultiplier across scrapers) × head.radius` (falls back to min across tractors when no scrapers are equipped)
  - `Efficiency` = `min(ExtractionEfficiency across scrapers) × head.efficiency`
- **Salvage Rate** (per minute):
  ```
  rate = sum(rpm × eff_i) / slowest_scraper_eff / head.efficiency
  ```
  The per-scraper efficiency in the sum models the head's scraping yield, the
  `/slowest_eff` models the bottleneck slowing the rig down, and `/head.efficiency`
  models the loss going through the head itself. Tractors are excluded entirely -
  a salvage rig can scrape OR tractor at any moment, never both.

### Tractor modules
`SpeedMultiplier` only is shown (typically 1 → displayed as `10x Speed`).
`Radius` / `Efficiency` / scrape rate are omitted because they don't apply.

---

## Cross-Section Signature

### Formula
```
crossSection.axis = Emissions.CrossSection.axis × signalMultiplier    for each of Front, Side, Top
```
- `signalMultiplier` = `Armor.SignalMultipliers.CrossSection`, applied as a
  **direct factor**, not a `1 + x` delta - the same convention IR and EM use
- Cross-section does NOT change with pip allocation. It is static per ship, so
  `scaleCrossSection()` in `js/loadoutManager.js` is called outside the pip
  block in `computeAndSetSignatures`, unlike the IR/EM paths
- Axes that carry no number pass through untouched rather than becoming 0 - a
  few ground vehicles (Greycat MDC / MTC) ship an `Emissions.CrossSection`
  block with empty axes, and the panel renders its placeholder for those
- Rendered as `Front x Side x Top` by `renderSignatures()` in `js/pipPanel.js`

**Confirmed in-game 2026-07-31** on Live 4.9.0.12326004. The **Esperia Prowler**
is the discriminating case: it is the only ship whose CS multiplier (0.55)
differs from both 1.0 and from its own IR/EM multipliers (0.37 / 0.35), so it
separates all three candidate models at once.

| Ship | CS mult | Base F/S/T | Displayed |
|---|---|---|---|
| Esperia Prowler | 0.55 | 3372 / 6765 / 6787 | **1 855 / 3 721 / 3 733** |
| MISC Fortune | 1.5 | 3200 / 6800 / 11000 | 4 800 / 10 200 / 16 500 |
| Drake Buccaneer | 1.0 | 2439 / 9145 / 8535 | 2 439 / 9 145 / 8 535 |

A `1 + mult` reading would have put the Prowler at 5 227 / 10 486 / 10 520 and
an unapplied multiplier at its raw 3 372 / 6 765 / 6 787. Neither matches.
`test/loadoutManager.test.js` pins the factor form so the `1 + x` variant can't
creep back in.

---

## Armor and Hull Stats (Ship Stats card)

These are static per-ship values surfaced in two blocks of the Ship Stats card.
They are stashed on `currentShipConfig.armor` and `currentShipConfig.hull` by
`selectShip()` in `js/loadoutUI.js` and rendered by `renderStats()` in
`js/statsPanel.js`. Both blocks short-circuit when the underlying data is
missing or zero.

### Armor block

| Display | Source | Notes |
|---|---|---|
| Armor HP | `Armor.Durability.Health` | Cyan primary value |
| Damage Deflection: Physical | `Armor.DamageDeflection.Physical` | Flat threshold (damage units below this are blocked) |
| Damage Deflection: Energy | `Armor.DamageDeflection.Energy` | Same |
| Durability Modifiers: Physical | `Armor.Durability.DamageMultipliers.Physical` | Displayed as `(m - 1) × 100 %` with `+/-` sign. Green when negative (less damage taken), red when positive. |
| Durability Modifiers: Energy | `Armor.Durability.DamageMultipliers.Energy` | Same |

### Hull block

| Display | Source | Notes |
|---|---|---|
| Hull HP | `sum(Hull.StructureHealthPoints.VitalParts) + sum(Hull.StructureHealthPoints.Parts)` | Sum of every structural piece (vital + non-vital) |
| Vital Parts | each entry of `Hull.StructureHealthPoints.VitalParts` | One indented row per named part (Nose, Body, …) |
| Dimensions | `(S<Vehicle.Size>) <Length> × <Width> × <Height> m` from `Vehicle.Dimensions` | One decimal place |
| Mass | `Vehicle.Mass` | kg |
| Damage Modifiers: Physical / Energy / Distortion | `Armor.DamageMultipliers.{Physical,Energy,Distortion}` | **Top-level** under `Armor`, distinct from `Armor.Durability.DamageMultipliers` used by the Armor block. Same `(m - 1) × 100 %` formatting and color rules. |
| Signature Modifiers: Electromagnetic / CrossSection / Infrared | `Armor.SignalMultipliers.{Electromagnetic,CrossSection,Infrared}` | Negative = green (less signature), positive = red. Same source as the dynamic EM/IR/CS computation in the Power Distribution panel. |
| Penetration Modifiers: Fuse / Component | `Hull.PenetrationDamageMultiplier.{Fuse,Component}` | Negative = green (less damage penetrates), positive = red. |

**Important:** The hull damage modifiers come from `Armor.DamageMultipliers`
(top-level), which is a different field from `Armor.Durability.DamageMultipliers`
used by the Armor block. These are two distinct multiplier sets in the source
data - one for armor durability damage, one for hull damage taken. On the
Stalker for example, the armor set is `{Phys: 0.9, Energy: 1.35}` (-10% / +35%)
and the hull set is `{Phys: 0.8, Energy: 0.65, Distortion: 1.0}` (-20% / -35% / 0%).

---

## Weapon System

### Weapon Ammo Display

#### Ballistic Weapons
```
Format: "roundsOH / totalAmmo ammo"  (or just "totalAmmo ammo" if no overheat)
```
- `totalAmmo`: magazine capacity (`stdItem.Weapon.Ammunition.Capacity`)
- `roundsOH`: rounds before overheat, accounting for inter-shot cooling:
```
shotInterval = 60 / rpm
if (shotInterval > coolDelay): coolingBetweenShots = coolingPerSec × (shotInterval - coolDelay)
netHeat = heatPerShot - coolingBetweenShots
roundsOH = ceil((overheatTemp - minTemp) / netHeat)
```
- If `roundsOH >= totalAmmo`, display as single number (weapon won't overheat before running dry)

#### Energy Weapons
```
Format: "load X in Ys"
```
- `X = effAmmo × count` where `effAmmo = round(MaxAmmo × ammoMult × powerFrac)`
- `Y = effAmmo / effRegen + Cooldown` - time to fully recharge the pool
- `effRegen = MaxRegenPerSec × regenMult × powerFrac`
- `powerFrac = min(weaponAllocated, weaponNeeded) / weaponNeeded`
- `ammoMult` / `regenMult` are the per-ship weapon modifiers (see Sustained DPS)

**Mixed units, deliberately.** `X` is aggregated across the mount (`count` = the
number of weapons in the group, so an x2 turret shows the combined pool) while
`Y` is per weapon - the guns regenerate in parallel, so multiplying the time
would be wrong. A 25-round M5A on an x2 mount at ~0.74 weapon pips therefore
reads `load 38 in 9.88s`: 19 per gun, 38 total, 9.88 s each. Nothing in the row
says so, which reliably confuses people.

Also note `count` here is `leaves.length` (every port in the group) while the
group's DPS uses `liveCount` (ports that are still powered). Unpowering one gun
of a pair halves the displayed DPS but leaves the ammo figure at the full x2
value.

The weapon table's AMMO column is a different number: it shows raw
`Consumption.MaxAmmo` with no multipliers and no grouping ([ui.js](js/ui.js)),
which is why the picker says 25 where the slot row says 38.

### Weapon Meta Stats

Per-weapon metadata shown below each weapon slot:

#### Left side: Power & EM
- **Power draw**: from `ResourceNetwork[].Consumption` where `Resource === 'Power'` (`UnitPerSec` or `Segment`)
- **EM signature**: `emNom × powerFrac × shipEMMultiplier × count`

#### Right side: Projectile Speed, Fire Time & Cooldown
- **Projectile speed**: `Weapon.Ammunition.Speed` (m/s), shown first when non-zero
- **Continuous fire time**: Energy: `effAmmo / fireRate`. Heat-limited: `roundsOH / fireRate`.
  Continuous-fire weapons (box magazine with no overheat threshold, beams) show
  no fire-time entry at all - `classifyFiringMode` returns `'continuous'` and
  neither branch runs.
- **Overheat cooldown**: `HeatParameters.OverheatFixTime` (heat-limited weapons only)
- Both times are **per weapon** - unlike EM on the left side, they are not
  multiplied by the group count

### Burst DPS
Computed by `computeBurstDPS(firing)` in `js/sustained.js` - the single source
for every burst number (weapon picker, weapon table, loadout slot rows).

Two paths, in priority order:

1. **Burst-fire weapons** - `Firing[0].BurstRoundsPerMinute` present together
   with `DamagePerShot`:
   ```
   burstDPS = alpha × BurstRoundsPerMinute / 60
   ```
   The extractor only emits `BurstRoundsPerMinute` when the inner-burst rate
   exceeds the average with margin (Echion Repeater and similar). Plain
   `RoundsPerMinute` is the average INCLUDING the pause between bursts, so it
   understates the peak for those guns. This path is what makes the number
   match Erkul / SPViewer's "Burst DPS".
2. **Everything else** - plain cannons, repeaters, beams (no
   `BurstRoundsPerMinute` in the data):
   ```
   burstDPS = sum(Firing[0].DamagePerSecond)
   ```
   straight from game data.

Both `alpha` and the fallback sum add up EVERY numeric damage field, including
the FPS-only types (Thermal / Biochemical / Stun). This differs from sustained
DPS, which filters to Physical + Energy + Distortion via `sumShipDamage()`.
Ship weapons carry 0 in the FPS types, so the two agree in practice.

Burst is never pip-scaled, it only has an on/off gate: `getSlotDps()` returns 0
when the weapons channel has no pips allocated and full burst otherwise, since
pips move the ammo pool and regen rate, not the fire rate. Grouped slot rows
multiply by the number of powered weapons in the group, and rounding happens
only at display time.

**The Ship Stats banner goes through the same helper.** `getWeaponDps()` in
[js/combatCalc.js](js/combatCalc.js) calls `computeBurstDPS(firing)` exactly
like `getSlotDps()` does, so the headline Pilot / Turret DPS always equals the
sum of the slot rows. Until 2026-07-31 it summed `Firing[0].DamagePerSecond`
directly and understated burst-fire weapons - on the Vanduul Scythe the banner
read 2 337 against a slot-row sum of 3 282, the 945 vs 1 890 gap on its 'WAR'
Cannon.

The per-damage-type breakdown (`sumSlotDpsByType`) reads `DamagePerSecond`
field by field, so it is rescaled by `getDpsScale()` - the ratio between the
DPS actually shown and the raw `DamagePerSecond` sum. In burst mode that is
1.0 for every weapon without `BurstRoundsPerMinute` and the inner-burst uplift
otherwise; in sustained mode it is the sustained/burst ratio. Without it the
per-type rows would not add up to the total they sit under.

Only two weapons in Live 4.9.0 carry `BurstRoundsPerMinute` at all: the Echion
Repeater (`RSI_Meteor_LaserRepeater_S5`) and the Vanduul 'WAR' Cannon
(`VNCL_NeutronCannon_S5`). Both are filtered out of the picker by
`BESPOKE_PATTERNS`, so the Scythe's default loadout is the only place the
difference is reachable in the UI.

### Sustained DPS
Infinite-time average over fire → regen cycles, with power-fraction scaling
and per-ship weapon modifiers:
```
sustainedDPS = (dmgPerShot × effAmmo) / (fireTime + regenTime)
  fireTime  = effAmmo / fireRate
  regenTime = effAmmo / effRegen + Cooldown
  effAmmo   = round(MaxAmmo × ammoMult × powerFrac)
  effRegen  = MaxRegenPerSec × regenMult × powerFrac
  ammoMult  = ship.Controllers.Weapons.Modifiers.MaxAmmoLoadMultiplier  (default 1)
  regenMult = ship.Controllers.Weapons.Modifiers.MaxRegenPerSecMultiplier (default 1)
```
- **Ship weapon modifiers**: larger ships (Asgard, Javelin, etc.) have per-ship
  multipliers that scale the weapon's base ammo pool and regen rate. Extracted
  from `Hardpoints.Components.Systems.Controllers.Weapons.Modifiers` and stored
  as `config.weaponAmmoMult` / `config.weaponRegenMult` in `loadoutUI.js`
- **Energy weapons**: `effAmmo` and `effRegen` scale with the weapon power fraction
  (fire time shortens with lower power, but Cooldown is fixed - so the ratio
  is non-linear and cannot be approximated by `sustained × powerFrac`)
- **Ballistic weapons with heat**: `effAmmo = roundsBeforeOverheat`, unaffected
  by power fraction or ship modifiers; downtime = `OverheatFixTime`
- **Weapons with no downtime**: the function returns `dmgPerUnit × rate`, i.e.
  `alpha × RPM / 60`. That equals burst DPS for every weapon without a
  `BurstRoundsPerMinute` field; on a true burst-fire weapon the burst figure is
  higher because it uses the inner-burst rate
- **Beams** take a separate branch: `dmgPerUnit = Σ DamagePerSecond` and
  `rate = Firing[0].Beam.MaxEnergyDraw`, so `fireTime = pool / energyDraw` is a
  duration in seconds rather than a shot count divided by a fire rate
- Damage is summed with `sumShipDamage()` - Physical + Energy + Distortion only,
  unlike the burst path which sums every numeric damage field
- All weapon types use `calcSustainedDPS(weapon, consumption, powerFrac, ammoMult, regenMult)`

### Weapon Type
Derived by `deriveWeaponType()` in `js/weaponColumn.js` using a multi-step
lookup:

1. **className** - checked against `WEAPON_TYPE_MAP` keys (e.g. className
   containing `LaserRepeater` → "Laser Repeater")
2. **tags** - each space-separated tag checked against `WEAPON_TYPE_MAP`
3. **Fallback patterns** - both `className` and the resolved item `Name`
   are checked for substrings like `ScatterGun`, `Cannon`, `Repeater`,
   `Gatling`, `Beam`. For scatterguns the damage type determines the
   prefix (Physical → Ballistic, Energy → Laser, Distortion → Distortion).

The resolved name fallback is needed because some items have non-descriptive
classNames (e.g. `AMRS_AAgun_CC_S3` → "PyroBurst Scattergun" - only the
display name reveals it's a scattergun).

### Weapon Deflection Tiers

Implemented in [js/tierEngine.js](js/tierEngine.js). A weapon's tier answers
"how far up the ship roster does this weapon still do damage?". There are eight
steps: `none` plus the seven bands in `DEFLECTION_BANDS`
([js/config.js](js/config.js)).

| Tier | Badge | Colour var | Meaning |
|---|---|---|---|
| `none` | – | `--defl-none` | Cannot out-damage even the lightest fighter |
| `lf` | LF | `--defl-lf` | Clears every light fighter |
| `mf` | MF | `--defl-mf` | ...and every medium fighter |
| `hf` | HF | `--defl-hf` | ...and every heavy fighter |
| `gs` | GS | `--defl-gs` | ...and every gunship |
| `hg` | HG | `--defl-hg` | ...and every heavy gunship |
| `sc` | SC | `--defl-sc` | ...and every sub-capital |
| `cp` | CP | `--defl-cp` | Every ship in the game |

`computeDeflectionLadder(ships)` turns the bands into a threshold per band per
damage type. Each band names ANCHOR SHIPS - the hull that tops that band for
physical and the hull that tops it for energy - and the ceiling is the running
max down the list, so the ladder is monotonic even where the two damage types
disagree. `tierForDamage` then walks the ladder and returns the last band the
weapon's effective damage reaches. Comparisons are `>=`, not `>`.

Bands are anchored to ships rather than to `Role` for two reasons:

- **Role does not track deflection.** No Interceptor out-deflects the toughest
  Heavy Fighter, and the 315-420 physical band is mostly freighters and
  multicrew hulls, not gunships. The `hg` label describes the band's ceiling
  (Anvil Carrack / MISC Starlancer TAC), not its contents.
- **The order changes per damage type.** Aegis Hammerhead beats RSI Polaris on
  physical (531 vs 495) but loses on energy (380 vs 418), and MISC Starlancer
  TAC's 396 energy tops the band below both. A single scalar ladder cannot
  express that; two ladders can.

Thresholds are read from the loaded game data at startup, so a rebalance patch
carries through automatically. The band MEMBERSHIP does not - see the
maintenance note on `DEFLECTION_BANDS`, and re-verify the anchor list whenever
`data/Live.zip` is refreshed. A missing anchor logs a `console.warn`; the top
band has no anchors at all (it reads the global max) so "clears everything"
stays correct even if CIG ships a tougher hull.

Ladder as of Live 4.9.0.12344265 (196 ships after filtering), physical/energy:

```
lf  12/10     mf  24/19     hf  54/43     gs 116/110
hg 420/396    sc 531/418    cp 554/485
```

**Why `gs` stops at the Redeemer.** The next physical cluster up (Asgard,
Paladin and Valkyrie at 139, MSR at 127, Apollo Medivac at 121) looks like it
belongs in the Gunship band, but pulling the ceiling up there stretches the
Heavy Fighter band below it from 22 to 40 immune ships - Deadbolt I (120
physical, 24 immune) and Tarantula GT-870 Mk 1 (61 physical, 40 immune) would
both read "Heavy Fighter". It also puts a medical ship, the Apollo Medivac, on
the gunship line. Those five hulls sit in Heavy Gunship instead, and Anvil
Paladin is consequently one band above its game-data `Role` of "Gunship".

**Effective damage** (`getDeflectionDamage`) is not always alpha:

| Weapon | Value compared |
|---|---|
| Multi-pellet (scattergun, `PerPellet != null`) | per-pellet damage - each pellet is deflected independently |
| Has alpha > 0 | total alpha |
| Neither (beams) | sustained DPS |

**Damage-type routing** via `categorize(Type)`:
- `ballistic` / `mass driver` → Ballistic → compared against physical deflection
- `laser` / `plasma` / `tachyon` / `neutron` → Energy → energy deflection
- `distortion` → Distortion → **bypass**, always the top tier (`cp`)
- anything else → Other → **bypass**, always the top tier (`cp`)

Distortion and Other short-circuit before any threshold comparison
(`getImmuneShips` returns `bypass: true`, `tierForDamage` returns `TOP_TIER`).

`deriveTier()` runs the same ladder for a single mutated weapon record. This is
the path used for the per-port crafted recompute, so it must stay consistent
with `computeTiers`. It caches the ladder on the ships-array identity, since
callers always pass the same `state.allShips` reference.

`tierRank(key)` gives the ladder position (0 for `none` up to 7), so UI code can
compare tiers without hardcoding keys. `CLEARS_FIGHTERS_TIER` (`'hf'`) is the
cutoff the Weapon Deflection banner uses to pick between "partial" and "warn".

#### Tier display

Tier markers appear in three places:
- **Weapon slots** (Loadout Manager) - colored dot after the weapon name inside `.lo-name`
- **Weapon picker** - dedicated "Defl" column between Name and Type, showing the
  two-letter badge plus the immune count. Eight ramp colours are more than a
  0.5em dot can carry, so the picker spells the tier out.
- **Weapon Deflection tab** - 3px `border-left` accent on each `.weapon-item`,
  plus the eight-dot legend under the search filters

Every tier below the top shows a hover tooltip listing all immune ships; the top
tier has none by definition. The immune ship names are stored in
`state.weaponImmuneMap` (keyed by `${Name}||${Size}`) and populated during
`initLoadoutUI` via `getImmuneShips()` from `tierEngine.js`.

`getImmuneShips` returns the list sorted **toughest first on the deflection that
applies to the weapon** - physical for ballistic, energy for everything else -
with name as the tie-breaker so the order is stable across renders. The two
orders genuinely differ: a ballistic weapon lists Hammerhead (531) above
Reclaimer (495), an energy weapon lists Reclaimer (418) above Hammerhead (380).
The Weapon Deflection table inherits that order as its default and only departs
from it when the user clicks a column header.

### Find Deflection - full damage chain

The "Deflection" button in the loadout build bar opens a calculator that
simulates how each equipped weapon's alpha damage flows through an
opponent's defenses. Logic lives in [`js/deflectionCalc.js`](js/deflectionCalc.js)
(pure) + [`js/deflectionCalcUI.js`](js/deflectionCalcUI.js) (modal).

**Each damage type has its own pipeline.** The three components of a
shot's alpha (Physical / Energy / Distortion) run through DIFFERENT
chains - they don't share a single overflow path. Per-stage contributions
sum into the total result for the shot.

```
BALLISTIC (Physical) - SPViewer-matched
───────────────────────────────────────
alpha
  │
  ▼
shield up ?
  ├─ yes  mitigated = alpha × (1 − res.phys)
  │       effAbs    = baseAbs.phys × (shieldHp / shieldMaxHp)
  │       shieldDmg = mitigated × effAbs
  │       postShield = mitigated × (1 − effAbs)
  │         │
  │         ▼
  │       perImpact > threshold.phys ?
  │         ├─ no   DEFLECTED  (shield still ate `shieldDmg`)
  │         └─ yes  armor HP > 0 ?
  │                   ├─ yes  armorDmg = postShield × durMult × hullMult.phys
  │                   │       (overflow past armor HP spills to hullDmg)
  │                   └─ no   hullDmg  = postShield × durMult × hullMult.phys
  │
  └─ no   perImpact > threshold.phys ?
            ├─ no   DEFLECTED
            └─ yes  armor HP > 0 ?
                      ├─ yes  armorDmg = alpha × durMult × hullMult.phys
                      └─ no   hullDmg  = alpha × durMult × hullMult.phys


ENERGY
──────
alpha
  │
  ▼
shield up ?
  ├─ yes  shieldDmg = alpha × (1 − res.energy)
  │       (NO armor damage while shield is up - Glacis-class
  │        shields are 100% absorbing for energy in 4.x data)
  └─ no   perImpact > threshold.energy ?
            ├─ no   DEFLECTED
            └─ yes  armor HP > 0 ?
                      ├─ yes  armorDmg = alpha × durMult × hullMult.energy
                      └─ no   hullDmg  = alpha × durMult × hullMult.energy


DISTORTION
──────────
alpha
  │
  ▼
shield up ?
  ├─ yes  shieldDmg     = alpha × (1 − res.dist)
  │       distortionDmg = alpha × (1 − abs.dist)  → powerplant pool
  │       NO armor or vital damage
  └─ no   distortionDmg = alpha                   → powerplant pool
          (armor 0% dist resist, but bypassed entirely)
```

**Key rules:**

- **The deflection threshold scales with armor integrity**, it is not the raw
  ship stat:
  ```
  armorFrac = armor.hp / armor.maxHp
  threshold = armor.threshold[type] × armorFrac
  ```
  Armor strips → the ship deflects less, reaching 0 at 0% armor (matching
  SPViewer's armor slider). During `computeAmmoToBreak` the armor depletes
  shot by shot, so the gate eases as the volley lands and a weapon that was
  deflected on shot 1 can start landing later in the same run.
- **The gate is per IMPACT, not per trigger pull.** A multi-pellet shot lands
  as `pellets` independent impacts each carrying `postShield / pellets`, so a
  spread whose individual pellets fall under the threshold is deflected in
  full even when summed alpha clears it easily. Once past the gate, damage is
  applied on the FULL `postShield` - the pellets land together and sum back.
- **Armor overflows into hull.** When `postShield > armor.hp` the armor takes
  exactly its remaining HP and the excess passes on:
  `hullDmg = (postShield - armor.hp) × durMult × hullMult`. The comparison
  deliberately uses raw `postShield`, not `postShield × hullMult` (matches the
  Idris MassDriver vs Arrow reference: `(118932 - 3300) × 0.75 = 86724`).
- **Armor durability only applies while armor remains.** At `armor.hp == 0` the
  durability multiplier is neutral regardless of the checkbox, matching the 0%
  row of the mitigation table.
- **The third stage is `hull`, not `vital`.** `computeAmmoToBreak` returns
  `{ shield, armor, hull }` and the UI column is labelled "Hull". Component HP
  pools aren't tracked, so "shots to break a vital subsystem" stopped being
  well-defined past hull break. `smallestVitalHp` survives as the fastest-kill
  hull target.
- **Ballistic** mitigated alpha is SPLIT between shield HP loss and a
  pass-through pool, controlled by the shield's per-type **absorption**
  stat (separate from resistance). At full shield, effAbs ≈ baseAbs
  (e.g. 0.45 for Glacis vs Physical); at empty, effAbs = 0. Deflection
  check runs on the pass-through, not raw alpha - so a Deadbolt IV
  against a fully-shielded Polaris is DEFLECTED until shields drop to
  about 7%, even though raw alpha (683) is well above the 495 threshold.
- **Energy** is "shield-first": no armor damage while shield > 0. Once
  shield drains, alpha must exceed the deflection threshold to damage
  armor (otherwise DEFLECTED).
- **Distortion** never touches armor or hull. It targets a separate
  powerplant distortion HP pool - modeled as `distortionDmg` per shot;
  the pool itself is simulated by the TTK calculator (Distort outcome).
  With `abs.dist = 1.0` (every shield in 4.x data) NOTHING reaches the
  pool until the shield is fully down - distortion is ineffective
  against a live shield beyond its small shield-HP bleed `(1 − res.dist)`.
- **Distortion does not use the penetration mechanic.** As of PTU 4.9
  (4.9.0.12180844) every distortion weapon has
  `BasePenetrationDistance = 0` (Live 4.8.3 still ships 0.42-3.15 m),
  yet in-game testing shows distortion still disables when the shot
  lands on the section of the hull where the components sit. Reach is
  aim-based, so the TTK calculator's "Distance to power plant" gate
  (`ppReach`) applies to physical component damage only and exempts
  distortion (the sim assumes ideal aim).
- **The distortion pool bleeds back off between bursts.** Nothing happens
  for `Durability.Distortion.DecayDelay` seconds after the last distortion
  hit, then the pool drains at `DecayRate` per second. Across the whole
  catalogue `DecayRate × 15 s = MaximumDamage`, so a full pool empties in
  15 s once decay starts. DecayDelay is 1.5 s on 32 generators (including
  the JS-300), 3 s on 24, 4.5 s on 17 and 6 s on 4. A single distortion hit
  restarts the delay, so continuous fire never decays and a cooling pause
  shorter than the delay costs nothing - which is why the TTK calculator's
  pause slider changes distort times so sharply around that threshold.
  When decay outruns the incoming fire the outcome is Infinity with the
  reason `distortion decays faster than it lands`.
- **The distortion pool does not scale with generator count.** Distortion
  damage is explosive: one shot saturates every generator inside the blast
  at full value instead of splitting between them, so a two-plant hull
  fills in the same time a one-plant hull does. `buildTtkOpponentProfile`
  therefore sums `Durability.Health` across generators (a round hits one
  component, so each must be shot down in turn) but takes
  `Durability.Distortion.MaximumDamage` from a single generator. The
  Perseus is the one hull where this is wrong: its two generators sit far
  enough apart that a single blast cannot cover both - see TODOS.md.

**Component (power-plant) penetration chain.** Physical / energy damage that
reaches a subsystem is the LAST step of the chain, applied to whatever
survived every upstream reduction. Full order (`runArmorPipeline`):

```
alpha
  × (1 − shield resistance)              shield Resistance
  − shield absorption portion            shield Absorption (postShield = pass-through)
  × armor durability mult                Armor Durability   (when applyArmorDurability)
  × hull damage mult                     Hull
  = rawThrough
  × Hull.PenetrationDamageMultiplier.Component   Component Penetration (e.g. −70% → ×0.3)
  × penRatio                             armor-fraction ratio, RESIDUAL_PEN_RATIO 6% → 100%
  = componentDmg
```

Worked example (Deadbolt IV vs Anvil Paladin, full shield, Component −50%):
`683 ×0.75 = 512 → −230 absorb → 282 ×0.81 ×0.75 = 171 rawThrough
 ×0.5 ×0.06 = 5.1` component dmg/shot (matches the per-shot verification log).

Two deliberate properties of this chain, kept as-is (2026-06-01):

- **Component Penetration is applied last**, on the post-shield / post-
  armor-durability / post-hull damage - not on raw alpha.
- **`rawThrough` includes the Hull damage multiplier**, so that factor is
  baked into component damage too. This is intentional (tuned against the
  M6A-vs-Guardian reference), even though component HP is a distinct target
  from hull HP. If a future patch shows component damage should NOT inherit
  the hull multiplier, that's a separate change.
- **`BasePenetrationDistance` is only a gate** (`> 0`) plus a display value;
  its magnitude does not yet scale component damage. A depth-based reach
  model is a deferred follow-up - see TODOS.md "penetration-distance reach
  model".

**Armor durability is toggleable.** SPViewer's mitigation table flags
`Armor.Durability.DamageMultipliers` with a ⚠️ icon because the game's
durability code path was stubbed for a long time (bug tracked upstream at
[STARC-198632](https://issue-council.robertsspaceindustries.com/projects/STAR-CITIZEN/issues/STARC-198632)
- recent reports suggest the fix has landed but SPViewer hasn't updated
its display). To avoid forcing one interpretation, the calculator exposes
an **"Apply armor durability"** checkbox in the dialog:

- **Checked (default)** - `armor_dmg = postShield × durMult × hullMult`.
  Game-realistic assuming the fix is live. ~301 dmg on the Deadbolt IV
  vs Polaris @ 7% shield reference case.
- **Unchecked** - `armor_dmg = postShield × hullMult` (matches SPViewer's
  display verbatim - 372.1 on the same reference case).

The toggle threads through `simulateShot(weapon, opponent, { applyArmorDurability })`
and `computeAmmoToBreak(weapon, opponent, { applyArmorDurability })`.
Affects both shield-up post-penetration and shield-down armor/vital damage.

**Bubble-equivalent shield model.** v1 collapses the multi-face quadrant
system into a single HP pool: `totalShieldHp = shieldItem.Shield.Health ×
shieldGeneratorCount`. Per-quadrant simulation is a v1+ follow-up.

**Resistance = maximum.** Opponent shield resistance reads from
`Resistance.[type].Maximum` (assumes full enemy pip allocation). Per-pip
modulation is out of v1 scope.

**Weapon alpha source.** Reads `Weapon.Firing[0].DamagePerShot.{Physical,
Energy,Distortion}` through `getCraftedItemStats(cn, portName)` so
Impact-Force-crafted weapons get scaled damage.

**Weapon enumeration.** Walks `state.currentSlots.weapons` and `.turrets`
recursively, skipping `state.currentDisabledPorts`. Groups by className so
"Deadbolt III × 6" renders as one row with combined ammo aggregation.

**Ammo-to-break.** `computeAmmoToBreak(weapon, opponent)` loops
`simulateShot` until each stage reaches 0 HP, returning shot counts per
stage. `Infinity` for stages the weapon cannot progress on (shield down
AND alpha below armor threshold for every damage component). The default
mode aggregates volleys across the stack (`count` weapons firing in
unison); `shotsPerWeapon: true` divides by count for per-instance display.

**Deflected flag.** A shot is marked `deflected: true` when every damage
type with non-zero alpha was blocked by the armor threshold AND no shield
damage was dealt. Matches the SPViewer convention - a tap on the shield
disqualifies a shot from "deflected" status.

### Weapon Filtering (Loadout Manager Picker)

`openPicker()` in [js/weaponColumn.js](js/weaponColumn.js) applies three passes:

**1. Compatibility** (`getCompatibleItems` → `isCompatible`) - the port's
`Types`, `MinSize`/`MaxSize` and both tag directions. Cosmetic variants
(`cosmeticVariantOf` set), ground-vehicle missile racks and ship-integrated
racks are dropped here.

*Ship-integrated racks* (`findShipIntegratedRacks`) are derived from the ship
data, not listed by hand. A missile/bomb rack with no `RequiredTags` fits every
rack port of its size by tags alone, so two kinds are excluded as swap targets:
- a rack that is only ever mounted in a **locked** port - it cannot be taken
  off in game. "Mounted" covers a ship's hardpoint tree and the ports of
  another item (a module or turret that carries its own racks);
- a rack **nothing mounts** whose display-name key (`@item_Name<Key>`) is not
  derived from its own ClassName and is the name of a rack of the first kind -
  an unfinished copy CIG left in the data.

A never-installed rack that owns its name key stays pickable: the generic racks
sold in shops are never a stock fit. Racks with `RequiredTags` are untouched;
tag matching already confines them and the locked sub-port auto-default needs
them. The set is cached until the ship or item data is swapped.

**2. Placeholder / deprecated pass**
- Name exactly `Radar`, or `@LOC_` anywhere in the name or Class
- `DEPRECATED_ITEMS` - a hand-curated className blocklist at the top of the module

**3. Picker pass**
- `BESPOKE_PATTERNS` className regex:
  `/Fury|VNCL|Vanduul|SanTokYai|Cyclone_MT|_TEMP_|_CitCon|BANU_EnergyRepeater|Bengal_Turret/i`
  (a className match, not a "0 stats" test). It is matched against the WHOLE
  className, so a fragment naming a ship also hides that ship's own flight
  blades and mounts - keep ship names out of it and let
  `findShipIntegratedRacks` handle built-in racks
- `subType === 'Rocket'` - rocket pods use special mounts
- `subType === 'GroundVehicleMissile'`
- `subType === 'UNDEFINED'` on any weapon/missile/bomb type - unfinished stubs
- `stdItem.Name === stdItem.ClassName` - items with no localized name
- `Default_Fixed_Mount*` - 1:1 passthroughs, always hidden
- Turret-only ports show Turret items only; mixed ports hide plain turrets that
  are neither a gimbal/mount nor tag-gated

**Dedup**: by `Name+Size`, and additionally by identical stats for weapons and
salvage modifiers. **Name dedup prefers real stats** - when two entries share
name+size and one has `burstDps === 0`, the one with real DPS replaces it.

### Cluster Missile Damage
For missiles like Rattler that split into sub-missiles:
```
totalDamage = mainExplosionDamage + sum(subMissile explosion damages from stdItem.Ports)
```

### Missile Acquisition Time
```
acquisitionTime = 1 / LockRate (seconds)
```

---

## Cooling System

### Cooling Output
```
effectiveCooling = coolingOutput × modifier × pipFrac
```
- `modifier` from the cooler's PowerRanges using **ALL entries** (no RegisterRange filter - non-linear Low/Medium/High scaling)
- Typical modifiers: Low ≈ 0.7, Medium ≈ 0.85, High = 1.0
- `RegisterRange` filter is only for EM signature calculations, not for cooling/resistance output

### Cooling Demand

Identical to the IR cooling demand - there is one `calculateCoolingStats()` and
both readouts consume it. See [Cooling Demand](#cooling-demand) under Infrared
for the authoritative breakdown. In short:

```
coolingDemand = powerHeat + operationalHeat
```
- `powerHeat` = sum of allocated pips over **non-cooler** channels, with the
  shield channel capped at `poweredMax`
- `operationalHeat` per component = `segment × modifier × pipFrac`, over every
  component with `RegisterRange = true` entries, **coolers included**
- A cooler therefore contributes its operational heat but not its pip cost;
  counting both would double-count it

### Cooling Percentage
```
coolingPercent = coolingDemand / coolingSupply × 100
```
- Over 100% = ship is overheating
- 0% with no cooling = infinite heat (display as overheating, not 0%)

### Default Pip Allocation Priority
1. Minimum engine (must have thrust)
2. Minimum radar, minimum life support
3. Cooling - add cooler pips **one pip at a time** until cooling % ≤ 100, filling
   cooler N completely before starting cooler N+1. Per-pip granularity avoids the
   overshoot of maxing a whole cooler in one step (which can land at ~53% cooling,
   twice the supply needed, burning pips and EM for nothing). During this step the
   other channels are temporarily set to their expected final load for the heat
   estimate: weapons at `needed`, engine and utility at `max`, shields at
   `poweredMax` (not `max`). Radar and LS stay at their minimums here - the
   post-allocation check below covers what they add later.
4. Full shields (budget cost = only powered shields' pips)
5. Full weapons (up to `ceil(needed)`)
6. Full utility
7. Full engine (boost)
8. Full radar, full life support
9. **Post-allocation cooling check** - if cooling ≥ 100% after all allocations
   (e.g. a higher-power radar added heat) AND at least one cooler still has room,
   steal pips one at a time from the lowest-priority channels in the order
   `interdiction → mining → salvage → lifeSupport → radar → engine → utility`
   (never below each channel's `min`) and redirect them to coolers until cooling
   drops under 100%

**Aux channels start unpowered.** Interdiction (EMP/QED), mining and salvage are
never auto-allocated - they are created with `allocated = 0` and the user opts in
from the pip panel. They only appear as channels at all when the loadout draws
power for them.

---

## Turret Classification

Routing happens in `extractSlots()` ([js/loadoutManager.js](js/loadoutManager.js)).

### Pilot-Controlled (Weapons Section)
- **PilotWeapons - always, unconditionally.** Every entry under
  `Weapons.PilotWeapons.InstalledItems` goes to the weapons section regardless
  of its seats or `Slaved` flag. Seats only decide the *label*.
- RemoteTurrets the pilot has control of (`pilotHasControl`, below)
- UtilityHardpoints / UtilityTurrets the pilot has control of **or that carry
  no `RemoteController` block at all**

### Crew-Controlled (Turrets Section)
- MannedTurrets (always)
- **PDCTurrets (always)** - `Weapons.PDCTurrets.InstalledItems`, category `PDC Turret`
- RemoteTurrets the pilot has no control of
- Utility hardpoints / turrets with a `RemoteController` but no pilot access

### Pilot Control (`pilotHasControl`)
One helper decides routing for remote turrets, utility hardpoints and utility
turrets, and feeds the seat label, so the two cannot drift apart:

```js
pilotHasControl(rc) =
     rc.Seats.some(isPilotSeat)                       // the pilot's own seat
  || (rc.Slaved === true && !allSeatsAreGunnerSeats)  // pilot takes over an empty seat
```

`Slaved: true` means the pilot takes the turret over while its own seat is
empty - a copilot-seat turret flown solo, a top turret shared with the pilot.
It does NOT apply when every controlling seat is a dedicated gunner seat
(`/Gunner/i`): that turret is crewed and belongs in the Turrets section, even
though the data still flags it `Slaved`.

### Pilot-Seat Detection
```js
isPilotSeat(s)   = /(^|[._])Pilot([._]|$)/i.test(s) && !/Co_?Pilot/i.test(s)
isCopilotSeat(s) = /CoPilot|Copilot/i.test(s)
isGunnerSeat(s)  = /Gunner/i.test(s)
```
`Pilot` must stand as its own `_`/`.`-delimited token, which covers
`Seat_Pilot`, `Pilot_Seat`, `SeatDashboard_Pilot` and `Pilot_SeatDashboard`
while keeping `CoPilot` / `Co_Pilot` out. `\b` cannot be used here: `_` is a
word character, so `\bPilot` never matches inside a ClassName.

### Inert Turrets
A turret hardpoint is dropped from the slot tree entirely when the port is
locked, the ship data declares no sub-ports under it, and the installed item
has no ports either. These are torpedo/missile aiming cameras, sensor and
scanner heads and cosmetic scoops - nothing equippable, they would only render
as an empty turret row. Editable ports are kept (a gun mount can go there), and
so is a port whose installed item is missing from the item index.

### Seat Labels
- A label shared by several seats always leads with "Pilot", whatever order the
  seats have in the data
- Show "Pilot/Copilot" when multiple different seats control the same turret
- Show "Copilot" on turrets in the Turrets section when copilot controls multiple turrets
- Don't show dedicated gunner labels (Left, Right, etc.) - only Copilot and shared seats

### Turret Position
`extractPosition()` reads `${PortName}_${BaseLoadout.ClassName}` lowercased and
assembles up to three axis parts in fixed order:

1. `nose` or `bridge` anywhere → returns **null** (the name already says where it is)
2. front/forward → `Front`, else rear/back/tail → `Rear` (or `Tail` when the
   keyword was literally `tail`)
3. top/upper → `Top`, else bottom/lower → `Bottom`
4. `_left_` / `_right_` (delimiter-bounded, so "Bright" doesn't match) → `Left` / `Right`
5. If nothing matched and the source contains `main` → `Main`

Only shown in the Turrets section, not Weapons.

---

## Gimbal Mounts

### Sizing
Gimbals (VariPuck) do **NOT** always downsize weapons by 1. The weapon size a gimbal accepts is defined by its `Ports[].MinSize` and `MaxSize`. Common patterns:
- S1 gimbal → S1 weapon (same size)
- S2 gimbal → S1-S2 weapon
- S3 gimbal → S2-S3 weapon
- S4 gimbal → S3-S4 weapon
- S5 gimbal → S4-S5 weapon
- Some ship-specific gimbals accept same-size only (e.g., S2 gimbal → S2 weapon)

**Always check the gimbal's port MaxSize/MinSize** rather than assuming a -1 downsize.

### Types in Picker
When a hardpoint accepts both `Turret` and `WeaponGun` types:
- **Gimbals** (`Mount_Gimbal_S*`) are shown in the mounts table
- **Fixed weapons** can be equipped directly to the slot
- **Ship-specific turrets** (like "Anvil Arrow Turret") are internal game passthroughs and are hidden from the picker unless there are multiple alternatives for that slot (e.g., Buccaneer Spinal Mount, Hornet Ball Turrets)
- **Default fixed mounts** (`Default_Fixed_Mount_S*`) are 1:1 passthroughs and are always hidden

### Auto-Fill Behavior
When selecting a turret that has weapon sub-ports (e.g., Hornet Ball Turret):
- Weapon sub-ports that accept both `Turret` and `WeaponGun` automatically get a matching gimbal equipped
- This mirrors in-game behavior where turret sub-ports default to gimballed weapons

---

## Flight Performance

Base values from `vehicle.FlightCharacteristics`, overridden by the equipped Flight Blade's `Ifcs` data when present. Displayed in the Ship Stats panel.

### Data Sources
| Stat | Vehicle field | Flight Blade override (`stdItem.Ifcs`) |
|---|---|---|
| **SCM speed** | `FlightCharacteristics.ScmSpeed` | `Ifcs.SCMSpeed` |
| **SCM forward boost speed** | `FlightCharacteristics.MasterModes.ScmMode.BoostSpeedForward` | `Ifcs.MasterModes.BoostSpeedForward` |
| **NAV speed** | `FlightCharacteristics.MaxSpeed` | `Ifcs.MaxSpeed` |
| **Pitch rate** | `FlightCharacteristics.Pitch` | `Ifcs.AngularVelocity.Pitch` |
| **Yaw rate** | `FlightCharacteristics.Yaw` | `Ifcs.AngularVelocity.Yaw` |
| **Roll rate** | `FlightCharacteristics.Roll` | `Ifcs.AngularVelocity.Roll` |
| **Boost pitch multiplier** | `FlightCharacteristics.Boost.AngularVelocityMultiplier.Pitch` | `Ifcs.AfterBurner.AngVelocityMultiplier.x` |
| **Boost yaw multiplier** | `FlightCharacteristics.Boost.AngularVelocityMultiplier.Yaw` | `Ifcs.AfterBurner.AngVelocityMultiplier.y` |
| **Boost roll multiplier** | `FlightCharacteristics.Boost.AngularVelocityMultiplier.Roll` | `Ifcs.AfterBurner.AngVelocityMultiplier.z` |
| **Capacitor size** | `FlightCharacteristics.Capacitors.ThrusterCapacitorSize` | `Ifcs.AfterBurner.Capacitor.Size` |
| **Capacitor idle cost** | `FlightCharacteristics.Capacitors.CapacitorIdleCost` | `Ifcs.AfterBurner.Capacitor.IdleCost` |
| **Capacitor usage modifier** | `FlightCharacteristics.Capacitors.CapacitorUsageModifier` | *(no blade equivalent - hull value is kept)* |
| **Capacitor regen / sec** | `FlightCharacteristics.Capacitors.CapacitorRegenPerSec` | `Ifcs.AfterBurner.Capacitor.RegenPerSec` |
| **Capacitor usage curve** | *(absent - resolved from the installed IFCS controller item)* | `Ifcs.AfterBurner.Capacitor.Curves.Usage` |
| **Capacitor regen curve** | *(absent - resolved from the installed IFCS controller item)* | `Ifcs.AfterBurner.Capacitor.Curves.Regen` |

**Blade override is all-or-nothing per field**: `computeFlightStats` uses `||`
fallbacks, so a blade value of 0 falls back to the hull value. When the blade
declares an `AfterBurner.Capacitor` block it replaces `boostCap` wholesale
(keeping only the hull's `usageModifier`, since no blade carries one).

**Note on the usage curve:** the hull's `FlightCharacteristics.Capacitors`
block carries no curve reference at all, so `selectShip` resolves it from the
installed IFCS controller (`Components.Systems.Controllers.Ifcs`) via
`getItemStats`. 259 of the 265 ships with a controller resolve; the rest fall
back to the default 1.0 drain.

### Flight Blade

Some ships (Arrow, Gladius, Avenger, Aurora, F7C variants, etc.) have a swappable Flight Blade slot under `Hardpoints.Components.Avionics.FlightBlade`. Each blade variant adjusts speed vs handling:
- **Standard** - baseline values matching `vehicle.FlightCharacteristics`
- **PHB** (Performance Handling Blade) - lower SCM/Boost, higher P/Y/R
- **TSB** (Top Speed Blade) - higher SCM/Boost, lower P/Y/R

When a non-default blade is equipped, its `Ifcs` values override the vehicle defaults. The boost angular velocity multiplier is the same across all blade variants for a given ship, so boosted P/Y/R scales proportionally with the base P/Y/R.

### Boosted Angular Velocity
```
engFrac = clamp((enginePips - engineMin) / (engineMax - engineMin), 0, 1)
boostedRate = baseRate × (1 + (boostMultiplier - 1) × engFrac)
```
- `boostMultiplier` is typically 1.2 for most ships
- At min engine pips: `engFrac = 0` → `boostedRate = baseRate` (no afterburner)
- At max engine pips: `engFrac = 1.0` → `boostedRate = baseRate × boostMultiplier` (full boost)
- Scales linearly between min and max
- Degenerate case `engineMax === engineMin` yields `engFrac = 0`, not 1 - the
  guard falls to the unboosted end
- The same `engFrac` drives Boost time and Boost regen below

**Note:** The IFCS component's `PowerRanges` in the exported game data are trivial (`Start: 0, Modifier: 1.0` for all tiers, `RegisterRange: false`), so the linear pip-fraction approach is used instead.

### Boost Time

Seconds of continuous boost a full thruster capacitor sustains
(`calculateBoostTime` in `loadoutManager.js`):

```
engFrac   = clamp((enginePips - engineMin) / (engineMax - engineMin), 0, 1)
boostTime = capacitorSize / (idleCost × usageModifier × usageCurve(engFrac))
```

IFCS drains the capacitor while the afterburner is held, at
`idleCost × usageCurve(enginePowerAssignment)`. **Boost length therefore
depends on engine pips** - the same `engFrac` that drives the boosted
rotation rates above.

**The usage curve is the load-bearing term.** `Capacitor.Curves.Usage` is
exported as a bare record GUID, not as points (unlike the sibling
`Curves.AngVelocity`, which the extractor already resolves inline). Only two
curves are referenced across the 225 flight blades, both read from
`Data/Libs/Foundry/Records/capacitorassignment/`:

| Record | GUID | Points | Drain at 0 / full pips | Blades |
|---|---|---|---|---|
| `CapacitorAssignmentInputOutput_Always_1` | `822703ac…` | (0,1) → (1,1) | 1.0 / **1.0** | 190 |
| `CapacitorAssignmentInputOutput_Linear_100_75` | `6bb5a702…` | (0,1) → (1,0.75) | 1.0 / **0.75** | 35 |

Every curve a flight blade references is a straight line between its two
endpoints, so `capacitorCurveValue` lerps between them - no spline
evaluation needed. They are mapped by GUID in `CAPACITOR_CURVES`
(`loadoutManager.js`); unknown GUIDs fall back to 1.0. **Delete that map
once the extractor resolves the curves to points.**

Without the curve the model is provably impossible: the Buccaneer and the
F7C Mk II have identical capacitor parameters apart from size (25 vs 20,
ratio 1.25) yet their boost times are 33.33 vs 20 s (ratio 1.67).

Verified on Live 4.9.0.12326004:

| Ship | Size / Idle | Curve | Computed | SPViewer | In-game |
|---|---|---|---|---|---|
| Anvil F7C Hornet Mk II | 20 / 1.0 | 1.00 | 20.00 s | 20 s ✓ | |
| Anvil Carrack | 20 / 1.0 | 0.75 | 26.67 s | 26.7 s ✓ | |
| Drake Buccaneer | 25 / 1.0 | 0.75 | 33.33 s | 33.33 s ✓ | **~33 s ✓** |
| Aegis Sabre Peregrine | 25 / 1.0 | 0.75 | 33.33 s | 33.3 s ✓ | |
| Aegis Idris-P | 1500 / 50 | 1.00 | 30.00 s | 30 s ✓ | |
| Drake Cutlass Black | 2800 / 20 | 1.00 | 140.00 s | 18.48 s ✗ | **2m20s ✓** |

The table above is the **full-pip** case, which is all SPViewer reports.

**Three in-game stopwatch measurements** (2026-07-29) pin the model down
completely:

- **Buccaneer at full engine pips: ~33 s.** This discriminates all three
  candidate models - it rules out reading the `afterburnerNew` block (would
  give 20 s) and rules out integrating the usage curve as the capacitor
  drains (would give `25 × 4 × ln(4/3)` = 28.8 s). Every flight controller
  record carries both an `<afterburner>` and an `<afterburnerNew>` block;
  the extractor reads the legacy one, and this measurement says that is
  correct. **Do not switch to `afterburnerNew`.**
- **Buccaneer at one engine pip: ~25 s**, exactly the curve's other endpoint
  (drain 1.0). This is what confirms the curve input is the engine power
  assignment rather than a constant, and it is why the row moves with pips.
- **Cutlass Black: 2m20s = 140 s**, exactly as computed. Confirms the legacy
  capacitor scale (2800 / 20) is genuinely live on the Cutlass
  Black/Blue/Red, and that SPViewer's 18.48 s for that ship is simply wrong.
  Ours is the correct figure. (Its curve is `Always_1`, so it is flat across
  the pip range.)

**`LinearCost` / `AngularCost` are deliberately excluded.** They need stick
input to evaluate, and both the Idris-P and the Cutlass Black carry them
(1.0 / 0.2 and 1.0 / 0.1 respectively) yet match without them - the Cutlass
measurement confirms this directly, since including them would have cut its
140 s down drastically. They are 0 on every current-generation blade anyway.

### Boost Regen Time

Seconds to refill a fully drained capacitor, shown as the **Boost regen**
row (`calculateBoostRegenTime`):

```
regenTime = capacitorSize / (regenPerSec × regenCurve(engFrac))
```

All 225 flight blades use `CapacitorAssignmentInputOutput_Linear_50_100`
(`f381647d…`, (0,0.5) → (1,1.0)) for SCM-mode regen, so recharge runs at
**half rate with no engine power and full rate at full power**. This is the
mirror of boost drain: more engine pips make the capacitor both drain slower
and refill faster.

At full pips it collapses to `Size / RegenPerSec`, which is exactly the
`RegenerationTime` the extractor emits and matches SPViewer on every ship
checked:

| Ship | Size / Regen/s | Full pips | Zero pips |
|---|---|---|---|
| Drake Buccaneer | 25 / 0.75 | 33.3 s | 66.7 s |
| Anvil F7C Hornet Mk II | 20 / 0.75 | 26.7 s | 53.3 s |
| Drake Cutlass Black | 2800 / 100 | 28.0 s | 56.0 s |

`RegenNavMode` is a separate and much slower curve (`Linear_10_20`,
`5c844120…`, on 8 blades) and is not modelled - the panel reports SCM
figures throughout.

**Confirmed in-game:** a Buccaneer refills in ~66 s at one engine pip
against the predicted 66.7 s, and in 33.3 s at full pips. Both endpoints of
the regen curve are therefore measured, as are both endpoints of the drain
curve above.

### Example (F7C Hornet Mk II at full engine pips)
- SCM / Boost: 220 / 480 m/s
- Boost time: 20.0 s (agrees with SPViewer for this ship)
- NAV: 1150 m/s
- Pitch / Yaw / Roll: 52 / 43 / 148 °/s
- Boosted: 62.4 / 51.6 / 177.6 °/s

---

## Ship Stats Pip Dependency

Ship stats update dynamically based on pip allocation:

| Stat | Pip-Dependent | Scaling |
|---|---|---|
| **Pilot/Turret DPS** | Yes | 0 pips → 0 DPS (all weapons off). Energy sustained DPS scales by `wpnFrac` |
| **PDC / Anti-personnel DPS** | Yes | Same rule, bucketed separately - see below |
| **Missile Damage** | Yes | 0 weapon pips → 0 (can't fire) |
| **Shield HP** | Partial | 0 only when shield pips = 0, otherwise static |
| **Shield Regen** | Yes | `sum(regenRate × pipFrac)` for powered shields |
| **Shield Charge** | Yes | `totalHP / scaledRegen` |
| **Shield Resistance** | Yes | Per-shield PowerRanges modifier × pips/max (see Shield Resistances) |
| **Cooling** | Yes | Pip-scaled supply from `calculateCoolingStats()` |
| **QD Speed/Spool** | No | Static values |
| **Boosted Pitch/Yaw/Roll** | Yes | `baseRate × (1 + (boostMult - 1) × engFrac)` where `engFrac = (pips - min) / (max - min)` |
| **SCM / NAV / Base Pitch/Yaw/Roll** | No | Static from `FlightCharacteristics`, overridden by equipped Flight Blade `Ifcs` |

### Turret DPS Bucketing

`calcCombatStats()` classifies each turret slot with `turretClassOf()` (which
walks the slot's leaves through `classifyTurretWeapon` from `ttkCalc.js`) into
one of three buckets:

- `pdc` - every leaf classifies as point-defence
- `antipersonnel` - every leaf classifies as anti-personnel
- `combat` - anything else (mixed racks land here)

Only `combat` turrets feed the headline **Turret DPS**. PDC and anti-personnel
never engage a ship hull, so they are split into their own rows in the detail
view and are excluded from the TTK calculator on the same rule. Pilot weapons
are never bucketed - they all count toward Pilot DPS.

### Per-Slot DPS (Weapon & Turret Slots)
Individual weapon slot DPS values also scale with pips via `getSlotDps()`:
- **Burst mode**: Full DPS always shown, **except** 0 when weapon pips are off
- **Sustained mode**: Sustained DPS shown, scaled by `wpnFrac` for energy weapons when under-powered
- `wpnFrac = min(allocated, needed) / needed`

### Weapon Power Efficiency Bar
The WEAPONS section header shows a power bar + percentage:
- `efficiency = min(allocated, needed) / needed × 100`
- **Green (100%)**: Pips meet or exceed weapon demand
- **Gold (<100%)**: Under-powered - weapons fire at reduced capacity
- **Grey (0%)**: Weapon pips off - all weapons disabled

Component-level stats also update:
- **Shield HP per slot**: 0 when shield pips = 0
- **Cooler output per slot**: `baseOutput × modifier × pipFrac` (uses ALL PowerRanges entries)

---

## Pip Scaling for Component Properties

### General Formula
For any component property that scales with pips:
```
effectiveValue = nominalValue × modifier × pipFrac × signalMultiplier
```
Where:
- `modifier` = PowerRanges modifier at current pip level
- `pipFrac` = allocatedPips / segment
- `signalMultiplier` = ship's Armor.SignalMultipliers (for IR/EM/CrossSection)

### Power Plant Scaling
PP properties scale with total load:
```
PP_value = PP_nominal × (totalAllocatedPips / PP_segment) × signalMultiplier
```
PP uses ALL allocated pips (but shields only count top-2 powered).

---

## Data Sources

### Signal Multipliers
Located in vehicle data: `Armor.SignalMultipliers.Infrared`, `.Electromagnetic`, `.CrossSection`

### Cross-Section Values
Located in vehicle data: `Emissions.CrossSection.Front`, `.Side`, `.Top`

### Component Signatures
Located in item data: `ResourceNetwork[].Signatures.Electromagnetic.Nominal`, `.Infrared.Nominal`

### PowerRanges
Located in item data: `ResourceNetwork[].PowerRanges.Low/Medium/High` with `Start`, `Modifier`, `RegisterRange`

---

## Named Builds (Save/Load)

### Storage
- Key: `sc-named-builds` in localStorage
- Structure: `{ [shipName]: { [buildName]: { loadout, pips, shields, disabled, crafting, savedAt } } }`

### Build Contents
A saved build captures the complete ship configuration (`gatherCurrentBuild()`
in [js/buildManager.js](js/buildManager.js)):
- **loadout**: All component selections keyed by port name (`{ portName: className }`).
  The FULL map, not a diff - `applyBuild` replaces rather than merges so ports
  absent from the saved build can't bleed through from the previous state
- **pips**: Power distribution allocation keyed by channel (`{ weapons: 3, shields: 2, ... }`)
- **shields**: Shield power override indices (array of powered shield indices, or null for auto)
- **disabled**: Ports the user powered off, or null when none
- **crafting**: Per-port `{ portName: { slotName: quality } }`, or null when empty
- **savedAt**: Timestamp (ms) for display purposes

`disabled` and `crafting` are omitted (null) when empty so legacy builds saved
before those fields existed keep a stable shape and load byte-identically.

Note the **share-link payload is different**: it stores a loadout DIFF against
the ship defaults (`{ l, p, s, d, c }` in `initShareButton`), not the full map.

### UI
- Inline dropdown bar (`lo-build-bar`) in the ship selector row
- Input field doubles as build name entry and dropdown trigger
- Dropdown shows builds for the **current ship only**, sorted alphabetically
- Button label changes: "Save" for new builds, "Update" for existing builds
- Load: click any row in the dropdown to apply the build
- Delete: × button per row, with confirmation dialog

### Persistence Dual-Storage
Loadout state is stored in two places that must stay in sync:
- **`sc-loadouts`**: Per-ship loadout overrides (survives across sessions)
- **`sc-tabs`**: Tab snapshots including loadout, pips, shields (session workspaces)

Every `saveLoadout()` call is followed by `persistTabs()` to keep both in sync. Without this, stale tab data can overwrite fresh loadout changes on page reload.

### Loadouts saved on another hull
All three stores (`sc-loadouts`, `sc-tabs`, `sc-named-builds`) are keyed by the
ship's display **Name** and hold the full port map, stock items included. When
the hull behind a Name changes - a Gold Standard hull replacing its old twin, a
CIG rework - restoring such a map would lay the old hull's stock shields,
turrets and racks over the new hull, silently.

`isLoadoutForOtherHull(saved, slots, defaultLoadout)` in
[js/loadoutManager.js](js/loadoutManager.js) detects this from **locked ports**:
the user can never change one, so a saved value that differs from the hull's
own can only come from another hull. Only ports locked all the way up the tree
count - below an editable port the user may have swapped the mount, which
legitimately changes what sits underneath.

- `selectShip` and `restoreTab` skip a flagged loadout and start from the hull
  defaults. It is ignored, not deleted; the user's next change overwrites it.
- `applyBuild` shows a toast and applies nothing.
- Share links carry a diff against the defaults, which cannot contain a locked
  port, so they are unaffected.

**Empty slots**: A port set to `null` in `currentLoadout` means "intentionally empty". The `??` operator must NOT be used when reading loadout values, as it treats `null` the same as `undefined` and falls back to the default weapon. Use `port in currentLoadout ? currentLoadout[port] : fallback` instead.

---

## Ship Modules

### Overview
Some ships (e.g., RSI Aurora Mk II) have module slots that accept interchangeable modules. Modules are items with their own sub-port trees that add capabilities like extra shields, missiles, or cargo capacity.

### Module Slot Structure
- Located in `Components.Modules` in the ship hardpoint data
- Each slot has `Types: ["Module"]` and tag-based compatibility (`RequiredTags`, `PortTags`)
- Example: Aurora Mk II has 1x S1 module slot with tag `RSI_Aurora_Mk2_Module`

### Sub-Port Injection
When a module is equipped, its child ports are dynamically injected into the main slot arrays:

- **Shield ports** (type includes `"Shield"`) → injected into `currentSlots.systems` with `category: 'Shields'` and `fromModule: true`
- **Missile ports** (type includes `"Missile"`) → grouped into a single logical rack in `currentSlots.missiles` with `fromModule: true` and `moduleRackCount` set to the total number of ports

When a module is changed or removed, all `fromModule: true` slots are cleaned up before re-injection.

### Module Missile Grouping
Module missile ports are treated as a single rack with multiple identical missiles:
- All missiles in the module must be the same type (single selector for the group)
- `moduleRackCount` multiplier is applied to missile count display (e.g., ×8) and damage calculations
- The rack itself is uneditable (fixed to the module), only the missile type is selectable

### Stat Impact
- Module shields contribute to total Shield HP, regen, and charge time calculations
- Module missiles contribute to total Missile Damage in Ship Stats (multiplied by `moduleRackCount`)
- Shield power selection (max 2 powered) automatically includes module-injected shields
- Pip allocation is rebuilt when modules change

### Known Modules
| Module | Ship | What It Adds |
|---|---|---|
| Aurora Mk II DM Module | RSI Aurora Mk II | 8x S2 missile racks + 1x S1 shield |
| Aurora Mk II TS Module | RSI Aurora Mk II | Additional cargo capacity |

### Radar Component Data
Radar detection sensitivities are at `stdItem.Radar.{IR|EM|CS|RS}.Sensitivity` (not under `SignatureDetection`).
Power data for radars is in `ResourceNetwork[].Consumption` (not `Conversion`).

### Radar Aim Assist Range
Aim assist effective range interpolates between min and max based on pip allocation:
```
frac = (allocated - minPips) / (maxPips - minPips)
effectiveRange = DistanceMin + (DistanceMax - DistanceMin) × frac
```
- Data fields: `Radar.AimAssist.DistanceMin`, `DistanceMax`, `OutsideRangeBufferDistance`
- Fallback field names: `DistanceMinAssignment`, `DistanceMaxAssignment`
- At 0 pips, aim assist range is 0

---

## Quantum Drive

### QD Range Calculation
```
qdRange = currentQFuelCapacity / (MicroUnitPerSec / 1000)
```
- `currentQFuelCapacity` from `Hardpoints.Components.Propulsion.QuantumFuelTanks.TotalQuantumFuelCapacity`
- `MicroUnitPerSec` from `ResourceNetwork[].Consumption` where `Resource === 'QuantumFuel'`
- Displayed in Gm (gigameters) in the QD picker, the loadout stats panel, and the
  crafting popover (derived "Range" row under QD Speed)
- Crafting link: the `Quantum Fuel Burn` modifier scales `MicroUnitPerSec`, so lower
  fuel burn raises range by `1 / modifier` (e.g. -20% burn → +25% range). Because the
  stats panel and picker read the crafted `MicroUnitPerSec`, the displayed range tracks
  the fuel-burn slider automatically.

### QD Cooldown
From `QuantumDrive.StandardJump.Cooldown` - shown in the QD picker table.

---

## Bomb Racks

Bomb racks are extracted from `Hardpoints.Weapons.BombRacks.InstalledItems` and displayed in the missiles section with `category: 'Bomb Rack'`. They use the same flattenHardpoint logic as missile racks.

### Bomb stats

A bomb item carries its stats under `stdItem.Bomb`, not `stdItem.Missile`:
`Bomb.Explosion.Damage` (summed across damage types), `Bomb.Explosion.Radius`
and `Bomb.ArmTime`. The bomb picker (`PICKER_COLUMNS.Bomb`) reuses the missile
row fields, so `extractRowData` in `weaponColumn.js` folds the `Bomb` values into
`missileDmg`, `missileRadius` and `missileArm` (missile values win when present).
The slot summary reads `Bomb` directly and multiplies the per-bomb damage by the
rack's bomb count.

---

## Utility Hardpoints

Utility hardpoints and turrets (`UtilityHardpoints`, `UtilityTurrets`) are extracted from the weapons hardpoint data. They are routed to either the Weapons or Turrets section based on pilot control (same Slaved/seat logic as regular turrets). Utility items get a dedicated pip channel and are marked with `isUtility: true`.

---

## CLASS_PATCHES

Hard-coded class patches for items with missing `Class` fields in the game data (e.g., QuickCool cooler → Competition, Idris/Javelin/Bengal military components → Military). Applied at data load time via the `CLASS_PATCHES` map in loadoutManager.js.

---

## Component Crafting

Per-component material-quality crafting. The user picks a quality value
0-1000 for each slot of a component's blueprint; the resulting modifiers
scale specific `stdItem` stat fields and flow through the existing stat
pipeline. Data is sourced from `data/blueprints.json` (see DATA_SOURCES.md).

### Quality → modifier

Each blueprint slot lists one or more `Modifiers`, each with a piecewise
`QualityRange` and `ModifierRange`. CIG ships the curve in two pieces:

```
QualityRange [0,   500],  ModifierRange [m_low, 1.0]
QualityRange [501, 1000], ModifierRange [1.0,   m_high]
```

At quality `q`, the modifier is the linear interpolation inside the
range that contains `q`:

```
mod = m_lo + (q - q_lo) / (q_hi - q_lo) × (m_hi - m_lo)
```

- `q = 500` → mod = 1.0 (baseline, identity)
- `q < 500` → mod < 1.0 (penalty)
- `q > 500` → mod > 1.0 (bonus)

Implementation: [js/craftingModifiers.js](js/craftingModifiers.js) - pure
math layer, fully unit-tested in
[test/craftingModifiers.test.js](test/craftingModifiers.test.js).

### Multi-slot composition (multiplicative by default)

When multiple slots on the same blueprint affect the same `PropertyName`
(e.g. shield Field Array AND Frequency Controller both touching
"Max. Shield Strength"), their modifiers compose **multiplicatively**:

```
final = mod_slot1 × mod_slot2 × …          identity = 1,  field *= m
```

Verified against the AllStop S1 shield: Field Array @ q=1000 ×
Frequency Controller @ q=1000 = 1.10 × 1.10 = **1.21** → base 3 168 hp
→ crafted 3 833 hp (+21%, not +20%).

**Additive properties.** `PROPERTY_KIND` in
[js/craftingModifiers.js](js/craftingModifiers.js) marks exceptions whose
modifiers are integer steps rather than factors:

```
final = mod_slot1 + mod_slot2 + …          identity = 0,  field += m
```

`Power Pips` is the only additive property today - VOLTAGE REGULATOR and
STATOR CORES each contribute a discrete step (e.g. -2 / -1 / 0 / +1 / +2) to
the power plant's segment count. Use `getPropertyKind()` / `identityFor()`
rather than assuming multiplicative.

**Display-only trait.** `LOWER_IS_BETTER` (currently just `Quantum Fuel Burn`)
flips the good/bad colour of a delta. It has no effect on the math.

### PropertyName → stat-field mapping

Each PropertyName maps to one or more raw fields on the item's
`stdItem`. The full table - verified against PTU.zip:

| PropertyName | TargetType | stdItem path |
|---|---|---|
| `Integrity` | All | `Durability.Health` |
| `Max. Shield Strength` | Shield | `Shield.Health` |
| `Coolant Rating` | Cooler | `ResourceNetwork[].Conversion[Coolant].UnitPerSec` |
| `Quantum Speed` | QuantumDrive | `QuantumDrive.StandardJump.Speed` |
| `Quantum Fuel Burn` | QuantumDrive | `ResourceNetwork[].Consumption[QuantumFuel].MicroUnitPerSec` (current data); falls back to `QuantumDrive.StandardJump.QuantumFuelRequirement` |
| `Min. Assist Distance` | Radar | `Radar.AimAssist.DistanceMin` |
| `Max. Assist Distance` | Radar | `Radar.AimAssist.DistanceMax` |
| `Beam Force` | TractorBeam, SalvageHead | `TractorBeam.Tractor[0].MaxForce` |
| `Full Strength Dist.` | TractorBeam, SalvageHead | `TractorBeam.Tractor[0].FullStrengthDistance` |
| `Max. Distance` | TractorBeam, SalvageHead | `TractorBeam.Tractor[0].MaxDistance` |
| `Max. Volume` | TractorBeam, SalvageHead | `TractorBeam.Tractor[0].MaxVolume` |
| `Efficiency` | SalvageModifier | `SalvageModifier[0].ExtractionEfficiency` |
| `Radius` | SalvageModifier | `SalvageModifier[0].RadiusMultiplier` |
| `Speed` | SalvageModifier | `SalvageModifier[0].SpeedMultiplier` |
| `Power Pips` | PowerPlant | `ResourceNetwork[0].Generation[0].Segment` - **additive**, `+= m` |
| `Impact Force` | WeaponGun, WeaponMining | `Weapon.Ammunition.ImpactDamage.*` **and** `Weapon.Firing[].DamagePerShot.*` **and** `Weapon.Firing[].DamagePerSecond.*` |

**Power Pips flows into the pip budget**: `calculateStats` reads
`gen.Segment` from the crafted stdItem, so a crafted power plant changes
`powerOutput` and therefore the whole pip allocation.

**Impact Force is special**: CIG pre-computes `DamagePerShot` (alpha)
and `DamagePerSecond` (burst DPS) into `Weapon.Firing[i]` alongside
`Ammunition.ImpactDamage`. Verified: `DamagePerSecond = ImpactDamage ×
RoundsPerMinute / 60`. The setter scales all three so the displayed
DPS, alpha, and the per-port deflection-tier recompute (see below)
react to the slider.

FPS-only properties (`Damage Mitigation`, `Min Temp`, `Max Temp`,
`Radiation Dissipation` on character armor, `Fire Rate`/`Recoil *` on
WeaponPersonal) are out of scope and not mapped.

### State + persistence

```
loadoutState.currentCrafting: { portName: { slotName: quality } }
```

- Per-port - two AllStops on different ports keep independent quality
- Default q=500 entries are dropped on commit (compact persistence,
  identity fast path)
- Reset on item swap (`clearPortCrafting(port)` in the picker confirm)
- Persisted with the rest of the tab payload (`tab.crafting`) and
  shared-build payload (`c:` field). Missing field on legacy
  tabs/shares reads as empty → identity → byte-identical behaviour.

### Stat-pipeline integration

`getCraftedItemStats(className, portName)` wraps `getItemStats` and
returns a deep-cloned + mutated copy of the `stdItem` with all modifiers
applied. Empty crafting state → returns the input reference unchanged
(zero-cost fast path). Used by every read site that operates on an
INSTALLED component:

- `calculateStats(loadout)` in loadoutManager
- Shield breakdown in `buildPipAllocation`
- `calculateCoolingStats` (Coolant Rating)
- Per-component slot renders in statsPanel (`renderSystemSlot`,
  `renderInterdictionSlot`, shield expansion, cooler totals, QD range)
- Per-weapon DPS reads in statsPanel (`sumSlotDps`,
  `sumSlotDpsByType`) and weapon-column rendering

### Per-port deflection-tier recompute

When Impact Force is crafted up, the weapon's deflection-tier dot AND
the immune-ship list are recomputed against the new alpha - ships that
were previously immune drop out of the list when crafted alpha clears
their deflection threshold.

Mechanics: `getTierDotHtml` synthesizes a weapon record using the base
`weaponByKey` snapshot + crafted alpha (and proportionally-scaled
sustained DPS), then calls `deriveTier` + `getImmuneShips` from
`tierEngine.js`. Single function, no global tier-map mutation.

Limitations:
- Tier recompute happens only on display; `weaponTierMap` and
  `weaponImmuneMap` (startup cache) still reflect base alpha and are
  used by the Weapon Deflection tab (which is about generic
  weapon-vs-ship comparisons, not per-port crafted variants).

### Build-toggle behavior

`blueprints.json` is currently PTU-only. On Live the file is absent
from the ZIP → `blueprintsByClass` stays empty → `hasCraftingData()`
returns `false` → indicators don't render, popover never opens. When
CIG ships data to Live the feature lights up automatically with no
code change.

### Bulk crafting (grouped weapons)

For x4/x8 turret racks (Connie, Polaris, ball turret with two leaves),
the crafting indicator on the grouped row holds the full peer-port
list. Slider edits fan out to every port in the group so the weapons
stay in lockstep. Single-weapon mounts pass through as no-op
(`peerPorts.length === 1`).

### Crafting summary (Materials view)

A "Materials" button in the loadout build bar opens a modal listing every
craftable component on the current loadout with aggregated resource costs.
Logic lives in [`js/craftingSummary.js`](js/craftingSummary.js).

**Per-component cost.** Sum `Costs[].Quantity` across every slot of
`Tiers[0]`, grouped by resource `GUID`. Only `Type === 'Resource'` entries
are counted - current game data uses no `Type === 'Item'` cost entries
(all blueprint inputs are raw materials).

**Loadout aggregation.** Walk `currentLoadout` (port → className), look up
each className's blueprint, group by className across ports. Per group:
`groupCost = perComponentCost × instanceCount`. Components with no blueprint
(e.g. `Dominator II` missiles) are skipped entirely.

**Filter.** Only components that BOTH have a blueprint AND pass
`isConsumableItem()` (excludes mounts, gimbals, turret bases, missile rack
frames, tool arms) make it into the list. Non-craftable items - missiles,
ship-bespoke weapons, items CIG hasn't published recipes for - are dropped
so the modal stays an actionable shopping list.

**Default-vs-customized flag.** For each group, set `defaultIncluded = true`
if ANY port holding this className was customized (swapped from
`baseLoadout.ClassName` OR has a non-default crafting quality entry in
`currentCrafting`). The UI uses this as the initial checkbox state:
customized = checked, stock-default = unchecked. The user can toggle
individual rows; totals recompute live.

**Unit display.** Resource quantities render with their `UnitType` suffix:
`SCU` → 2-decimal display (e.g. "Agricium 1.16 SCU"), anything else
(`Units`) → integer display with the "Items" label (e.g. "Hadanite 23
Items"). No cSCU conversion - raw `Quantity` matches the per-slot popover
display verified against in-game crafting UI.

**Build gating.** Button visibility tracks `hasCraftingData()` - hidden
when no blueprint data is loaded. Reusing the same gate as per-slot
indicators means data outages hide the feature cleanly without code changes.

**Blueprint lookup is GUID-first.** `getBlueprint(className)` resolves
through the item's `reference` GUID before falling back to className
matching. CIG occasionally renames items between patches (e.g. the
Cry-Star SL → IceBox cooler in Live 4.8.0) but keeps `reference` stable.
A pure className index would silently drop the recipe after such renames.
The fallback handles the rare case where an item record lacks a GUID.

---

## Loadout Advisor (planned - spec ahead of implementation)

> Status: **spec only**, written during Phase 0 of
> [PLAN_LOADOUT_ADVISOR.md](./PLAN_LOADOUT_ADVISOR.md) (2026-07-29,
> Live 4.9.0.12326004). No code implements this yet. The plan file holds
> the findings and rationale behind every constant below.

The Advisor recommends weapon combinations for a chosen ship against a
chosen opponent. It scores candidates on normalized utility axes and ranks
by a weighted sum; each axis contribution doubles as a user-facing reason.

### Range control (`rc`)

Who dictates engagement range. **Boost-dominant, not SCM-based** - the
Arrow's SCM (229) exceeds the M80's (225) while its boost (515) falls short
of the M80's (560), so an SCM-based formula inverts the real matchup.

```
scmRel   = (a.scm   - t.scm)   / max(a.scm, t.scm)
boostRel = (a.boost - t.boost) / max(a.boost, t.boost)
rc       = clamp((0.3 * scmRel + 0.7 * boostRel) / 0.10, -1, +1)
```

- `rc > 0` attacker picks the band, `rc < 0` target dictates, `~0` contested.
- Ships without `FlightCharacteristics` (28 of 293) yield `rc = 0`, flagged
  in the reasons.
- Attacker speeds resolve the equipped Flight Blade; opponent speeds come
  from the raw vehicle record (an opponent's blade is unknowable).
- NAV speed and angular rates are deliberately excluded: NAV is
  out-of-combat travel, angular rates govern turn-fight tracking (a pHit
  concern), neither decides *range*.

### Permanent-damage share

Shield HP and the distortion pool recover; armor, hull, vital and
power-plant physical damage do not. At the decisive outcome:

```
permanentShare = (armor + hull + component + distortion) / total
```

Sourced from cumulative per-layer counters on the TTK sim result
(`damageByLayerAt[outcome]`), NOT from a single full-shield shot: at full
shield every energy weapon leaks exactly 0 (absorption 1.0 on all 4.x
shields), which would collapse the axis to a ballistic/energy flag.
The axis weight ramps with `max(0, -rc)` - permanence only decides the
fight when the target controls disengagement.

### Weapon-channel feasibility

The weapons channel is capped by the ship capacitor, independent of the
power plant:

```
needed   = sum(getPowerDraw(cn).segment)   over the candidate combo
feasible = needed <= shipConfig.weaponPoolSize
powerFrac = min(needed, weaponPoolSize) / needed
```

Cooling is not a discriminator here: the weapons channel allocation caps at
the same `weaponPoolSize` for every candidate, so weapon choice cannot
change its cooling demand.

### Deflection viability (combo-level)

The armor deflection threshold scales with armor fraction
(`runArmorPipeline`), so a weapon deflected at full armor becomes effective
once a partner strips armor. Viability is therefore a **combo** property:

- Hard-filter a combo only when EVERY member is non-viable at full armor
  AND no member can strip armor.
- Per weapon, sub-threshold alpha is **demoted** in the score
  (`lin(alpha / threshold, 1.0, 2.0)`, 0 below 1.0), never excluded.

### Axis curves and intent weights

`lin(x, lo, hi)` is a clamped linear ramp. Curves: `ttk`
`1 - lin(t, 5, 60)`; `permanence` `lin(x, 0, 1)`; `velocity`
`lin(v, 700, 1500)` (global - roster spread is only 700-1500 m/s and flat
across sizes); `rangeCover` `lin(r / sizeBracketMedian, 0.7, 1.4)` (per size
bracket - medians run 2000 m at S1 to 12000 m at S12); `ammo`
`lin(kills, 1, 3)`; `powerFit` `lin(powerFrac, 0.7, 1.0)`.

Weight vectors per intent preset live in one module table in
`advisorCalc.js`; each sums to 1.0. See the plan file for the v1 values.

### Windowed pressure (Phase 3, gated)

When `rc < 0` the target dictates disengagement, so fire comes in windows.
The gap is a bounded tactical heuristic, NOT a kinematic derivation (near-
parity speeds produce absurd kinematic gaps - a 45 m/s edge implies a 44 s
disengage):

```
gapLen = clamp(3 + (7 - 3) * |rc|, 3, 7)     seconds, applied only when rc < 0
```

The band matches fighter-shield `DamagedDelay`..`DownedDelay` (3-7 s): the
faster pilot opens just long enough for their own shield to start
recovering. Because the gap is itself a heuristic, the windowed sim replaces
the static permanence axis only if it outperforms it on the calibration
corpus.
