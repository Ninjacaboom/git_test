/**
 * Tests for shipParser.js pure function: parseShips.
 *
 * Focus areas:
 *  1. Filter conditions: missing Name, UNRELEASED_SHIPS, IsSpaceship===false
 *  2. Output shape: Deflection/Resist field mapping and the resistance formula
 *     Resist = Math.round((1 - mult) * 100)
 */

import { describe, it, expect } from 'vitest';
import { parseShips } from '../js/shipParser.js';
import { UNRELEASED_SHIPS } from '../js/config.js';

// ─── Minimal fixture helpers ─────────────────────────────────────────────────

/** Build a minimal valid vehicle record. */
function makeVehicle(overrides = {}) {
  return {
    Name: 'Test Ship',
    Size: 2,
    Role: 'Heavy Fighter',
    IsSpaceship: true,
    Armor: {
      DamageDeflection: { Physical: 100, Energy: 80 },
      Durability: {
        DamageMultipliers: { Physical: 0.9, Energy: 1.1 },
      },
    },
    ...overrides,
  };
}

// ─── 1. Filter conditions ────────────────────────────────────────────────────

describe('parseShips - filters', () => {
  it('excludes vehicles with no Name', () => {
    const result = parseShips([makeVehicle({ Name: '' }), makeVehicle({ Name: undefined })]);
    expect(result).toHaveLength(0);
  });

  it('excludes ships in the UNRELEASED_SHIPS set', () => {
    // Pick any known unreleased ship
    const unreleasedName = [...UNRELEASED_SHIPS][0];
    const result = parseShips([makeVehicle({ Name: unreleasedName })]);
    expect(result).toHaveLength(0);
  });

  it('includes ships not in the UNRELEASED_SHIPS set', () => {
    const result = parseShips([makeVehicle({ Name: 'Definitely Released Ship' })]);
    expect(result).toHaveLength(1);
  });

  it('excludes vehicles where IsSpaceship === false', () => {
    const result = parseShips([makeVehicle({ IsSpaceship: false })]);
    expect(result).toHaveLength(0);
  });

  it('includes vehicles where IsSpaceship is true', () => {
    const result = parseShips([makeVehicle({ IsSpaceship: true })]);
    expect(result).toHaveLength(1);
  });

  it('includes vehicles where IsSpaceship is undefined (not explicitly false)', () => {
    // The filter is: if (v.IsSpaceship === false) return false; — strict equality only
    const result = parseShips([makeVehicle({ IsSpaceship: undefined })]);
    expect(result).toHaveLength(1);
  });

  it('filters multiple vehicles, keeping only valid ones', () => {
    const vehicles = [
      makeVehicle({ Name: 'Ship A' }),                    // keep
      makeVehicle({ Name: '' }),                          // no name → exclude
      makeVehicle({ IsSpaceship: false, Name: 'Rover' }), // ground → exclude
      makeVehicle({ Name: 'Ship B' }),                    // keep
    ];
    const result = parseShips(vehicles);
    expect(result).toHaveLength(2);
    expect(result.map(s => s.Name)).toEqual(['Ship A', 'Ship B']);
  });
});

// ─── 2. Output shape and resistance formula ──────────────────────────────────

describe('parseShips - output mapping', () => {
  it('maps Name, Size, Role correctly', () => {
    const result = parseShips([makeVehicle({ Name: 'Aurora MR', Size: 1, Role: 'Light Fighter' })]);
    expect(result[0].Name).toBe('Aurora MR');
    expect(result[0].Size).toBe(1);
    expect(result[0].Role).toBe('Light Fighter');
  });

  it('maps Deflection physical and energy from Armor.DamageDeflection', () => {
    const result = parseShips([makeVehicle()]);
    expect(result[0]['Deflection physical']).toBe(100);
    expect(result[0]['Deflection energy']).toBe(80);
  });

  it('returns null for missing Deflection fields', () => {
    const v = makeVehicle();
    delete v.Armor.DamageDeflection;
    const result = parseShips([v]);
    expect(result[0]['Deflection physical']).toBeNull();
    expect(result[0]['Deflection energy']).toBeNull();
  });

  it('returns null when Armor is missing', () => {
    const v = makeVehicle();
    delete v.Armor;
    const result = parseShips([v]);
    expect(result[0]['Deflection physical']).toBeNull();
    expect(result[0]['Deflection energy']).toBeNull();
    expect(result[0]['Resist physical']).toBeNull();
    expect(result[0]['Resist energy']).toBeNull();
  });

  it('computes Resist physical as Math.round((1 - mult) * 100)', () => {
    // mult = 0.9 → (1 - 0.9) * 100 = 10 → Resist physical = 10
    const result = parseShips([makeVehicle()]);
    expect(result[0]['Resist physical']).toBe(10);
  });

  it('computes Resist energy as Math.round((1 - mult) * 100)', () => {
    // mult = 1.1 → (1 - 1.1) * 100 = -10 → Resist energy = -10
    const result = parseShips([makeVehicle()]);
    expect(result[0]['Resist energy']).toBe(-10);
  });

  it('resistance formula: mult=1.0 gives 0% resistance', () => {
    const v = makeVehicle();
    v.Armor.Durability.DamageMultipliers.Physical = 1.0;
    const result = parseShips([v]);
    expect(result[0]['Resist physical']).toBe(0);
  });

  it('resistance formula: mult=0.0 gives 100% resistance', () => {
    const v = makeVehicle();
    v.Armor.Durability.DamageMultipliers.Physical = 0.0;
    const result = parseShips([v]);
    expect(result[0]['Resist physical']).toBe(100);
  });

  it('resistance formula rounds correctly', () => {
    // mult = 0.333 → (1 - 0.333) * 100 = 66.7 → Math.round = 67
    const v = makeVehicle();
    v.Armor.Durability.DamageMultipliers.Physical = 0.333;
    const result = parseShips([v]);
    expect(result[0]['Resist physical']).toBe(67);
  });

  it('returns null Resist fields when DamageMultipliers are missing', () => {
    const v = makeVehicle();
    delete v.Armor.Durability.DamageMultipliers;
    const result = parseShips([v]);
    expect(result[0]['Resist physical']).toBeNull();
    expect(result[0]['Resist energy']).toBeNull();
  });

  it('returns null for individual missing multiplier fields', () => {
    const v = makeVehicle();
    // Physical is present but Energy is absent
    delete v.Armor.Durability.DamageMultipliers.Energy;
    const result = parseShips([v]);
    expect(result[0]['Resist physical']).toBe(10); // still present
    expect(result[0]['Resist energy']).toBeNull();
  });

  it('handles vehicle with partial armor (no DamageDeflection but has multipliers)', () => {
    const v = makeVehicle();
    delete v.Armor.DamageDeflection;
    const result = parseShips([v]);
    // Deflection null, resistance still computed
    expect(result[0]['Deflection physical']).toBeNull();
    expect(result[0]['Resist physical']).toBe(10);
  });
});
