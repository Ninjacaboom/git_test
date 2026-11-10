/**
 * Tests for craftingModifiers.js - the pure math + immutability layer
 * underpinning component crafting.
 *
 * Coverage:
 *  1. normalizeQuality - clamp + round
 *  2. computeSlotModifier - piecewise lerp at boundaries and interior
 *  3. computeBlueprintModifiers - multi-slot multiplicative composition
 *     against the AllStop S1 shield blueprint (canonical reference)
 *  4. applyModifiers - identity fast path, immutability, unknown
 *     PropertyName handling (warn-once)
 *  5. PROPERTY_SETTERS - each in-scope stat path is correctly mutated
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_QUALITY,
  MIN_QUALITY,
  MAX_QUALITY,
  SUPPORTED_PROPERTIES,
  normalizeQuality,
  computeSlotModifier,
  computeBlueprintModifiers,
  applyModifiers,
  craftStdItem,
  getPropertyKind,
  identityFor,
  isLowerBetter,
  _resetWarnCache,
} from '../js/craftingModifiers.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * AllStop S1 shield blueprint - verified against PTU.zip (see plan §2).
 * Three slots, each with a two-piece quality curve.
 */
const ALLSTOP_BLUEPRINT = {
  TargetClassName: 'SHLD_GODI_S01_AllStop_SCItem',
  TargetType: 'Shield',
  TargetSize: 1,
  Tiers: [{
    Slots: [
      {
        Name: 'SHELL',
        Modifiers: [
          { PropertyName: 'Integrity', QualityRange: [0, 500],   ModifierRange: [0.8, 1.0] },
          { PropertyName: 'Integrity', QualityRange: [501, 1000], ModifierRange: [1.0, 1.2] },
        ],
      },
      {
        Name: 'FIELD ARRAY',
        Modifiers: [
          { PropertyName: 'Max. Shield Strength', QualityRange: [0, 500],   ModifierRange: [0.9, 1.0] },
          { PropertyName: 'Max. Shield Strength', QualityRange: [501, 1000], ModifierRange: [1.0, 1.1] },
        ],
      },
      {
        Name: 'FREQUENCY CONTROLLER',
        Modifiers: [
          { PropertyName: 'Max. Shield Strength', QualityRange: [0, 500],   ModifierRange: [0.9, 1.0] },
          { PropertyName: 'Max. Shield Strength', QualityRange: [501, 1000], ModifierRange: [1.0, 1.1] },
        ],
      },
    ],
  }],
};

/** Minimal AllStop stdItem matching the fields the blueprint touches. */
function makeShieldItem(shieldHP = 3168, integrity = 210) {
  return {
    ClassName: 'SHLD_GODI_S01_AllStop_SCItem',
    Type: 'Shield',
    Durability: { Health: integrity },
    Shield: { Health: shieldHP },
  };
}

// ─── normalizeQuality ──────────────────────────────────────────────────────

describe('normalizeQuality', () => {
  it('clamps below 0 to 0', () => {
    expect(normalizeQuality(-50)).toBe(MIN_QUALITY);
  });
  it('clamps above 1000 to 1000', () => {
    expect(normalizeQuality(1500)).toBe(MAX_QUALITY);
  });
  it('rounds fractional values', () => {
    expect(normalizeQuality(500.4)).toBe(500);
    expect(normalizeQuality(500.6)).toBe(501);
  });
  it('falls back to DEFAULT_QUALITY for NaN / null / non-numeric', () => {
    expect(normalizeQuality(NaN)).toBe(DEFAULT_QUALITY);
    expect(normalizeQuality(null)).toBe(DEFAULT_QUALITY);
    expect(normalizeQuality('500')).toBe(DEFAULT_QUALITY);
  });
});

// ─── computeSlotModifier ───────────────────────────────────────────────────

describe('computeSlotModifier', () => {
  const shellSlot = ALLSTOP_BLUEPRINT.Tiers[0].Slots[0];

  it('at q=500 returns identity (modifier=1.0)', () => {
    const m = computeSlotModifier(shellSlot, 500);
    expect(m.get('Integrity')).toBeCloseTo(1.0, 6);
  });
  it('at q=0 returns minimum penalty (0.8)', () => {
    const m = computeSlotModifier(shellSlot, 0);
    expect(m.get('Integrity')).toBeCloseTo(0.8, 6);
  });
  it('at q=1000 returns maximum bonus (1.2)', () => {
    const m = computeSlotModifier(shellSlot, 1000);
    expect(m.get('Integrity')).toBeCloseTo(1.2, 6);
  });
  it('at q=756 matches the screenshot value (+10.2%)', () => {
    // (756-501)/499 = 0.5110 → 1.0 + 0.5110*0.2 = 1.1022
    const m = computeSlotModifier(shellSlot, 756);
    expect(m.get('Integrity')).toBeCloseTo(1.1022, 3);
  });
  it('returns empty map for malformed slot', () => {
    expect(computeSlotModifier(null, 500).size).toBe(0);
    expect(computeSlotModifier({}, 500).size).toBe(0);
    expect(computeSlotModifier({ Modifiers: 'not an array' }, 500).size).toBe(0);
  });
  it('skips modifiers with missing range fields', () => {
    const bad = { Modifiers: [
      { PropertyName: 'Integrity' /* no ranges */ },
      { PropertyName: 'Integrity', QualityRange: [0, 500], ModifierRange: [0.8, 1.0] },
    ]};
    const m = computeSlotModifier(bad, 250);
    expect(m.size).toBe(1);
    expect(m.get('Integrity')).toBeCloseTo(0.9, 6);
  });
});

// ─── computeBlueprintModifiers ─────────────────────────────────────────────

describe('computeBlueprintModifiers', () => {
  it('empty crafting state defaults all slots to 500 → empty map (identity)', () => {
    const m = computeBlueprintModifiers(ALLSTOP_BLUEPRINT, {});
    expect(m.size).toBe(0);
  });
  it('missing crafting state defaults all slots to 500 → empty map', () => {
    const m = computeBlueprintModifiers(ALLSTOP_BLUEPRINT, undefined);
    expect(m.size).toBe(0);
  });
  it('Field Array @ q=1000 alone → +10% Max. Shield Strength', () => {
    const m = computeBlueprintModifiers(ALLSTOP_BLUEPRINT, { 'FIELD ARRAY': 1000 });
    expect(m.size).toBe(1);
    expect(m.get('Max. Shield Strength')).toBeCloseTo(1.10, 6);
  });
  it('Field Array + Frequency Controller @ q=1000 → +21% (1.10 × 1.10)', () => {
    // This is THE canonical test - reproduces the user-supplied screenshot:
    // 3168 hp base × 1.10 × 1.10 = 3833.28 hp.
    const m = computeBlueprintModifiers(ALLSTOP_BLUEPRINT, {
      'FIELD ARRAY': 1000,
      'FREQUENCY CONTROLLER': 1000,
    });
    expect(m.get('Max. Shield Strength')).toBeCloseTo(1.21, 6);
  });
  it('Shell @ q=756 alone → +10.2% Integrity (screenshot match)', () => {
    const m = computeBlueprintModifiers(ALLSTOP_BLUEPRINT, { 'SHELL': 756 });
    expect(m.get('Integrity')).toBeCloseTo(1.1022, 3);
  });
  it('all three slots minimum (q=0) → max penalty compose', () => {
    const m = computeBlueprintModifiers(ALLSTOP_BLUEPRINT, {
      'SHELL': 0,
      'FIELD ARRAY': 0,
      'FREQUENCY CONTROLLER': 0,
    });
    expect(m.get('Integrity')).toBeCloseTo(0.8, 6);            // single contributor
    expect(m.get('Max. Shield Strength')).toBeCloseTo(0.9 * 0.9, 6); // two contributors
  });
  it('returns empty map for malformed blueprint', () => {
    expect(computeBlueprintModifiers(null, {}).size).toBe(0);
    expect(computeBlueprintModifiers({}, {}).size).toBe(0);
    expect(computeBlueprintModifiers({ Tiers: [] }, {}).size).toBe(0);
  });
});

// ─── applyModifiers ────────────────────────────────────────────────────────

describe('applyModifiers', () => {
  beforeEach(() => { _resetWarnCache(); });

  it('empty modifier map returns input reference (identity fast path)', () => {
    const item = makeShieldItem();
    const out = applyModifiers(item, new Map());
    expect(out).toBe(item);                         // SAME reference, no clone
  });
  it('does not mutate the input stdItem', () => {
    const item = makeShieldItem();
    const before = JSON.stringify(item);
    const mods = new Map([['Max. Shield Strength', 1.21]]);
    applyModifiers(item, mods);
    expect(JSON.stringify(item)).toBe(before);      // input untouched
  });
  it('produces a deep-cloned output with mutated stats', () => {
    const item = makeShieldItem(3168, 210);
    const mods = new Map([
      ['Max. Shield Strength', 1.21],
      ['Integrity', 1.10],
    ]);
    const out = applyModifiers(item, mods);
    expect(out).not.toBe(item);
    expect(out.Shield).not.toBe(item.Shield);       // nested object is cloned too
    expect(out.Shield.Health).toBeCloseTo(3833.28, 2);
    expect(out.Durability.Health).toBeCloseTo(231.0, 2);
  });
  it('warns once per unknown PropertyName and skips silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item = makeShieldItem();
    const mods = new Map([['NonexistentProperty', 1.5]]);
    applyModifiers(item, mods);
    applyModifiers(item, mods);                     // second call: no extra warn
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

// ─── Property setters - each in-scope stat path ────────────────────────────

describe('PROPERTY_SETTERS coverage', () => {
  it('exposes the full in-scope property set', () => {
    expect(SUPPORTED_PROPERTIES.size).toBe(16);
    expect(SUPPORTED_PROPERTIES.has('Integrity')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Max. Shield Strength')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Coolant Rating')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Quantum Speed')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Quantum Fuel Burn')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Min. Assist Distance')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Max. Assist Distance')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Beam Force')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Full Strength Dist.')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Max. Distance')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Max. Volume')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Efficiency')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Radius')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Speed')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Impact Force')).toBe(true);
    expect(SUPPORTED_PROPERTIES.has('Power Pips')).toBe(true);
  });

  it('Coolant Rating scales the Coolant generator UnitPerSec', () => {
    const item = {
      ResourceNetwork: [{
        Conversion: [
          { Generation: { Resource: 'Coolant', UnitPerSec: 16.0 } },
          { Generation: { Resource: 'Power', UnitPerSec: 5.0 } },     // unrelated, untouched
        ],
      }],
    };
    const out = applyModifiers(item, new Map([['Coolant Rating', 1.15]]));
    expect(out.ResourceNetwork[0].Conversion[0].Generation.UnitPerSec).toBeCloseTo(18.4, 2);
    expect(out.ResourceNetwork[0].Conversion[1].Generation.UnitPerSec).toBe(5.0);
  });

  it('Quantum Speed + Quantum Fuel Burn target StandardJump fields', () => {
    const item = {
      QuantumDrive: { StandardJump: { Speed: 168000000, QuantumFuelRequirement: 0.0125 } },
    };
    const out = applyModifiers(item, new Map([
      ['Quantum Speed', 1.10],
      ['Quantum Fuel Burn', 0.95],
    ]));
    expect(out.QuantumDrive.StandardJump.Speed).toBeCloseTo(184800000, 0);
    expect(out.QuantumDrive.StandardJump.QuantumFuelRequirement).toBeCloseTo(0.011875, 6);
  });

  it('Quantum Fuel Burn scales the QuantumFuel MicroUnitPerSec consumption (current data shape)', () => {
    // Current Live/PTU QDs express fuel burn as the QuantumFuel consumption
    // rate, not StandardJump.QuantumFuelRequirement. Scaling it is what makes
    // "lower fuel burn -> longer range" flow through (range = capacity / rate).
    const item = {
      QuantumDrive: { StandardJump: { Speed: 168000000 } },
      ResourceNetwork: [
        { Consumption: [{ Resource: 'Power', UnitPerSec: 2.0 }] },
        { Consumption: [
          { Resource: 'Power', UnitPerSec: 2.0 },
          { Resource: 'QuantumFuel', MicroUnitPerSec: 12.0 },
        ] },
      ],
    };
    const out = applyModifiers(item, new Map([['Quantum Fuel Burn', 0.8]]));
    // -20% burn -> 12 * 0.8 = 9.6, i.e. +25% range for the same fuel tank.
    expect(out.ResourceNetwork[1].Consumption[1].MicroUnitPerSec).toBeCloseTo(9.6, 6);
    // Non-fuel consumers are untouched.
    expect(out.ResourceNetwork[0].Consumption[0].UnitPerSec).toBe(2.0);
  });

  it('isLowerBetter flags Quantum Fuel Burn but not higher-is-better props', () => {
    expect(isLowerBetter('Quantum Fuel Burn')).toBe(true);
    expect(isLowerBetter('Quantum Speed')).toBe(false);
    expect(isLowerBetter('Integrity')).toBe(false);
    expect(isLowerBetter('Range')).toBe(false);
  });

  it('Radar Min/Max Assist Distance target AimAssist sub-fields', () => {
    const item = { Radar: { AimAssist: { DistanceMin: 780, DistanceMax: 1028.5 } } };
    const out = applyModifiers(item, new Map([
      ['Min. Assist Distance', 0.95],
      ['Max. Assist Distance', 1.05],
    ]));
    expect(out.Radar.AimAssist.DistanceMin).toBeCloseTo(741.0, 2);
    expect(out.Radar.AimAssist.DistanceMax).toBeCloseTo(1079.925, 3);
  });

  it('TractorBeam fields target Tractor[0] sub-fields', () => {
    const item = {
      TractorBeam: {
        Tractor: [{
          MaxForce: 500000, FullStrengthDistance: 75, MaxDistance: 150, MaxVolume: 300000,
        }],
      },
    };
    const out = applyModifiers(item, new Map([
      ['Beam Force', 1.20],
      ['Full Strength Dist.', 1.10],
      ['Max. Distance', 1.10],
      ['Max. Volume', 1.20],
    ]));
    expect(out.TractorBeam.Tractor[0].MaxForce).toBeCloseTo(600000, 0);
    expect(out.TractorBeam.Tractor[0].FullStrengthDistance).toBeCloseTo(82.5, 2);
    expect(out.TractorBeam.Tractor[0].MaxDistance).toBeCloseTo(165, 2);
    expect(out.TractorBeam.Tractor[0].MaxVolume).toBeCloseTo(360000, 0);
  });

  it('SalvageModifier Efficiency/Radius/Speed target [0] sub-fields', () => {
    const item = {
      SalvageModifier: [{ SpeedMultiplier: 0.05, RadiusMultiplier: 6.0, ExtractionEfficiency: 0.6 }],
    };
    const out = applyModifiers(item, new Map([
      ['Efficiency', 1.10],
      ['Radius', 1.05],
      ['Speed', 1.05],
    ]));
    expect(out.SalvageModifier[0].ExtractionEfficiency).toBeCloseTo(0.66, 4);
    expect(out.SalvageModifier[0].RadiusMultiplier).toBeCloseTo(6.30, 4);
    expect(out.SalvageModifier[0].SpeedMultiplier).toBeCloseTo(0.0525, 6);
  });

  it('Impact Force scales ImpactDamage AND Firing[].DamagePerShot/DamagePerSecond', () => {
    // CIG pre-computes per-shot alpha and DPS into Firing[i]; both must
    // scale alongside ImpactDamage so DPS panels and alpha-driven
    // deflection compare react to the modifier.
    const item = {
      Weapon: {
        Ammunition: { ImpactDamage: { Energy: 97.2, Physical: 12.0 } },
        Firing: [{
          RoundsPerMinute: 150,
          DamagePerShot:   { Energy: 97.2, Physical: 12.0 },
          DamagePerSecond: { Energy: 243.0, Physical: 30.0 },
        }],
      },
    };
    const out = applyModifiers(item, new Map([['Impact Force', 1.10]]));
    expect(out.Weapon.Ammunition.ImpactDamage.Energy).toBeCloseTo(106.92, 2);
    expect(out.Weapon.Ammunition.ImpactDamage.Physical).toBeCloseTo(13.2, 2);
    expect(out.Weapon.Firing[0].DamagePerShot.Energy).toBeCloseTo(106.92, 2);
    expect(out.Weapon.Firing[0].DamagePerShot.Physical).toBeCloseTo(13.2, 2);
    expect(out.Weapon.Firing[0].DamagePerSecond.Energy).toBeCloseTo(267.3, 1);
    expect(out.Weapon.Firing[0].DamagePerSecond.Physical).toBeCloseTo(33.0, 2);
  });

  it('Impact Force is a no-op when Weapon block is missing', () => {
    const item = { Shield: { Health: 1000 } };
    const out = applyModifiers(item, new Map([['Impact Force', 1.20]]));
    expect(out.Shield.Health).toBe(1000); // untouched
  });

  it('setters are no-ops when target field is missing (graceful degradation)', () => {
    // SalvageModifier item with no Durability - Integrity setter must not throw.
    const item = { SalvageModifier: [{ ExtractionEfficiency: 0.6 }] };
    const out = applyModifiers(item, new Map([
      ['Integrity', 1.20],                          // no Durability - skip
      ['Efficiency', 1.10],                          // present - apply
    ]));
    expect(out.SalvageModifier[0].ExtractionEfficiency).toBeCloseTo(0.66, 4);
    expect(out).not.toBe(item);                     // still returned a clone (had non-empty mods)
  });
});

// ─── craftStdItem (end-to-end convenience) ─────────────────────────────────

describe('craftStdItem', () => {
  it('blueprint + zero-deviation crafting state → input reference (no clone)', () => {
    const item = makeShieldItem(3168);
    const out = craftStdItem(item, ALLSTOP_BLUEPRINT, { 'SHELL': 500 });
    expect(out).toBe(item);                         // identity fast path
  });
  it('blueprint + full-bonus crafting → shield HP becomes 3 833 (matches screenshot)', () => {
    const item = makeShieldItem(3168);
    const out = craftStdItem(item, ALLSTOP_BLUEPRINT, {
      'FIELD ARRAY': 1000,
      'FREQUENCY CONTROLLER': 1000,
    });
    expect(out.Shield.Health).toBeCloseTo(3833.28, 2);
    expect(item.Shield.Health).toBe(3168);          // input untouched
  });
  it('null blueprint returns input reference', () => {
    const item = makeShieldItem();
    expect(craftStdItem(item, null, {})).toBe(item);
  });
  it('null stdItem returns null', () => {
    expect(craftStdItem(null, ALLSTOP_BLUEPRINT, {})).toBeNull();
  });
});

// ─── Composition kind (additive vs multiplicative) ─────────────────────────

describe('PROPERTY_KIND composition', () => {
  it('getPropertyKind defaults to multiplicative', () => {
    expect(getPropertyKind('Integrity')).toBe('multiplicative');
    expect(getPropertyKind('Max. Shield Strength')).toBe('multiplicative');
    expect(getPropertyKind('Unknown Property')).toBe('multiplicative');
  });
  it('Power Pips is additive', () => {
    expect(getPropertyKind('Power Pips')).toBe('additive');
  });
  it('identityFor: 0 for additive, 1 for multiplicative', () => {
    expect(identityFor('Power Pips')).toBe(0);
    expect(identityFor('Integrity')).toBe(1);
    expect(identityFor('Unknown Property')).toBe(1);
  });

  // The canonical power-plant blueprint: VOLTAGE REGULATOR + STATOR CORES
  // both target `Power Pips` and their step values should SUM across
  // slots (not multiply). At max quality: +2 + +1 = +3.
  const POWER_PLANT_BLUEPRINT = {
    Tiers: [{
      Slots: [
        {
          Name: 'SHELL',
          Modifiers: [
            { PropertyName: 'Integrity', QualityRange: [0, 500],   ModifierRange: [0.8, 1.0] },
            { PropertyName: 'Integrity', QualityRange: [501, 1000], ModifierRange: [1.0, 1.2] },
          ],
        },
        {
          Name: 'VOLTAGE REGULATOR',
          Modifiers: [
            { PropertyName: 'Power Pips', QualityRange: [0, 249],     ModifierRange: [-2, -2] },
            { PropertyName: 'Power Pips', QualityRange: [250, 499],   ModifierRange: [-1, -1] },
            { PropertyName: 'Power Pips', QualityRange: [500, 699],   ModifierRange: [0,  0]  },
            { PropertyName: 'Power Pips', QualityRange: [700, 899],   ModifierRange: [1,  1]  },
            { PropertyName: 'Power Pips', QualityRange: [900, 1000],  ModifierRange: [2,  2]  },
          ],
        },
        {
          Name: 'STATOR CORES',
          Modifiers: [
            { PropertyName: 'Power Pips', QualityRange: [0, 399],     ModifierRange: [-1, -1] },
            { PropertyName: 'Power Pips', QualityRange: [400, 899],   ModifierRange: [0,  0]  },
            { PropertyName: 'Power Pips', QualityRange: [900, 1000],  ModifierRange: [1,  1]  },
          ],
        },
      ],
    }],
  };

  it('step bucket returns constant within the range (flat lerp)', () => {
    // Voltage Regulator at q=100, q=200, q=249 should all give -2.
    const slot = POWER_PLANT_BLUEPRINT.Tiers[0].Slots[1];
    expect(computeSlotModifier(slot, 100).get('Power Pips')).toBe(-2);
    expect(computeSlotModifier(slot, 200).get('Power Pips')).toBe(-2);
    expect(computeSlotModifier(slot, 249).get('Power Pips')).toBe(-2);
    expect(computeSlotModifier(slot, 250).get('Power Pips')).toBe(-1);
    expect(computeSlotModifier(slot, 500).get('Power Pips')).toBe(0);
    expect(computeSlotModifier(slot, 1000).get('Power Pips')).toBe(2);
  });

  it('Power Pips composes additively across slots (+2 + +1 = +3)', () => {
    const m = computeBlueprintModifiers(POWER_PLANT_BLUEPRINT, {
      'VOLTAGE REGULATOR': 1000,
      'STATOR CORES':      1000,
    });
    expect(m.get('Power Pips')).toBe(3);
  });

  it('Power Pips identity at default quality (slots @ q=500) → dropped from map', () => {
    const m = computeBlueprintModifiers(POWER_PLANT_BLUEPRINT, {});
    // Both slot defaults land in the 0-modifier bucket → drop identity 0
    expect(m.has('Power Pips')).toBe(false);
  });

  it('Multiplicative and additive properties coexist on the same blueprint', () => {
    const m = computeBlueprintModifiers(POWER_PLANT_BLUEPRINT, {
      'SHELL':             1000,  // Integrity ×1.2
      'VOLTAGE REGULATOR': 1000,  // Power Pips +2
      'STATOR CORES':      1000,  // Power Pips +1
    });
    expect(m.get('Integrity')).toBeCloseTo(1.2, 6);
    expect(m.get('Power Pips')).toBe(3);
  });

  it('applyModifiers respects kind: Power Pips adds, Integrity multiplies', () => {
    const item = {
      Durability: { Health: 1000 },
      ResourceNetwork: [{ Generation: [{ Resource: 'Power', Segment: 14 }] }],
    };
    const out = applyModifiers(item, new Map([
      ['Integrity',  1.2],
      ['Power Pips', 3],
    ]));
    expect(out.Durability.Health).toBeCloseTo(1200, 4);
    expect(out.ResourceNetwork[0].Generation[0].Segment).toBe(17);
  });
});
