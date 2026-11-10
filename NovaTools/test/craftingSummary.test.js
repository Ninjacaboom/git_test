/**
 * Tests for craftingSummary.js.
 *
 * Covers the three pieces of the crafting-summary feature:
 *  1. aggregateBlueprintCosts - sum Resource costs across blueprint slots
 *  2. buildSummary - filter/group equipped components by className
 *  3. aggregateTotals - sum costs across the user-checked subset
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initLoadoutData, initCraftingData } from '../js/loadoutManager.js';
import {
  aggregateBlueprintCosts,
  buildSummary,
  aggregateTotals,
} from '../js/craftingSummary.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal item registry entry - only fields craftingSummary touches. */
function makeItem(className, displayName = className) {
  return {
    className,
    type: 'WeaponGun',
    subType: 'Gun',
    size: 2,
    tags: '',
    requiredTags: '',
    sold: 0,
    stdItem: {
      ClassName: className,
      Name: displayName,
    },
  };
}

/** Minimal blueprint with one or more slots, each carrying Resource costs. */
function makeBlueprint(className, slots) {
  return {
    TargetClassName: className,
    TargetName: className,
    Tiers: [{ Slots: slots }],
  };
}

function res(guid, qty) {
  return { Type: 'Resource', GUID: guid, Quantity: qty };
}

// ─── 1. aggregateBlueprintCosts ──────────────────────────────────────────────

describe('aggregateBlueprintCosts', () => {
  it('returns empty map when blueprint is null/undefined', () => {
    expect(aggregateBlueprintCosts(null).size).toBe(0);
    expect(aggregateBlueprintCosts(undefined).size).toBe(0);
  });

  it('returns empty map when blueprint has no tiers', () => {
    expect(aggregateBlueprintCosts({ TargetClassName: 'x' }).size).toBe(0);
  });

  it('sums Resource costs across a single slot', () => {
    const bp = makeBlueprint('x', [
      { Costs: [res('iron', 1.0), res('iron', 0.5), res('gold', 2.0)] },
    ]);
    const costs = aggregateBlueprintCosts(bp);
    expect(costs.get('iron')).toBeCloseTo(1.5);
    expect(costs.get('gold')).toBeCloseTo(2.0);
  });

  it('sums Resource costs across multiple slots', () => {
    const bp = makeBlueprint('x', [
      { Costs: [res('iron', 1.0)] },
      { Costs: [res('iron', 2.0), res('gold', 0.5)] },
      { Costs: [res('iron', 0.5)] },
    ]);
    const costs = aggregateBlueprintCosts(bp);
    expect(costs.get('iron')).toBeCloseTo(3.5);
    expect(costs.get('gold')).toBeCloseTo(0.5);
  });

  it('skips non-Resource cost entries', () => {
    const bp = makeBlueprint('x', [
      { Costs: [{ Type: 'Item', GUID: 'sub-part', Quantity: 5 }, res('iron', 1.0)] },
    ]);
    const costs = aggregateBlueprintCosts(bp);
    expect(costs.has('sub-part')).toBe(false);
    expect(costs.get('iron')).toBeCloseTo(1.0);
  });

  it('skips entries with missing GUID', () => {
    const bp = makeBlueprint('x', [
      { Costs: [{ Type: 'Resource', Quantity: 10 }, res('iron', 1.0)] },
    ]);
    const costs = aggregateBlueprintCosts(bp);
    expect(costs.size).toBe(1);
    expect(costs.get('iron')).toBeCloseTo(1.0);
  });
});

// ─── 2. buildSummary ─────────────────────────────────────────────────────────

describe('buildSummary', () => {
  beforeEach(() => {
    initLoadoutData([
      makeItem('WPN_CRAFT_A', 'Crafted A'),
      makeItem('WPN_CRAFT_B', 'Crafted B'),
      makeItem('WPN_NONCRAFT', 'Non-Craftable'),
      makeItem('WPN_DEFAULT', 'Stock Default'),
    ]);
    initCraftingData([
      makeBlueprint('WPN_CRAFT_A', [{ Costs: [res('iron', 1.0), res('gold', 0.5)] }]),
      makeBlueprint('WPN_CRAFT_B', [{ Costs: [res('iron', 2.0)] }]),
      makeBlueprint('WPN_DEFAULT', [{ Costs: [res('iron', 0.25)] }]),
      // WPN_NONCRAFT intentionally absent → no blueprint → skipped
    ]);
  });

  it('returns empty for empty loadout', () => {
    expect(buildSummary({}, { weapons: [] }, {})).toEqual([]);
  });

  it('skips non-craftable components entirely (no blueprint in data)', () => {
    const loadout = { hp1: 'WPN_NONCRAFT' };
    const slots = { weapons: [{ portName: 'hp1', baseLoadout: { ClassName: 'WPN_NONCRAFT' } }] };
    expect(buildSummary(loadout, slots, {})).toEqual([]);
  });

  it('skips structural items (turret bases, gimbal mounts, missile racks)', () => {
    // Register a structural turret item - no blueprint, structural Type.
    initLoadoutData([
      makeItem('WPN_CRAFT_A', 'Crafted A'),
      {
        className: 'TURRET_BASE',
        type: 'Turret', subType: 'BallTurret', size: 4,
        tags: '', requiredTags: '', sold: 0,
        stdItem: { ClassName: 'TURRET_BASE', Name: 'Big Turret', Type: 'Turret.BallTurret' },
      },
    ]);
    initCraftingData([
      makeBlueprint('WPN_CRAFT_A', [{ Costs: [res('iron', 1.0)] }]),
    ]);
    const loadout = { turret_port: 'TURRET_BASE', gun_port: 'WPN_CRAFT_A' };
    const slots = { weapons: [{ portName: 'turret_port' }, { portName: 'gun_port' }] };
    const summary = buildSummary(loadout, slots, {});
    expect(summary.map(s => s.className)).toEqual(['WPN_CRAFT_A']);
  });

  it('lists default-equipped craftable component with defaultIncluded=false', () => {
    const loadout = { hp1: 'WPN_DEFAULT' };
    const slots = { weapons: [{ portName: 'hp1', baseLoadout: { ClassName: 'WPN_DEFAULT' } }] };
    const summary = buildSummary(loadout, slots, {});
    expect(summary).toHaveLength(1);
    expect(summary[0].defaultIncluded).toBe(false);
    expect(summary[0].count).toBe(1);
  });

  it('marks custom-swapped component as defaultIncluded=true', () => {
    const loadout = { hp1: 'WPN_CRAFT_A' };
    const slots = { weapons: [{ portName: 'hp1', baseLoadout: { ClassName: 'WPN_DEFAULT' } }] };
    const summary = buildSummary(loadout, slots, {});
    expect(summary[0].defaultIncluded).toBe(true);
  });

  it('marks default-equipped + customized quality as defaultIncluded=true', () => {
    const loadout = { hp1: 'WPN_DEFAULT' };
    const slots = { weapons: [{ portName: 'hp1', baseLoadout: { ClassName: 'WPN_DEFAULT' } }] };
    const crafting = { hp1: { 'FRAME': 800 } };
    const summary = buildSummary(loadout, slots, crafting);
    expect(summary[0].defaultIncluded).toBe(true);
  });

  it('ignores empty crafting entry (no slots configured)', () => {
    const loadout = { hp1: 'WPN_DEFAULT' };
    const slots = { weapons: [{ portName: 'hp1', baseLoadout: { ClassName: 'WPN_DEFAULT' } }] };
    const crafting = { hp1: {} };
    const summary = buildSummary(loadout, slots, crafting);
    expect(summary[0].defaultIncluded).toBe(false);
  });

  it('groups multiple instances of same className across ports', () => {
    const loadout = { hp1: 'WPN_CRAFT_A', hp2: 'WPN_CRAFT_A', hp3: 'WPN_CRAFT_A' };
    const slots = {
      weapons: [
        { portName: 'hp1', baseLoadout: { ClassName: 'WPN_DEFAULT' } },
        { portName: 'hp2', baseLoadout: { ClassName: 'WPN_DEFAULT' } },
        { portName: 'hp3', baseLoadout: { ClassName: 'WPN_DEFAULT' } },
      ],
    };
    const summary = buildSummary(loadout, slots, {});
    expect(summary).toHaveLength(1);
    expect(summary[0].count).toBe(3);
    // Per-component cost = iron 1.0 → 3.0 for three instances
    expect(summary[0].costs.get('iron')).toBeCloseTo(3.0);
    expect(summary[0].costs.get('gold')).toBeCloseTo(1.5);
  });

  it('mixed group is defaultIncluded=true if ANY port is customized', () => {
    // Two ports holding WPN_DEFAULT: one stock, one with custom quality.
    const loadout = { hp1: 'WPN_DEFAULT', hp2: 'WPN_DEFAULT' };
    const slots = {
      weapons: [
        { portName: 'hp1', baseLoadout: { ClassName: 'WPN_DEFAULT' } },
        { portName: 'hp2', baseLoadout: { ClassName: 'WPN_DEFAULT' } },
      ],
    };
    const crafting = { hp2: { 'FRAME': 700 } };
    const summary = buildSummary(loadout, slots, crafting);
    expect(summary[0].count).toBe(2);
    expect(summary[0].defaultIncluded).toBe(true);
  });

  it('walks sub-ports recursively', () => {
    const loadout = { rack: 'WPN_DEFAULT', sub1: 'WPN_CRAFT_A', sub2: 'WPN_CRAFT_B' };
    const slots = {
      weapons: [{
        portName: 'rack',
        baseLoadout: { ClassName: 'WPN_DEFAULT' },
        ports: [
          { portName: 'sub1', baseLoadout: { ClassName: 'WPN_DEFAULT' } },
          { portName: 'sub2', baseLoadout: { ClassName: 'WPN_CRAFT_B' } },
        ],
      }],
    };
    const summary = buildSummary(loadout, slots, {});
    const byCn = Object.fromEntries(summary.map(s => [s.className, s]));
    // rack: stock, custom quality absent → defaultIncluded=false
    expect(byCn.WPN_DEFAULT.defaultIncluded).toBe(false);
    // sub1 swapped from default → defaultIncluded=true
    expect(byCn.WPN_CRAFT_A.defaultIncluded).toBe(true);
    // sub2 is default for its port → defaultIncluded=false
    expect(byCn.WPN_CRAFT_B.defaultIncluded).toBe(false);
  });

  it('skips ports with null/empty className', () => {
    const loadout = { hp1: null, hp2: 'WPN_CRAFT_A' };
    const slots = {
      weapons: [
        { portName: 'hp1', baseLoadout: { ClassName: 'WPN_DEFAULT' } },
        { portName: 'hp2', baseLoadout: { ClassName: 'WPN_DEFAULT' } },
      ],
    };
    const summary = buildSummary(loadout, slots, {});
    expect(summary).toHaveLength(1);
    expect(summary[0].className).toBe('WPN_CRAFT_A');
  });

  it('preserves category order in sort', () => {
    const loadout = { tw: 'WPN_CRAFT_A', sw: 'WPN_CRAFT_B' };
    const slots = {
      weapons: [{ portName: 'tw', baseLoadout: { ClassName: 'WPN_DEFAULT' } }],
      systems: [{ portName: 'sw', baseLoadout: { ClassName: 'WPN_DEFAULT' } }],
    };
    const summary = buildSummary(loadout, slots, {});
    // weapons appear before systems in input order
    expect(summary.map(s => s.className)).toEqual(['WPN_CRAFT_A', 'WPN_CRAFT_B']);
  });
});

// ─── 3. aggregateTotals ──────────────────────────────────────────────────────

describe('aggregateTotals', () => {
  const items = [
    { className: 'A', costs: new Map([['iron', 2], ['gold', 1]]) },
    { className: 'B', costs: new Map([['iron', 3], ['silver', 0.5]]) },
    { className: 'C', costs: new Map([['gold', 4]]) },
  ];

  it('returns empty when no classNames are included', () => {
    expect(aggregateTotals(items, new Set()).size).toBe(0);
  });

  it('sums only the included rows', () => {
    const totals = aggregateTotals(items, new Set(['A', 'C']));
    expect(totals.get('iron')).toBe(2);
    expect(totals.get('gold')).toBe(5);
    expect(totals.has('silver')).toBe(false);
  });

  it('handles all-included correctly', () => {
    const totals = aggregateTotals(items, new Set(['A', 'B', 'C']));
    expect(totals.get('iron')).toBe(5);
    expect(totals.get('gold')).toBe(5);
    expect(totals.get('silver')).toBe(0.5);
  });
});
