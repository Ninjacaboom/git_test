/**
 * Component crafting - pure math + stat-path mutation.
 *
 * Reads CIG blueprint definitions (data/blueprints.json) and produces a
 * modified copy of an `stdItem` whose stat fields have been multiplied
 * by the per-slot quality modifiers.
 *
 * Quality scale: 0-1000 per slot. q=500 is baseline (modifier = 1.0).
 * Below 500 ranges into a penalty (e.g. 0.8 at q=0), above 500 into
 * a bonus (e.g. 1.2 at q=1000). Multiple slots affecting the same
 * PropertyName compose multiplicatively (verified against PTU data:
 * AllStop Field Array @ q=1000 × Frequency Controller @ q=1000 =
 * 1.10 × 1.10 = 1.21, matching screenshot 3 833 hp from base 3 168 hp).
 */

export const DEFAULT_QUALITY = 500;
export const MIN_QUALITY = 0;
export const MAX_QUALITY = 1000;

/**
 * PropertyName → setter. Each setter mutates the cloned stdItem in
 * place, multiplying the affected stat field by `m`. Setters are
 * defensive: missing fields are silent no-ops so the wrapper survives
 * data shape variations (e.g. SalvageModifier items have no
 * `Durability.Health`; mining weapons have no `Weapon.Ammunition`).
 *
 * Adding a new modifier = one entry here.
 */
const PROPERTY_SETTERS = {
  'Integrity': (item, m) => {
    if (item.Durability && typeof item.Durability.Health === 'number') {
      item.Durability.Health *= m;
    }
  },
  'Max. Shield Strength': (item, m) => {
    if (item.Shield && typeof item.Shield.Health === 'number') {
      item.Shield.Health *= m;
    }
  },
  'Coolant Rating': (item, m) => {
    const rn = item.ResourceNetwork;
    if (!Array.isArray(rn)) return;
    for (const node of rn) {
      if (!Array.isArray(node.Conversion)) continue;
      for (const conv of node.Conversion) {
        const gen = conv.Generation;
        if (gen && gen.Resource === 'Coolant' && typeof gen.UnitPerSec === 'number') {
          gen.UnitPerSec *= m;
        }
      }
    }
  },
  'Quantum Speed': (item, m) => {
    const sj = item.QuantumDrive?.StandardJump;
    if (sj && typeof sj.Speed === 'number') sj.Speed *= m;
  },
  'Quantum Fuel Burn': (item, m) => {
    // Fuel burn lives in two possible shapes depending on the data build:
    //  - StandardJump.QuantumFuelRequirement (fuel per unit distance), and/or
    //  - ResourceNetwork Consumption MicroUnitPerSec (fuel per second) - the
    //    form used by every QD in the current Live/PTU data.
    // Scale whichever is present. MicroUnitPerSec is what the jump-range
    // derivation reads (range = fuel capacity / burn rate), so scaling it is
    // what makes "lower fuel burn -> longer range" actually flow through.
    const sj = item.QuantumDrive?.StandardJump;
    if (sj && typeof sj.QuantumFuelRequirement === 'number') {
      sj.QuantumFuelRequirement *= m;
    }
    for (const node of item.ResourceNetwork || []) {
      for (const conv of node.Consumption || []) {
        if (conv.Resource === 'QuantumFuel' && typeof conv.MicroUnitPerSec === 'number') {
          conv.MicroUnitPerSec *= m;
        }
      }
    }
  },
  'Min. Assist Distance': (item, m) => {
    const aa = item.Radar?.AimAssist;
    if (aa && typeof aa.DistanceMin === 'number') aa.DistanceMin *= m;
  },
  'Max. Assist Distance': (item, m) => {
    const aa = item.Radar?.AimAssist;
    if (aa && typeof aa.DistanceMax === 'number') aa.DistanceMax *= m;
  },
  'Beam Force': (item, m) => {
    const t = item.TractorBeam?.Tractor?.[0];
    if (t && typeof t.MaxForce === 'number') t.MaxForce *= m;
  },
  'Full Strength Dist.': (item, m) => {
    const t = item.TractorBeam?.Tractor?.[0];
    if (t && typeof t.FullStrengthDistance === 'number') t.FullStrengthDistance *= m;
  },
  'Max. Distance': (item, m) => {
    const t = item.TractorBeam?.Tractor?.[0];
    if (t && typeof t.MaxDistance === 'number') t.MaxDistance *= m;
  },
  'Max. Volume': (item, m) => {
    const t = item.TractorBeam?.Tractor?.[0];
    if (t && typeof t.MaxVolume === 'number') t.MaxVolume *= m;
  },
  'Efficiency': (item, m) => {
    const sm = item.SalvageModifier?.[0];
    if (sm && typeof sm.ExtractionEfficiency === 'number') sm.ExtractionEfficiency *= m;
  },
  'Radius': (item, m) => {
    const sm = item.SalvageModifier?.[0];
    if (sm && typeof sm.RadiusMultiplier === 'number') sm.RadiusMultiplier *= m;
  },
  'Speed': (item, m) => {
    const sm = item.SalvageModifier?.[0];
    if (sm && typeof sm.SpeedMultiplier === 'number') sm.SpeedMultiplier *= m;
  },
  'Power Pips': (item, m) => {
    // Additive integer adjustment to a power plant's `Segment` count (the
    // pip pool the ship draws from). VOLTAGE REGULATOR and STATOR CORES
    // contribute discrete step values (e.g. -2 / -1 / 0 / +1 / +2) that
    // sum across slots. calculateStats reads `gen.Segment` from the
    // crafted stdItem, so updating it here flows into powerOutput +
    // pip allocation automatically.
    const gen = item.ResourceNetwork?.[0]?.Generation?.[0];
    if (gen && typeof gen.Segment === 'number' && gen.Resource === 'Power') {
      gen.Segment += m;
    }
  },
  'Impact Force': (item, m) => {
    // ImpactDamage is a dict of damage-type keys (Energy, Physical, …).
    // Multiply every numeric sub-field so the modifier scales total damage.
    const id = item.Weapon?.Ammunition?.ImpactDamage;
    if (id && typeof id === 'object') {
      for (const k of Object.keys(id)) {
        if (typeof id[k] === 'number') id[k] *= m;
      }
    }
    // CIG pre-computes per-shot alpha (`DamagePerShot`) and burst DPS
    // (`DamagePerSecond`) into `Weapon.Firing[i]` as parallel damage-type
    // dicts. Verified: DamagePerSecond = ImpactDamage × RoundsPerMinute / 60
    // (e.g. 97.2 × 150 / 60 = 243.0). Both scale linearly with the
    // modifier - touch them here so the DPS display and alpha-based
    // deflection compare update with the slider.
    const firing = item.Weapon?.Firing;
    if (Array.isArray(firing)) {
      for (const f of firing) {
        for (const field of ['DamagePerShot', 'DamagePerSecond']) {
          const d = f?.[field];
          if (d && typeof d === 'object') {
            for (const k of Object.keys(d)) {
              if (typeof d[k] === 'number') d[k] *= m;
            }
          }
        }
      }
    }
  },
};

/**
 * Composition kind per PropertyName. Default = 'multiplicative' (mod values
 * are factors applied via `field *= m`; multi-slot composition multiplies
 * them; identity = 1). `'additive'` properties have integer step modifiers
 * (`field += m`; multi-slot composition sums them; identity = 0). Power
 * Pips on power plants is the only known additive property today -
 * VOLTAGE REGULATOR and STATOR CORES each contribute ±N segments.
 */
const PROPERTY_KIND = {
  'Power Pips': 'additive',
};

/** Get the composition kind for a property - default multiplicative. */
export function getPropertyKind(propertyName) {
  return PROPERTY_KIND[propertyName] || 'multiplicative';
}

/** Identity value for a property's kind (0 for additive, 1 for multiplicative). */
export function identityFor(propertyName) {
  return getPropertyKind(propertyName) === 'additive' ? 0 : 1;
}

/**
 * Properties where a *decrease* is the desirable outcome. Purely a display
 * trait (drives the good/bad colour of a delta) - it has no effect on the
 * math. Quantum Fuel Burn is the lone case today: less fuel per jump means
 * longer range, so a reduction should read as a positive change.
 */
const LOWER_IS_BETTER = new Set([
  'Quantum Fuel Burn',
]);

/** True when a smaller value for this property is the good outcome. */
export function isLowerBetter(propertyName) {
  return LOWER_IS_BETTER.has(propertyName);
}

/** Set of supported PropertyName values - exported for UI feature-detection. */
export const SUPPORTED_PROPERTIES = new Set(Object.keys(PROPERTY_SETTERS));

// Warn-once registry so unknown PropertyNames don't spam the console.
const _warnedUnknown = new Set();

/**
 * Clamp + integer-round a raw quality value.
 */
export function normalizeQuality(q) {
  if (typeof q !== 'number' || !Number.isFinite(q)) return DEFAULT_QUALITY;
  return Math.round(Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, q)));
}

/**
 * Compute the modifier contributed by a single blueprint slot at the
 * given quality. Returns Map<PropertyName, modifier>. A slot may have
 * multiple piecewise ranges and/or multiple distinct PropertyName
 * entries (e.g. one slot affecting two stats).
 *
 * Algorithm: for each Modifier entry, check if quality falls inside its
 * QualityRange. If so, linearly interpolate within its ModifierRange
 * and record. If the same PropertyName appears more than once at this
 * quality (overlapping ranges, shouldn't happen but defended) the
 * values multiply.
 */
export function computeSlotModifier(slot, quality) {
  const out = new Map();
  if (!slot || !Array.isArray(slot.Modifiers)) return out;
  const q = normalizeQuality(quality);
  for (const mod of slot.Modifiers) {
    if (!mod || !Array.isArray(mod.QualityRange) || !Array.isArray(mod.ModifierRange)) continue;
    const [qLo, qHi] = mod.QualityRange;
    const [mLo, mHi] = mod.ModifierRange;
    if (typeof qLo !== 'number' || typeof qHi !== 'number') continue;
    if (typeof mLo !== 'number' || typeof mHi !== 'number') continue;
    if (q < qLo || q > qHi) continue;
    const span = qHi - qLo;
    const frac = span > 0 ? (q - qLo) / span : 0;
    const m = mLo + frac * (mHi - mLo);
    const prop = mod.PropertyName;
    if (!prop) continue;
    // Combine duplicate entries for the same property kind-correctly.
    // Step-bucket properties (`Power Pips`) shouldn't double-add within a
    // single slot - they shouldn't have duplicates in the first place,
    // but if they do the additive sum is the safe combine.
    const prev = out.get(prop);
    if (prev == null) {
      out.set(prop, m);
    } else if (getPropertyKind(prop) === 'additive') {
      out.set(prop, prev + m);
    } else {
      out.set(prop, prev * m);
    }
  }
  return out;
}

/**
 * Compute the composed modifier map across every slot in a blueprint.
 * Modifiers targeting the same PropertyName multiply together.
 *
 * `craftingState` is a plain object: { slotName: quality }. Missing
 * slot entries default to q=500 (identity). Identity contributions
 * (m === 1) are dropped so the resulting map is empty when no slot
 * deviates from default - `applyModifiers` then short-circuits to
 * return the input reference unchanged.
 */
export function computeBlueprintModifiers(blueprint, craftingState) {
  const out = new Map();
  if (!blueprint || !Array.isArray(blueprint.Tiers) || blueprint.Tiers.length === 0) {
    return out;
  }
  const tier = blueprint.Tiers[0];
  if (!tier || !Array.isArray(tier.Slots)) return out;
  for (const slot of tier.Slots) {
    const slotName = slot?.Name;
    const rawQ = craftingState && slotName != null ? craftingState[slotName] : undefined;
    const q = rawQ == null ? DEFAULT_QUALITY : rawQ;
    const slotMods = computeSlotModifier(slot, q);
    for (const [prop, m] of slotMods) {
      // Drop identity contributions per kind so applyModifiers can
      // short-circuit when nothing actually changes (mult identity = 1,
      // additive identity = 0).
      if (m === identityFor(prop)) continue;
      const prev = out.get(prop);
      if (prev == null) {
        out.set(prop, m);
      } else if (getPropertyKind(prop) === 'additive') {
        out.set(prop, prev + m);
      } else {
        out.set(prop, prev * m);
      }
    }
  }
  return out;
}

/**
 * Apply a modifier map to a stdItem, returning a deep-cloned + mutated
 * copy. Empty modifier map returns the input reference unchanged -
 * the caller's fast path when no crafting is active.
 *
 * The clone is via JSON round-trip. `stdItem` is plain data (numbers,
 * strings, nested objects/arrays) so this is safe. For the largest
 * items (~50 KB) the round-trip is well under 1 ms.
 */
export function applyModifiers(stdItem, modifiers) {
  if (!stdItem || !modifiers || modifiers.size === 0) return stdItem;
  const clone = JSON.parse(JSON.stringify(stdItem));
  for (const [prop, m] of modifiers) {
    const setter = PROPERTY_SETTERS[prop];
    if (!setter) {
      if (!_warnedUnknown.has(prop)) {
        // eslint-disable-next-line no-console
        console.warn(`craftingModifiers: unknown PropertyName "${prop}" - skipped`);
        _warnedUnknown.add(prop);
      }
      continue;
    }
    setter(clone, m);
  }
  return clone;
}

/**
 * Convenience: blueprint + crafting state → modified stdItem in one call.
 * Used by `getCraftedItemStats` in loadoutManager once Phase 2 wires it in.
 */
export function craftStdItem(stdItem, blueprint, craftingState) {
  if (!stdItem) return stdItem;
  if (!blueprint || !craftingState) return stdItem;
  const mods = computeBlueprintModifiers(blueprint, craftingState);
  return applyModifiers(stdItem, mods);
}

/**
 * Test-only hook to reset the warn-once cache between unit tests.
 */
export function _resetWarnCache() {
  _warnedUnknown.clear();
}
