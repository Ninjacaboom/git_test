# Nova Tools - Data Sources & API Documentation

## Overview

Nova Tools uses two data sources:
1. **NovaSCDataExtractor** - Primary game data (ships, components, hardpoints), produced by our own sibling project
2. **finder.cstone.space** - Component shop availability (sold/purchasable status, prices)

A small Python server handles update detection and shop refreshes.

---

## 1. NovaSCDataExtractor

### Data Files

The extractor (separate repo) produces two plain (unencrypted) ZIP archives, dropped directly into `data/`:

| File | Channel | Contents |
|------|---------|----------|
| `data/Live.zip` | Live | Live build data |
| `data/PTU.zip` | PTU  | PTU build data (only present when a PTU branch is active) |

### ZIP Structure

Each archive contains eight named JSON entries:

| Entry | Contents | Used by |
|-------|----------|---------|
| `metadata.json` | gameVersion / buildVersion / extractionTimestamp / channel | `update_data.py` (writes versions.json) |
| `vehicle_metadata.json` | Slim per-ship summary (Manufacturer, Store, PU, CommLink, CosmeticVariantOf) | cosmetic-variant filter in dataLoader |
| `vehicle_stats.json` | Heavy per-ship stats (Armor, Hull, Emissions, BaseLoadout, VariantOf) | front-end `vehicles` array; `VariantOf` also feeds the cosmetic-variant filter |
| `vehicle_hardpoints.json` | Per-ship hardpoint trees | front-end `hardpoints` array |
| `vehicle_equipment.json` | Component database (~2900 items) | front-end `items` array |
| `blueprints.json` | Component crafting recipes - per-item slot modifiers + resource costs (PTU-only at present) | front-end `blueprints` → `blueprintsByClass` |
| `resources.json` | Crafting resource catalogue - GUID → Name + UnitType | front-end `resources` → `resourcesByGuid` |
| `fps_equipment.json` | Personal weapons / attachments | not currently consumed |

`js/dataLoader.js` opens the ZIP, reads the named entries by filename, parses the JSON, and merges in CStone sold-status data. `blueprints.json` and `resources.json` are best-effort - missing files leave the crafting feature dark (Live build behaviour until CIG ships crafting data there).

### Data Entry: Vehicles (`vehicle_stats.json`)

Top-level vehicle/ship data including:
- `ClassName`, `Name`, `Manufacturer`, `Career`, `Role`, `Size`
- `Mass`, `Dimensions.{Length,Width,Height}` - physical properties (kg, meters)
- `Armor.SignalMultipliers` - Ship-level signature modifiers:
  - `Infrared` - IR emission multiplier (e.g., 0.13 = +13%, -0.40 = -40%)
  - `Electromagnetic` - EM emission multiplier
  - `CrossSection` - Cross-section multiplier
- `Armor.Durability.Health` - Armor HP pool
- `Armor.Durability.DamageMultipliers.{Physical,Energy,Distortion,Thermal,Biochemical,Stun}` - multiplies damage TO the armor durability pool. <1 means the armor takes less damage. Used by the Ship Stats **Armor** section.
- `Armor.DamageDeflection.{Physical,Energy,Distortion}` - flat deflection thresholds (damage below this value is fully blocked)
- `Armor.DamageMultipliers.{Physical,Energy,Distortion}` - top-level multiplier set, **distinct from `Armor.Durability.DamageMultipliers`**. Multiplies damage taken by the hull. Used by the Ship Stats **Hull** section.
- `Hull.StructureHealthPoints.VitalParts.{Nose,Body,…}` - vital structure HP, broken down by named part
- `Hull.StructureHealthPoints.Parts.{Canopy,Wing_Right,…}` - non-vital structural HP per part
- `Hull.PenetrationDamageMultiplier.{Fuse,Component}` - how much damage penetrates fuses / components (1.0 = full pass-through, 0.4 = -60%)
- `Hull.ThrustersHealthPoints`, `Hull.DoorsHealthPoints` - per-thruster / per-door health (not currently surfaced)
- `Emissions.CrossSection` - `Front`, `Side`, `Top` values
- `Crew`, `Cargo`, `Fuel` capacities
- `VariantOf` - base ship's `ClassName` when this hull is a variant. Present on
  35 ships in Live 4.9.0, far better populated than
  `vehicle_metadata.CosmeticVariantOf`. It means SHARED CHASSIS, not "skin":
  `MISC_Freelancer_MAX`, `MRAI_Guardian_QI` and `AEGS_Sabre_Comet` carry it too,
  and `RSI_Constellation_Andromeda` points at the Aquila rather than the other
  way round. The filter in `dataLoader` therefore requires a skin-suffix
  ClassName AND identical deflection on top of `VariantOf` - see "Cosmetic
  variant filtering" below.

### Data Entry: Hardpoints (`vehicle_hardpoints.json`)

Per-ship hardpoint configuration:
- `Hardpoints.Weapons` - `PilotWeapons`, `RemoteTurrets`, `MannedTurrets`, `PDCTurrets`, `MissileRacks`, `BombRacks`, `UtilityHardpoints`, `UtilityTurrets`, `InterdictionHardpoints` (EMP/QED), `MiningHardpoints` (PilotControlled/CrewControlled), `SalvageHardpoints` (PilotControlled/CrewControlled, plus `SalvageBuffer.InstalledItems[].Capacity` in SCU)
- `Hardpoints.Components` - `Propulsion` (PowerPlants, Coolers, QD, Thrusters {Main/Retro/Maneuvering/VTOL}, IFCS), `Avionics` (Radars, LifeSupport, FlightBlade), `Systems` (Controllers/Capacitors)
- **Thrusters** are flat stat blobs in the data - no `PortName`/`Types`/`BaseLoadout`. They have `Name`, `Size`, `Grade`, `ThrustCapacity`, `FuelBurnRatePerMN`, `FuelUsagePerSecond`. Cannot be edited as slots; rendered as a read-only summary aggregated by (kind, size, grade).
- **Salvage modifier items** have `stdItem.SalvageModifier[0]` with `SpeedMultiplier`, `RadiusMultiplier`, `ExtractionEfficiency`. The `SpeedMultiplier` field appears to be the SPS (shots/sec) value despite the name - multiply by 60 to get RPM. See FORMULAS.md → "Salvage System".
- **EMP / QED items** typically declare `ResourceNetwork[0].PowerRanges` with `RegisterRange = false` on every entry. They are binary on/off devices, not modulated like radar - their EM contribution scales linearly with the pip channel's `allocated / max` rather than via PowerRanges.
- Each hardpoint has: `PortName`, `MinSize`, `MaxSize`, `Types`, `PortTags`, `RequiredTags`, `Flags`, `Uneditable`, `BaseLoadout`, `Ports` (sub-ports)
- `RemoteController` on turrets: `Slaved` (bool), `Seats` (array of seat classNames). `Slaved` means the pilot takes the turret over while its own seat is empty - it is not unconditional pilot control (see FORMULAS.md, Turret Classification)
- `Hardpoints.Weapons.BombRacks` - Bomb rack hardpoints (same structure as MissileRacks)
- `Hardpoints.Weapons.UtilityHardpoints` / `UtilityTurrets` - Utility items (tractor beams, etc.)
- `Hardpoints.Components.Propulsion.QuantumFuelTanks.TotalQuantumFuelCapacity` - Ship's quantum fuel capacity
- `Hardpoints.Components.Systems.Controllers.Ifcs.InstalledItems[0].ResourceNetwork` - Engine/boost power data from flight controller
- `Hardpoints.Components.Avionics.FlightBlade.InstalledItems` - Swappable flight blade slot (some ships only). Items have `Ifcs` with `SCMSpeed`, `MaxSpeed`, `MasterModes.BoostSpeedForward`, `AngularVelocity.{Pitch,Yaw,Roll}`, `AfterBurner.AngVelocityMultiplier.{x,y,z}`. Uses `RequiredTags`/`PortTags` for per-ship blade filtering (e.g. `$ANVL_Arrow_Blade`).

### Default Item Resolution (BaseLoadout / InstalledItem)

Default items - the components a ship comes with out of the box - live in two
different places depending on context. Both must be checked when resolving what
goes into an empty slot.

#### Path 1: Ship hardpoint tree (primary)

Most defaults come from the **per-ship hardpoint data** (`vehicle_hardpoints.json`).
Each hardpoint node carries a `BaseLoadout` object with at least `ClassName` and
`Name`, and its `Ports` array contains sub-port nodes with their own
`BaseLoadout` entries - the full tree of defaults is inline.

Example - a regular missile rack on the Aurora Mk II:
```
Hardpoints.Weapons.MissileRacks.InstalledItems[0]
  ├─ BaseLoadout.ClassName = "MRCK_S02_BEHR_Dual_S01"  (the rack)
  └─ Ports[0]
       └─ BaseLoadout.ClassName = "MISL_S01_IR_BEHR_Marksman"  (the missile)
```

`flattenHardpoint()` / `flattenPort()` in `loadoutManager.js` walk this tree
recursively. Every sub-port's default is right there in the data - no extra
lookup needed.

#### Path 2: Item database port tree (module sub-ports)

Module slots in the ship hardpoint data typically have **no `BaseLoadout`** -
the module slot is empty by default. When a module is equipped, its sub-ports
(shields, missile racks) must be resolved from the **item database**
(`vehicle_equipment.json`) via `getItemStats(moduleClassName).Ports`.

Critically, the item DB has **two levels** of port data for nested items:

1. **`stdItem.Ports`** on the module item - contains the module's sub-ports
   with `InstalledItem` objects that include full sub-port trees (rack items
   with their own `Ports` containing default missiles).

2. **`stdItem.Ports`** on the rack item (looked up separately via
   `getItemStats(rackClassName)`) - contains the rack's missile sub-ports but
   **without `InstalledItem`** (no default missile specified).

The module's own port tree (path 1 above) is the authoritative source for
defaults because it carries the complete installed sub-tree. The standalone
rack item in the items DB only defines the port structure (types, sizes) but
not what's installed in it.

Example - Aurora Mk II DM Module's missile rack:
```
getItemStats("RSI_Aurora_Mk2_Module_Missile").Ports[0]          ← module item
  ├─ PortName = "missile_01_rack"
  ├─ InstalledItem.ClassName = "MRCK_S01_RSI_Aurora_Mk2_Combat_Module_Rack"
  └─ InstalledItem.Ports[0]                                     ← has default!
       ├─ PortName = "missile_01_attach"
       └─ InstalledItem.ClassName = "MISL_S02_EM_TALN_Dominator" (Dominator II)

getItemStats("MRCK_S01_RSI_Aurora_Mk2_Combat_Module_Rack").Ports[0]  ← rack item
  ├─ PortName = "missile_01_attach"
  └─ (no InstalledItem - default missile is NOT here)
```

**Rule of thumb:** when resolving defaults for nested items, always prefer the
parent's `InstalledItem.Ports` over a fresh `getItemStats()` lookup on the
child. The parent tree carries the full installed state; the child's standalone
entry only carries structure.

This is implemented in `syncModuleSubPorts()` (`js/buildManager.js`) which
uses `mPort.InstalledItem.Ports` (the module's port tree) with a fallback to
`getItemStats(rackClassName).Ports` (the item DB entry).

### Data Entry: Items (`vehicle_equipment.json`)

Component database (~2800+ items):
- `className` - Unique identifier
- `type` / `subType` - Component category (Shield, Cooler, WeaponGun, Missile, etc.)
- `tags` / `requiredTags` - Space-separated tag strings for compatibility filtering
- `size`, `grade`, `name`, `manufacturer`
- `stdItem` - Full component data:
  - `Shield` - `Health`, `RegenRate`, `DownedDelay`, `DamagedDelay`, `Resistance`, `Absorption`
  - `Weapon` - `Firing[].DamagePerSecond`, `DamagePerShot`, `RoundsPerMinute`, `HeatPerShot`; `Ammunition.Speed`, `Range`, `Penetration`; `Consumption` (energy weapons)
  - `Missile` - `Explosion.Damage`, `TrackingSignal`, `LockRate`, `LockTime`, `ArmTime`, `Speed`, `MaxRadius`
  - `MissileRack` - `Count`, `Size`
  - `Durability.Health`
  - `ResourceNetwork[]` - Power, cooling, signatures (see Formulas doc)
  - `Ports[]` - Sub-component ports (turret weapons, cluster sub-missiles, internal weapon parts)
  - `Weapon.HeatParameters` - `OverheatTemp`, `MinTemp`, `CoolingPerSecond`, `TimeTillCoolingStarts`, `OverheatFixTime`
  - `Weapon.Consumption` - Energy weapon pool: `MaxAmmo`, `MaxRegenPerSec`, `Cooldown`
  - `Radar.AimAssist` - `DistanceMin`, `DistanceMax`, `OutsideRangeBufferDistance` (also `DistanceMinAssignment`/`DistanceMaxAssignment` as fallbacks)
  - `Radar.{IR|EM|CS|RS}.Sensitivity` - Detection sensitivities per signal type
  - `QuantumDrive.StandardJump.Cooldown` - QD cooldown after jump

### `metadata.json`

```json
{
  "gameVersion": "sc-alpha-4.7.0",
  "buildVersion": "4.7.178.50402",
  "p4Change": "11715810",
  "buildDate": "Fri Apr 24 2026",
  "channel": "Live",
  "extractionTimestamp": "2026-05-07T08:50:15",
  "novaVersion": "1.0.0",
  "counts": { "vehicle_metadata": 269, ... }
}
```

### Cosmetic variant filtering

CIG ships paint/livery reskins as full vehicle entries with stats identical to
the hull they reskin. Left in, they duplicate every ship picker entry and pad
the deflection immune-ship lists (a low-tier weapon listed both "Drake Corsair"
and two "Corsair PYAM Exec" rows). `js/dataLoader.js` drops them from
`vehicles` AND `hardpoints` before anything else sees the data, in three stages:

1. **`vehicle_metadata.CosmeticVariantOf`** - CIG's explicit flag. Only
   populated on a handful of Showdown BIS entries.
2. **ClassName suffix patterns** - `_Collector_`, `_Teach`, `_Showdown`,
   `_PYAM_BIS`, `_Touring`, `_Executive_Edition`. `_GS` is NOT one of them:
   Gold Standard is CIG's reworked build of a ship, the one players own.
   Where a `_GS` hull and its pre-rework twin both ship, the old twin is the
   one dropped (`findSupersededByGoldStandard`).
3. **`vehicle_stats.VariantOf`** intersected with a skin-suffix pattern
   (`_Exec_`, bare `_Military`/`_Civilian`/`_Stealth`, `_BTALA`, `_PIR`,
   `_Dunlevy`/`_Valiant`, `_Renegade`, `_Wildfire`) **and**
   identical `Armor.DamageDeflection` to the resolved base. All three conditions
   are required: `VariantOf` alone would also swallow Freelancer MAX, Guardian
   QI and Constellation Andromeda. `VariantOf` occasionally points at an
   intermediate ClassName CIG does not export
   (`ANVL_Lightning_F8C_Exec_Military` → `ANVL_Lightning_F8C_Exec`), so the base
   lookup falls back to the longest surviving ClassName prefix.

A fourth pass (`DEV_PATTERNS`) drops hulls nobody flies: dev/test rigs
(`_TEST`, `_Bomb_Test` - see TODOS.md, the extractor is being changed to stop
emitting those) and `_Display` hulls, the showroom/hangar display copies of a
real ship. A display copy shares the real ship's Name, so left in it surfaces
as a "(Display)" duplicate in every ship list.

Hulls dropped here stay in the ZIP; only their `vehicles` / `hardpoints` rows
are removed. Their items (flight blades, turrets, racks) remain in
`vehicle_equipment.json` and in the item index.

Identical deflection is not on its own proof of a repaint. The F7C-M
Heartseeker (Mk I and Mk II) matches its Super Hornet base on armor but is a
separately sold variant with its own default loadout, and the Mk II owns the
only ports in the data gated on `ANVL_BallisticGatling_Bespoke` - dropping it
orphaned the TMSB-5 Gatling out of `parseWeapons` and blanked the weapon's
Defl / Sust DPS / Ammo columns in the picker. Before adding a suffix here,
check whether the variant's ports differ from the base's, not just its stats.

Bump `DB_VERSION` in `dataLoader.js` whenever these filters change - the
IndexedDB cache stores the already-filtered arrays, and its key only tracks the
data version, so without the bump returning users keep the old roster.

Changing WHICH hull a display Name points at (a Gold Standard hull replacing
its old twin, or a rework) also affects saved loadouts, which are keyed by
Name - see FORMULAS.md, "Loadouts saved on another hull".

### Data Entry: Blueprints (`blueprints.json`)

Top-level array of crafting recipes. One entry per craftable item.
PTU.zip ships this; Live.zip does not (yet). Currently ~1 540 entries;
of those ~486 target ship components (Shield, Cooler, PowerPlant,
Radar, QuantumDrive, WeaponGun, WeaponMining, TractorBeam, SalvageHead,
SalvageModifier, DockingCollar, WeaponAttachment, Misc), the rest cover
character armor + personal weapons.

```jsonc
{
  "TargetGUID":      "…",
  "TargetClassName": "SHLD_GODI_S01_AllStop_SCItem",  // joins to vehicle_equipment.json[].className
  "TargetName":      "AllStop",
  "TargetType":      "Shield",
  "TargetSize":      1,
  "Tiers": [
    {
      "Slots": [
        {
          "Name":        "FIELD ARRAY",                // canonical slot id
          "DisplayName": "Field Array",                // localized label
          "Costs":     [ { "Type": "Resource", "GUID": "…", "Quantity": 0.24 } ],
          "Modifiers": [
            {
              "GPP":           "GPP_Shield_MaxHealth",  // internal property token
              "PropertyName":  "Max. Shield Strength",  // resolved display string
              "QualityRange":  [0,   500],              // piecewise curve, lower half
              "ModifierRange": [0.9, 1.0]
            },
            {
              "GPP":           "GPP_Shield_MaxHealth",
              "PropertyName":  "Max. Shield Strength",
              "QualityRange":  [501, 1000],             // upper half
              "ModifierRange": [1.0, 1.1]
            }
          ]
        }
      ]
    }
  ]
}
```

All current blueprints have exactly one tier. The same `stdItem` is
also embedded with an inline `Crafting` block on `vehicle_equipment.json`,
but it uses raw GPP tokens (`@StatName_GPP_*`) instead of resolved
`PropertyName` strings - NovaTools uses `blueprints.json` as the source
of truth because the display strings are already resolved there.

See FORMULAS.md "Component Crafting" for the math + stat-path mapping.

### Data Entry: Resources (`resources.json`)

Top-level array of crafting resources. ~37 entries. Used only as a
GUID → display-name lookup for the per-slot Cost rows in the crafting
popover ("Gold 0.24 SCU", "Beradom 20 Items").

```jsonc
{
  "GUID":     "06cafea0-49fe-4dce-b0f0-dc583316c66d",
  "Name":     "Taranite",
  "UnitType": "SCU",          // or "Units" for harvestables (display "Items")
  "Category": "mineral",
  "GroupGUID": "8e17c99b-…",
  "ClassName": "Harvestable_Mineral_…",
  "AvailableSCUSizes": [0.125, 1.0, 2.0, 4.0, 8.0, 16.0, 24.0, 32.0]
}
```

Aggregation of resource costs across a loadout (cargo planning) is
explicitly out of scope - see "NOT in scope" in PLAN_COMPONENT_CRAFTING.md.

`update_data.py` reads this to populate `data/versions.json` with the
gameVersion / buildVersion / extractionTimestamp the front-end uses for the
build-toggle label and IndexedDB cache key.

---

## 2. finder.cstone.space API

Provides shop availability data for components (whether they can be purchased in-game).

### Endpoints

#### List Endpoints (sold status)

| Endpoint | Returns |
|----------|---------|
| `GET https://finder.cstone.space/GetCoolers` | All cooler items |
| `GET https://finder.cstone.space/GetPowers` | All power plant items |
| `GET https://finder.cstone.space/GetDrives` | All quantum drive items |
| `GET https://finder.cstone.space/GetShields` | All shield items |
| `GET https://finder.cstone.space/GetSWeapons` | All ship weapon items |
| `GET https://finder.cstone.space/GetSTurrets` | All ship turret items |
| `GET https://finder.cstone.space/GetShipModule` | All ship module items (cargo modules, utility modules, etc.) |

#### Response Format

Each endpoint returns a JSON array:
```json
[
  {
    "ItemId": "02a7f68a-5bdd-4887-a256-20c985a65bda",
    "ItemCodeName": "SHLD_GODI_S01_AllStop_SCItem",
    "Sold": 1,
    ...
  }
]
```

- `ItemCodeName` - Maps to `className` in the item database
- `Sold` - `1` = purchasable in shops, `0` = loot-only / not available
- `ItemId` - Used to fetch detail pages for shop location/price data

#### Detail Pages (shop locations & prices)

For items with `Sold=1`, per-item detail pages contain shop data:

| Item Type | Detail URL Pattern |
|-----------|-------------------|
| Coolers | `https://finder.cstone.space/Coolers1/{ItemId}` |
| Power Plants | `https://finder.cstone.space/Powers1/{ItemId}` |
| Quantum Drives | `https://finder.cstone.space/Drives1/{ItemId}` |
| Shields | `https://finder.cstone.space/Shields1/{ItemId}` |
| Weapons | `https://finder.cstone.space/ShipWeapons1/{ItemId}` |
| Turrets | `https://finder.cstone.space/ShipTurrets1/{ItemId}` |
| Modules | `https://finder.cstone.space/ShipModule1/{ItemId}` |

Each detail page contains an HTML table with columns: LOCATION, BASE PRICE, VERIFIED.

### Data Storage

#### Sold Status - `data/sold_status.json`
```json
{
  "SHLD_GODI_S01_AllStop_SCItem": 1,
  "COOL_AEGS_S01_Bracer_SCItem": 1,
  ...
}
```

#### Shop Data - `data/shop_data.json`
```json
{
  "SHLD_GODI_S01_AllStop_SCItem": [
    { "location": "Stanton - ArcCorp - Area18 - Centermass", "price": 10500 },
    ...
  ],
  ...
}
```
- Keyed by `ItemCodeName` (className)
- Each entry is an array of shop locations with prices
- Only populated for items with `Sold=1` that have actual shop listings
- Fetched by scraping CStone detail pages (rate-limited with 0.15s delay between requests)

### UI Integration

- Items with `sold === 0` get the CSS class `loot-only` in the picker (dimmed/grey row)
- Sold status covers all component types: coolers, power plants, quantum drives, shields, weapons, turrets, and modules
- Sold status is merged into items at load time via `mergeSoldStatus()`
- Shop data is stored for future use (shopping basket feature)

### Deprecated items blocklist

Some items in the extracted database are still listed despite being effectively
removed from the game - usually leftover class entries whose referenced
sub-parts (installed cargo grids, gun barrels) no longer exist in the items
DB. Most items with broken sub-references are still legitimate (capital-ship
weapons, RSI-store-only modules, bespoke ship-specific components), so we
do **not** filter broadly on "missing child reference".

Instead, `js/weaponColumn.js` exports a hand-curated `DEPRECATED_ITEMS` Set
that the picker uses to hide individual classNames. Each entry must meet
all three criteria before being added:

1. Not referenced as `BaseLoadout.ClassName` or `InstalledItem.ClassName`
   anywhere in any of the 200+ ship hardpoint trees
2. `sold === 0` in CStone (not purchasable in any shop)
3. References at least one missing sub-item that proves it's broken
   (e.g. an `InstalledItem.ClassName` that `getItemStats()` can't resolve)

Current entries:

| className | name | replacement |
|---|---|---|
| `ANVL_Hornet_F7C_Mk2_Cargo_Mod` | Stor*All Big Box Model H | Replaced by `ANVL_Hornet_F7C_Mk2_Cargo_Door` (Stor*All Big Box Model H2), the stock center-hardpoint module on Anvil F7C Hornet Mk II |

When the extractor adds a deprecation flag to its item entries, this list
should become data-driven and the constant can be removed.

---

## 3. Update Check System

### Server-Side (`server.py`)

#### Check for Updates
```
GET /api/check-updates
```
- Compares the filesystem mtime of `data/Live.zip` and `data/PTU.zip` against
  the `extractionTimestamp` recorded in `data/versions.json`
- Returns: `{ "hasUpdates": true/false, "updates": { "Live.zip": { "remote": "...", "local": "..." } } }`
- Surfaces a banner when the extractor has dropped a fresher archive but
  `update_data.py` hasn't been re-run yet

#### Run Update
```
GET /api/update-data
```
- Executes `update_data.py` as a subprocess
- Streams stdout to the client via chunked transfer encoding
- On success, the script refreshes `data/versions.json` from the embedded
  `metadata.json` of each archive and re-fetches CStone data
- Client clears IndexedDB cache and auto-refreshes the page

### Client-Side (`app.js`)

On page load:
1. `checkForUpdates()` calls `/api/check-updates`
2. If updates available, shows a banner with "Update now" button
3. Clicking "Update now" calls `/api/update-data` and streams the log output
4. On completion, clears IndexedDB cache (`NovaTools`) and reloads the page

### Data Flow

```
NovaSCDataExtractor (sibling project)
  ├── data/Live.zip ──────────────────────┐
  └── data/PTU.zip ──────────────────────┤
                                          ▼
                              update_data.py
                                          │
                    ┌─────────────────────┤
                    ▼                     ▼
          data/versions.json     (CStone fetch)
                                          │
finder.cstone.space                       │
  ├── GetCoolers   ───┐                   │
  ├── GetPowers    ───┤                   │
  ├── GetDrives    ───┼──► data/sold_status.json
  ├── GetShields   ───┤                   │
  ├── GetSWeapons  ───┘                   │
  │                                       │
  └── Detail pages ───────► data/shop_data.json
      (Coolers1, Powers1,                 │
       Drives1, Shields1,                 │
       ShipWeapons1)                      │
                                          ▼
                              Browser (dataLoader.js)
                                          │
                    ┌─────────────────────┤
                    ▼                     ▼
             IndexedDB cache     ZIP read (zip.js, no AES)
                                          │
                    ┌───────────┬─────────┼─────────┐
                    ▼           ▼         ▼         ▼
               vehicles    hardpoints   items   sold_status
                    │           │         │         │
                    └───────────┴─────────┴─────────┘
                                    │
                              Application
                    (weaponParser, loadoutManager, UI)
```
