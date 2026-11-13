# Data files

| File | What it is |
| ---- | ---------- |
| `materials.json` | The 36 ores/minerals and the fixed qualities (0-1000) each exists at, by tier (F, E, D, C, B, A, S, Perfect). |
| `resources.json` | The 37 crafting resources used by blueprints. `material` links to a name in `materials.json` (null if it has no tier table). |
| `recipes.json` | 1,580 crafting blueprints: item details, slots, what each slot costs, and how the slot's material quality changes stats. |

Rebuild `resources.json` and `recipes.json` after a game patch with:

```
node tools/build-databank.mjs "<folder with the extractor's JSON files>"
```

(needs `blueprints.json`, `resources.json`, `fps_equipment.json`, `vehicle_equipment.json` from the extractor output).

## Source

`recipes.json` and `resources.json` are cleaned from the NovaSCDataExtractor output
(`blueprints.json`, `resources.json`) in `NovaTools/data/Live.zip`:
game version 4.10.2.12913470, build 4.10.197.2878, extracted 2026-10-13.
Star Citizen game data belongs to Cloud Imperium Games. Re-run the extractor to refresh
after a game patch.

## recipes.json format

```
{
  id, className, name, description, type, subType, size, grade, manufacturer, craftTimeSeconds,
  variantOf,   // className of the base item if this recipe is itself a skin, else null
  skins: [ { className, name, recipeId } ],   // skins of this item (recipeId null if the skin has no recipe of its own)
  slots: [
    {
      name, displayName,
      tiers: [ { tier, quality } ],   // qualities this slot's material can be used at (see "F tier" below)
      costs: [ { resourceId, material, unitType, quantity } ],   // unitType: "SCU" (ore) or "Units" (harvested items)
      modifiers: [
        { stat, kind, qualityMin, qualityMax, valueMin, valueMax }
      ]
    }
  ]
}
```

Each recipe has one tier in the game data, so slots sit directly on the recipe.

## F tier

F tier (the lowest quality of each material) is only offered for **mining lasers** (type `WeaponMining`).
Every other recipe's `slots[].tiers` starts at E tier. To change which recipe types may use F tier, edit
`F_TIER_ALLOWED_TYPES` in `tools/build-databank.mjs` and rebuild. `materials.json` itself still holds
every tier.

## Quality to stat value

Quality is 0-1000 per slot. **500 is the baseline** (what NPC-store items have).

For a slot at quality `q`, take each modifier whose `qualityMin <= q <= qualityMax`:

```
fraction = (q - qualityMin) / (qualityMax - qualityMin)
value    = valueMin + fraction * (valueMax - valueMin)
```

- `kind: "multiplier"`: the stat is multiplied by `value`. A `0-1000` range of `0.9..1.1`
  gives 0.9 at q=0, 1.0 at q=500, 1.1 at q=1000. Quality outside every range = 1 (no change).
- `kind: "additive"`: the stat changes by `value`. These are stepped bands (for example Power
  Pips: -2, -1, 0, +1, +2 across `0-249`, `250-499`, `500-699`, `700-899`, `900-1000`).
  Quality outside every range = 0.
- Several slots affecting the same `stat` multiply together (additive ones add).

This is the same rule NovaTools uses (`NovaTools/js/craftingModifiers.js`).

## Known gaps

- 298 slot costs are harvested items counted in `Units` (for example Hadanite, Dolivine) rather than mined ore in `SCU`.
- `Yormandi Eye` is in `resources.json` but has no quality tier table (`material` is null).
- Game data spells three materials differently from the tier table. They are mapped:
  `Aluminium` -> `Aluminum`, `Quantanium` -> `Quantainium`, `Saldynium (Ore)` -> `Saldynium`.
- Quantities are stored as given by the game data (ore in SCU). The web page shows ore in cSCU (1 SCU = 100 cSCU), see `web/src/format.ts`. Check what the amounts mean in the game before relying on them.
- `manufacturer` and `grade` are only filled for the 642 recipes that match a weapon or ship component in the
  equipment data. Armor and the rest have `null` there. `skins` is only filled for weapons and ship components,
  and armor variants (such as Shrike and Talon) are separate recipes instead.
- One blueprint in the source had no name and was dropped (1,618 -> 1,617).
- Weapon ammo (the 36 magazines and batteries, type `WeaponAttachment`) is left out on purpose
  and the TH-01 Propulsor mission item is too (1,617 -> 1,580). To change what is excluded, edit `EXCLUDED` in `tools/build-databank.mjs` and rebuild.

## Weapon stats

Each recipe has `baseStats`: extra item stats that are not in the description text. For weapons these are `Damage` (impact damage per hit, all damage types added, with the pellet count for shotguns) and `Rate Of Fire` (rounds per minute of the first firing mode). The front end uses these instead of any matching line in the description.

## Blueprints with no mission source

A blueprint is only listed if `blueprints.json` gives at least one mission (`RewardSources`) that can reward it. Missions the game marks as not-for-release or work-in-progress (`missions.json`) do not count. Blueprints with no usable mission are left out because they cannot be obtained. This is the `REQUIRE_MISSION_SOURCE` switch in `tools/build-databank.mjs`. Note this only reflects the extractor's mission data; a blueprint could still come from something it does not cover (store, event, pledge).

## Armour variants

Armour colour and pattern variants are separate items in the game data. The build groups them by class name (the family is the class name without its last two `_xx_yy` parts), picks the `_01_01_01` item as the base (or the shortest name if there isn't one) and sets `variantOf` on the others, so they appear as skins of the base armour.

## Armour Damage Mitigation (completed by the build)

All armour Damage Mitigation runs from -15% at 0 quality to +15% at 1000 (0% at 500). The extractor gives the third material of most 3-material armours no stat effect, so the build puts whatever the other materials do not cover on that empty last slot (for example x0.95-1.05 next to a x0.9-1.1 slot, x1.0-1.05 next to x0.85-1.1). A single-material armour whose low end is out of line (Venture Legs, 0.8) is set to 0.85. The BUL-H4 juggernaut suit (class name contains `superheavy`) works differently in game and is left exactly as the extractor gave it. Temperatures are not touched, and radiation does not change with crafting.

## How effects from several slots combine

Percentage (`multiplier`) effects on the same stat from different slots add their changes: slots at +10% and +5% give +15%, not x1.1 x1.05. This matches the game (a heavy armour crafts to exactly 46%, not 46.2%). The rule is in `QualityMath.RecipeEffects`.

## Armour weight

Armour recipes have `armourWeight`: `light`, `medium`, `heavy` or `superheavy` (the juggernaut suit), taken from the class name, or the `Item Type` line when the class name has none. Flight suits and helmets, and everything that is not armour, have none. The site's "Armour weight" filter uses it.

## Clothing

Clothing (`Char_Clothing_*`) is left out of the store (`EXCLUDED_TYPE_PREFIXES` in `tools/build-databank.mjs`).

## FPS weapon category

Hand-held weapons have `weaponCategory` (`pistol`, `smg`, `rifle`, `sniper`, `shotgun`, `mg`, `crossbow`), from the `Item Type` line of the description. `rifle` covers the Assault Rifles and the two energy Rifles, `mg` covers LMGs and the HMG. The search takes `type=WeaponPersonal:pistol`.
