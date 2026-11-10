# Data files

| File | What it is |
| ---- | ---------- |
| `materials.json` | The 36 ores/minerals and the fixed qualities (0-1000) each exists at, by tier (F, E, D, C, B, A, S, Perfect). |
| `resources.json` | The 37 crafting resources used by blueprints. `material` links to a name in `materials.json` (null if it has no tier table). |
| `recipes.json` | 1,617 crafting blueprints: slots, what each slot costs, and how the slot's material quality changes stats. |

## Source

`recipes.json` and `resources.json` are cleaned from the NovaSCDataExtractor output
(`blueprints.json`, `resources.json`) in `NovaTools/data/Live.zip`:
game version 4.10.2.12913470, build 4.10.197.2878, extracted 2026-10-13.
Star Citizen game data belongs to Cloud Imperium Games. Re-run the extractor to refresh
after a game patch.

## recipes.json format

```
{
  id, className, name, type, subType, size, craftTimeSeconds,
  slots: [
    {
      name, displayName,
      costs: [
        { kind: "resource", resourceId, material, quantity }   // a material
        { kind: "item", itemId, itemName, quantity }           // a component item
      ],
      modifiers: [
        { stat, kind, qualityMin, qualityMax, valueMin, valueMax }
      ]
    }
  ]
}
```

Each recipe has one tier in the game data, so slots sit directly on the recipe.

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

- 298 slots cost a **component item** (11 distinct items) instead of a material. The extracted
  data does not name these, so `itemName` is `null`.
- `Yormandi Eye` is in `resources.json` but has no quality tier table (`material` is null).
- Game data spells three materials differently from the tier table. They are mapped:
  `Aluminium` -> `Aluminum`, `Quantanium` -> `Quantainium`, `Saldynium (Ore)` -> `Saldynium`.
- Resource quantities are as given by the game data. `unitType` in `resources.json` is `SCU`.
  Check unit meaning before showing quantities to players.
- One blueprint in the source had no name and was dropped (1,618 -> 1,617).
