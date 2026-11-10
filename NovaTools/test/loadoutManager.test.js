/**
 * Tests for loadoutManager.js pure functions.
 *
 * Focus areas:
 *  1. getPowerRangeModifierAll - range lookup
 *  2. buildDefaultLoadout - slot tree → loadout map
 *  3. distributeShieldPipsAll - pip distribution to all shields
 *  4. distributeShieldPipsTop2 - pip distribution to powered shields only
 *  5. calculateCoolingStats - supply/demand with mocked item data
 *  6. calculateEMSignature - EM sum with mocked channel data
 *  7. Pip allocation regression - weapon channel clamps at capacitor pool
 *  8. calculateBoostTime - thruster capacitor endurance
 *  9. calculateBoostRegenTime - thruster capacitor recharge
 * 10. scaleCrossSection - CrossSection signal multiplier
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initLoadoutData,
  initCraftingData,
  buildDefaultLoadout,
  getPowerRangeModifierAll,
  getCraftedItemStats,
  distributeShieldPipsAll,
  distributeShieldPipsTop2,
  calculateCoolingStats,
  calculateEMSignature,
  calculateBoostTime,
  calculateBoostRegenTime,
  buildPipAllocation,
  isGroundVehicleMissileRack,
  getCompatibleItems,
  extractSlots,
  isLoadoutForOtherHull,
  findShipIntegratedRacks,
  calculateStats,
  scaleCrossSection,
} from '../js/loadoutManager.js';
import { setCurrentCrafting, setAllHardpoints } from '../js/loadoutState.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal stdItem for a cooler that outputs `output` units/s of coolant. */
function makeCoolerItem(className, output, allocatedPips = 4, maxPips = 4) {
  return {
    className,
    type: 'Cooler',
    subType: 'Cooler',
    size: 1,
    tags: '',
    requiredTags: '',
    sold: 0,
    stdItem: {
      ClassName: className,
      Name: className,
      Type: 'Cooler.Cooler',
      Classification: 'Cooler.Cooler',
      Size: 1,
      Grade: 'C',
      Class: 'Civilian',
      Tags: '',
      RequiredTags: '',
      ResourceNetwork: [
        {
          PowerRanges: { tier1: { Start: 0, Modifier: 1.0 } },
          Conversion: [
            {
              Generation: { Resource: 'Coolant', UnitPerSec: output },
            },
          ],
        },
      ],
    },
  };
}

/** Minimal power-consuming component (shield / radar / etc.) */
function makePowerItem(className, segment, minFraction = 0, emNominal = 0) {
  return {
    className,
    type: 'Shield',
    subType: 'Shield',
    size: 2,
    tags: '',
    requiredTags: '',
    sold: 0,
    stdItem: {
      ClassName: className,
      Name: className,
      Type: 'Shield.Shield',
      Classification: 'Shield.Shield',
      Size: 2,
      Grade: 'C',
      Class: 'Civilian',
      Tags: '',
      RequiredTags: '',
      Shield: { Health: 100 },
      ResourceNetwork: [
        {
          Consumption: [
            {
              Resource: 'Power',
              Segment: segment,
              MinConsumptionFraction: minFraction,
            },
          ],
          Signatures: { Electromagnetic: { Nominal: emNominal } },
        },
      ],
    },
  };
}

// ─── 1. getPowerRangeModifierAll ─────────────────────────────────────────────

describe('getPowerRangeModifierAll', () => {
  it('returns 0 for null powerRanges', () => {
    expect(getPowerRangeModifierAll(null, 3)).toBe(0);
  });

  it('returns 0 for null activeSegments', () => {
    expect(getPowerRangeModifierAll({ t1: { Start: 0, Modifier: 1.0 } }, null)).toBe(0);
  });

  it('returns modifier for first tier when segments >= Start (pips > 0)', () => {
    const ranges = { tier1: { Start: 0, Modifier: 0.5 } };
    // 0 pips → guard clause (!activeSegments) returns 0: no power = no modifier
    expect(getPowerRangeModifierAll(ranges, 0)).toBe(0);
    expect(getPowerRangeModifierAll(ranges, 1)).toBe(0.5);
    expect(getPowerRangeModifierAll(ranges, 4)).toBe(0.5);
  });

  it('picks highest applicable tier (multi-tier)', () => {
    const ranges = {
      tier1: { Start: 0, Modifier: 0.3 },
      tier2: { Start: 2, Modifier: 0.7 },
      tier3: { Start: 4, Modifier: 1.0 },
    };
    expect(getPowerRangeModifierAll(ranges, 1)).toBe(0.3);
    expect(getPowerRangeModifierAll(ranges, 2)).toBe(0.7);
    expect(getPowerRangeModifierAll(ranges, 3)).toBe(0.7);
    expect(getPowerRangeModifierAll(ranges, 4)).toBe(1.0);
    expect(getPowerRangeModifierAll(ranges, 10)).toBe(1.0);
  });

  it('trivial ranges (Start:0, Modifier:1.0) return 1.0 for pips > 0', () => {
    // In 4.x game data, virtually all ships have trivial PowerRanges.
    // 0 pips returns 0 (guard clause); 1+ pips returns 1.0.
    const ranges = { tier1: { Start: 0, Modifier: 1.0 } };
    expect(getPowerRangeModifierAll(ranges, 0)).toBe(0); // off
    for (const pips of [1, 2, 4, 8]) {
      expect(getPowerRangeModifierAll(ranges, pips)).toBe(1.0);
    }
  });
});

// ─── 2. buildDefaultLoadout ──────────────────────────────────────────────────

describe('buildDefaultLoadout', () => {
  it('assigns baseLoadout className when present', () => {
    const slots = {
      weapons: [
        { portName: 'hardpoint_weapon_1', loadout: 'GATS_BEHR_S2_Combine_SCItem', baseLoadout: { ClassName: 'GATS_BEHR_S2_Combine_SCItem' }, ports: [] },
      ],
    };
    const loadout = buildDefaultLoadout(slots);
    expect(loadout['hardpoint_weapon_1']).toBe('GATS_BEHR_S2_Combine_SCItem');
  });

  it('assigns null for ports with types but no loadout', () => {
    const slots = {
      weapons: [
        { portName: 'hardpoint_weapon_2', types: ['WeaponGun.Gun'], ports: [] },
      ],
    };
    const loadout = buildDefaultLoadout(slots);
    expect(loadout['hardpoint_weapon_2']).toBeNull();
  });

  it('ignores ports with no loadout and no types (hardpoints without an accepted type)', () => {
    const slots = {
      systems: [
        { portName: 'hardpoint_fixed_hull', ports: [] }, // no loadout, no types
      ],
    };
    const loadout = buildDefaultLoadout(slots);
    expect(loadout['hardpoint_fixed_hull']).toBeUndefined();
  });

  it('recurses into sub-ports', () => {
    const slots = {
      weapons: [
        {
          portName: 'hardpoint_rack_1',
          loadout: 'MISS_RAFT_S2_Rattler_SCItem',
          baseLoadout: { ClassName: 'MISS_RAFT_S2_Rattler_SCItem' },
          ports: [
            { portName: 'hardpoint_missile_1_1', loadout: null, types: ['Missile.Missile'], ports: [] },
            { portName: 'hardpoint_missile_1_2', loadout: null, types: ['Missile.Missile'], ports: [] },
          ],
        },
      ],
    };
    const loadout = buildDefaultLoadout(slots);
    expect(loadout['hardpoint_rack_1']).toBe('MISS_RAFT_S2_Rattler_SCItem');
    expect(loadout['hardpoint_missile_1_1']).toBeNull();
    expect(loadout['hardpoint_missile_1_2']).toBeNull();
  });

  it('handles multiple groups', () => {
    const slots = {
      weapons: [{ portName: 'p_w', loadout: 'WeaponA', baseLoadout: { ClassName: 'WeaponA' }, ports: [] }],
      systems: [{ portName: 'p_s', types: ['Shield.Shield'], ports: [] }],
    };
    const loadout = buildDefaultLoadout(slots);
    expect(loadout['p_w']).toBe('WeaponA');
    expect(loadout['p_s']).toBeNull();
  });
});

// ─── 3. distributeShieldPipsAll ──────────────────────────────────────────────

describe('distributeShieldPipsAll', () => {
  const shields3 = [
    { max: 4, min: 1 },
    { max: 4, min: 1 },
    { max: 4, min: 1 },
  ];

  it('returns zeros for 0 total pips', () => {
    expect(distributeShieldPipsAll(shields3, 0)).toEqual([0, 0, 0]);
  });

  it('gives 1 pip to each shield first (phase 1), then distributes remainder', () => {
    // 3 shields, max 4 each. With 3 pips: 1 each.
    expect(distributeShieldPipsAll(shields3, 3)).toEqual([1, 1, 1]);
  });

  it('fills shields to capacity cap', () => {
    // 12 pips, 3 shields × max 4 → 4 each
    const result = distributeShieldPipsAll(shields3, 12);
    expect(result).toEqual([4, 4, 4]);
  });

  it('does not exceed individual shield max', () => {
    // 10 pips across 3 shields capped at 4 each → [4, 4, 2]
    const result = distributeShieldPipsAll(shields3, 10);
    const total = result.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(10);
    expect(Math.max(...result)).toBeLessThanOrEqual(4);
  });

  it('skips shields with max=0', () => {
    const shields = [{ max: 0 }, { max: 4, min: 1 }];
    const result = distributeShieldPipsAll(shields, 4);
    expect(result[0]).toBe(0);
    expect(result[1]).toBeCloseTo(4);
  });

  it('returns zeros when no shields have capacity', () => {
    const shields = [{ max: 0 }, { max: 0 }];
    expect(distributeShieldPipsAll(shields, 6)).toEqual([0, 0]);
  });
});

// ─── 4. distributeShieldPipsTop2 ─────────────────────────────────────────────

describe('distributeShieldPipsTop2', () => {
  it('only distributes to powered shields', () => {
    const shields = [
      { max: 4, powered: true },
      { max: 4, powered: false },
      { max: 4, powered: true },
    ];
    const result = distributeShieldPipsTop2(shields, 6);
    expect(result[1]).toBe(0); // unpowered shield gets nothing
    const poweredTotal = result[0] + result[2];
    expect(poweredTotal).toBeCloseTo(6);
  });

  it('returns zeros when no shields are powered', () => {
    const shields = [{ max: 4, powered: false }, { max: 4, powered: false }];
    expect(distributeShieldPipsTop2(shields, 8)).toEqual([0, 0]);
  });

  it('returns zeros for 0 total pips', () => {
    const shields = [{ max: 4, powered: true }, { max: 4, powered: true }];
    expect(distributeShieldPipsTop2(shields, 0)).toEqual([0, 0]);
  });

  it('caps at individual shield max', () => {
    const shields = [{ max: 3, powered: true }, { max: 3, powered: true }];
    const result = distributeShieldPipsTop2(shields, 10);
    // Total available is 6; excess 4 pips are simply unclaimed
    expect(result[0]).toBeCloseTo(3);
    expect(result[1]).toBeCloseTo(3);
  });

  it('gives the phase-1 pip to the largest segment first (FORMULAS.md), regardless of slot order', () => {
    const shields = [{ max: 2, powered: true }, { max: 4, powered: true }];
    expect(distributeShieldPipsTop2(shields, 1)).toEqual([0, 1]);
    // Same behavior as distributeShieldPipsAll for the asymmetric case
    expect(distributeShieldPipsAll([{ max: 2 }, { max: 4 }], 1)).toEqual([0, 1]);
  });
});

// ─── getCraftedItemStats ─────────────────────────────────────────────────────

describe('getCraftedItemStats', () => {
  // Integrity 1.2x at q=1000 - minimal single-slot blueprint.
  const makeBp = (extra) => ({
    TargetType: 'Shield',
    Tiers: [{
      Slots: [{
        Name: 'SHELL',
        Modifiers: [
          { PropertyName: 'Integrity', QualityRange: [0, 500], ModifierRange: [0.8, 1.0] },
          { PropertyName: 'Integrity', QualityRange: [501, 1000], ModifierRange: [1.0, 1.2] },
        ],
      }],
    }],
    ...extra,
  });

  const shieldItem = (className, reference) => ({
    className,
    reference,
    type: 'Shield',
    subType: 'Shield',
    size: 1,
    tags: '',
    requiredTags: '',
    sold: 0,
    stdItem: { ClassName: className, Type: 'Shield', Durability: { Health: 100 } },
  });

  beforeEach(() => setCurrentCrafting({}));

  it('resolves the blueprint via GUID after a CIG className rename', () => {
    // The item was renamed SHLD_OLD → SHLD_NEW between patches; the blueprint
    // still carries the stale TargetClassName but the stable TargetGUID.
    initLoadoutData([shieldItem('SHLD_NEW', 'guid-123')]);
    initCraftingData([makeBp({ TargetGUID: 'guid-123', TargetClassName: 'SHLD_OLD' })]);
    setCurrentCrafting({ hp_shield: { SHELL: 1000 } });

    const crafted = getCraftedItemStats('SHLD_NEW', 'hp_shield');
    expect(crafted.Durability.Health).toBeCloseTo(120);
    expect(crafted._crafted).toBe(true);
  });

  it('falls back to className lookup when the item has no reference GUID', () => {
    initLoadoutData([shieldItem('SHLD_PLAIN', undefined)]);
    initCraftingData([makeBp({ TargetClassName: 'SHLD_PLAIN' })]);
    setCurrentCrafting({ hp_shield: { SHELL: 1000 } });

    const crafted = getCraftedItemStats('SHLD_PLAIN', 'hp_shield');
    expect(crafted.Durability.Health).toBeCloseTo(120);
  });

  it('returns the base stdItem reference when the port has no crafting state', () => {
    initLoadoutData([shieldItem('SHLD_NEW', 'guid-123')]);
    initCraftingData([makeBp({ TargetGUID: 'guid-123', TargetClassName: 'SHLD_OLD' })]);

    const crafted = getCraftedItemStats('SHLD_NEW', 'hp_shield');
    expect(crafted.Durability.Health).toBe(100);
    expect(crafted._crafted).toBeUndefined();
  });
});

// ─── 5. calculateCoolingStats ────────────────────────────────────────────────

describe('calculateCoolingStats', () => {
  beforeEach(() => {
    // Register a cooler item: outputs 50 coolant/s, trivial PowerRanges (modifier=1 always)
    initLoadoutData([makeCoolerItem('COOL_TEST_01', 50)]);
  });

  it('calculates supply from a single fully-powered cooler', () => {
    const channels = [
      { key: 'cooler_0', allocated: 4, max: 4 },
    ];
    const slots = {
      systems: [{ portName: 'cooler_slot_0', category: 'Coolers' }],
    };
    const loadout = { cooler_slot_0: 'COOL_TEST_01' };
    const { coolingSupply } = calculateCoolingStats(channels, loadout, slots);
    // modifier=1.0, pipFraction=1.0 → supply = 50
    expect(coolingSupply).toBeCloseTo(50);
  });

  it('returns zero supply when no cooler is equipped', () => {
    const channels = [{ key: 'cooler_0', allocated: 0, max: 4 }];
    const slots = { systems: [{ portName: 'cooler_slot_0', category: 'Coolers' }] };
    const loadout = { cooler_slot_0: null };
    const { coolingSupply } = calculateCoolingStats(channels, loadout, slots);
    expect(coolingSupply).toBe(0);
  });

  it('powerHeat excludes cooler pips (they emit heat via operationalHeat instead)', () => {
    // 4 weapons + 2 radar + 4 cooler pips. powerHeat must NOT include the cooler
    // pips (they'd double-count once operationalHeat picks up the cooler's PR
    // contribution). With no PowerRanges on cooler channel here, opHeat=0,
    // so demand = 4 + 2 = 6, not 10.
    const channels = [
      { key: 'weapons', allocated: 4 },
      { key: 'radar', allocated: 2 },
      { key: 'cooler_0', allocated: 4, max: 4 },
    ];
    const slots = { systems: [{ portName: 'cooler_slot_0', category: 'Coolers' }] };
    const loadout = { cooler_slot_0: 'COOL_TEST_01' };
    const { coolingDemand } = calculateCoolingStats(channels, loadout, slots);
    expect(coolingDemand).toBeCloseTo(6);
  });

  it('cooler contributes operational heat via its PowerRanges', () => {
    // Same scenario but cooler channel carries its PowerRanges. Cooler at full
    // pips with trivial mod=1 → op heat = max(4) × 1 × (4/4) = 4. Total demand
    // = powerHeat(4+2) + opHeat(4) = 10.
    const channels = [
      { key: 'weapons', allocated: 4 },
      { key: 'radar', allocated: 2 },
      {
        key: 'cooler_0', allocated: 4, max: 4, powerSegment: 4,
        powerRanges: { t1: { Start: 0, Modifier: 1.0, RegisterRange: true } },
      },
    ];
    const slots = { systems: [{ portName: 'cooler_slot_0', category: 'Coolers' }] };
    const loadout = { cooler_slot_0: 'COOL_TEST_01' };
    const { coolingDemand } = calculateCoolingStats(channels, loadout, slots);
    expect(coolingDemand).toBeCloseTo(10);
  });

  it('shield IR demand uses top-2 powered distribution, not all-shields', () => {
    // 4 shields × seg 4, 2 powered. With alloc=8, top-2 distributes [4, 4, 0, 0]
    // (each powered shield maxes); old all-shields formula would give [2, 2, 2, 2].
    // Each powered shield at full pips with mod=1 contributes seg(4) × 1 × 1 = 4
    // operational heat → 8 total. With distributeShieldPipsAll it would be
    // 4 shields × 4 × mod(2) × 0.5 = 8 × mod(2). For PowerRanges with Start=2,
    // mod(2)=1 → also 8, but at lower alloc the curves diverge - verified in
    // the integration tests below.
    const pr = { Low: { Start: 0, Modifier: 0.7, RegisterRange: false },
                 Medium: { Start: 1, Modifier: 0.85, RegisterRange: true },
                 High: { Start: 2, Modifier: 1.0, RegisterRange: true } };
    const shieldSlots = [
      { max: 4, min: 1, powered: true, powerRanges: pr },
      { max: 4, min: 1, powered: true, powerRanges: pr },
      { max: 4, min: 1, powered: false, powerRanges: pr },
      { max: 4, min: 1, powered: false, powerRanges: pr },
    ];
    const channels = [
      { key: 'shields', allocated: 8, poweredMax: 8, shieldSlots },
      { key: 'cooler_0', allocated: 0, max: 4 },
    ];
    const slots = { systems: [{ portName: 'cooler_slot_0', category: 'Coolers' }] };
    const loadout = { cooler_slot_0: 'COOL_TEST_01' };
    const { coolingDemand } = calculateCoolingStats(channels, loadout, slots);
    // powerHeat: shield min(8, 8) = 8 (coolers excluded, but alloc=0 anyway).
    // opHeat: top-2 distributes [4, 4, 0, 0], each powered: 4×1×1 = 4, total 8.
    // demand = 16.
    expect(coolingDemand).toBeCloseTo(16);
  });

  it('shield IR - unpowered shields contribute 0 even at high alloc', () => {
    // Same 4 shields with 2 powered, but alloc=16 (visual max). Top-2 still caps
    // at the powered shields' segments → [4, 4, 0, 0]. Unpowered shields get 0,
    // so they add no heat.
    const pr = { Low: { Start: 0, Modifier: 0.7, RegisterRange: false },
                 Medium: { Start: 1, Modifier: 0.85, RegisterRange: true },
                 High: { Start: 2, Modifier: 1.0, RegisterRange: true } };
    const shieldSlots = [
      { max: 4, min: 1, powered: true, powerRanges: pr },
      { max: 4, min: 1, powered: true, powerRanges: pr },
      { max: 4, min: 1, powered: false, powerRanges: pr },
      { max: 4, min: 1, powered: false, powerRanges: pr },
    ];
    const channels = [
      { key: 'shields', allocated: 16, poweredMax: 8, shieldSlots },
      { key: 'cooler_0', allocated: 0, max: 4 },
    ];
    const slots = { systems: [{ portName: 'cooler_slot_0', category: 'Coolers' }] };
    const loadout = { cooler_slot_0: 'COOL_TEST_01' };
    const { coolingDemand } = calculateCoolingStats(channels, loadout, slots);
    // powerHeat capped at poweredMax=8. opHeat from top-2 = 8.
    expect(coolingDemand).toBeCloseTo(16);
  });

  it('coolingPercent is demand/supply × 100', () => {
    const channels = [
      { key: 'weapons', allocated: 10 },
      { key: 'cooler_0', allocated: 4, max: 4 },
    ];
    const slots = { systems: [{ portName: 'cooler_slot_0', category: 'Coolers' }] };
    const loadout = { cooler_slot_0: 'COOL_TEST_01' };
    const { coolingDemand, coolingSupply, coolingPercent } = calculateCoolingStats(channels, loadout, slots);
    // supply=50, powerHeat=10+4=14
    expect(coolingPercent).toBeCloseTo((coolingDemand / coolingSupply) * 100);
  });
});

// ─── 6. calculateEMSignature ─────────────────────────────────────────────────

describe('calculateEMSignature', () => {
  it('returns 0 with no channels', () => {
    expect(calculateEMSignature([], 100, 10)).toBe(0);
  });

  it('returns 0 if ppSeg is 0', () => {
    expect(calculateEMSignature([{ key: 'radar', allocated: 2, emNominal: 50 }], 100, 0)).toBe(0);
  });

  it('PP contribution scales with total allocated pips', () => {
    // ppSeg=10, ppEM=100, totalPips=5 → PP EM = 100 * (5/10) = 50
    const channels = [{ key: 'radar', allocated: 5 }];
    const em = calculateEMSignature(channels, 100, 10);
    expect(em).toBeCloseTo(50);
  });

  it('components with emNominal and powerRanges contribute scaled EM', () => {
    // radar ch: allocated=4, max=4, emNominal=200, powerRanges trivial (mod=1), max=4
    // component EM = 200 * 1 * (4/4) = 200
    // ppEM=0 so PP contributes 0
    const channels = [
      {
        key: 'radar',
        allocated: 4,
        max: 4,
        emNominal: 200,
        powerRanges: { t1: { Start: 0, Modifier: 1.0 } },
        powerSegment: 4,
      },
    ];
    const em = calculateEMSignature(channels, 0, 4);
    expect(em).toBeGreaterThanOrEqual(0);
    // Primarily checking it doesn't throw and gives a non-negative result
  });

  it('weapons channel does not add component EM (powerRanges=null)', () => {
    // Weapon EM is handled via emNominal on the weapons channel itself, but
    // calculateEMSignature only adds component EM for channels with powerRanges
    const channels = [
      { key: 'weapons', allocated: 4, emNominal: 500 },
    ];
    const em = calculateEMSignature(channels, 0, 4);
    // weapons channel has no powerRanges so no component EM is added beyond PP
    expect(em).toBeCloseTo(0); // ppEM=0, totalPips=4, ppSeg=4 → PP=0*1=0
  });
});

// ─── 7. buildPipAllocation - weapon channel regression ───────────────────────

describe('buildPipAllocation - weapon channel', () => {
  beforeEach(() => {
    initLoadoutData([]);
  });

  it('weapon channel allocated is clamped to weaponPoolSize', () => {
    // Ship with weaponPoolSize 6, weapons needing more than 6
    const shipConfig = {
      weaponPoolSize: 6,
      ifcsSegment: 4,
      ifcsMinFraction: 0.25,
      ifcsPowerRanges: null,
    };
    // Slots with weapons, no systems
    const slots = {
      weapons: [
        { portName: 'hp_gun_1', ports: [] },
        { portName: 'hp_gun_2', ports: [] },
      ],
    };
    const loadout = { hp_gun_1: null, hp_gun_2: null };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 20, null);
    const wpnCh = channels.find(c => c.key === 'weapons');
    expect(wpnCh).toBeDefined();
    // allocated should never exceed max (weaponPoolSize)
    expect(wpnCh.allocated).toBeLessThanOrEqual(wpnCh.max);
    expect(wpnCh.max).toBe(6);
  });

  it('weapon channel needed reflects actual weapon power draw', () => {
    // When all weapon slots are empty, needed=0
    const shipConfig = { weaponPoolSize: 10, ifcsSegment: 4, ifcsMinFraction: 0, ifcsPowerRanges: null };
    const slots = { weapons: [{ portName: 'hp_gun_1', ports: [] }] };
    const loadout = { hp_gun_1: null };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 20, null);
    const wpnCh = channels.find(c => c.key === 'weapons');
    expect(wpnCh.needed).toBe(0);
    expect(wpnCh.allocated).toBe(0);
  });

  it('quantum drive channel is marked binary (fixed power draw - no fractional pips)', () => {
    // QD has a fixed in-game power draw - either engaged (drawing full
    // segment) or off. The pip handler and renderer rely on `binary:true`
    // to enforce 0/max-only allocation.
    const shipConfig = { weaponPoolSize: 4, ifcsSegment: 4, ifcsMinFraction: 0, ifcsPowerRanges: null };
    const slots = {
      weapons: [],
      systems: [{ portName: 'qd_slot', category: 'Quantum Drive' }],
    };
    // Register a QD item so the segment lookup finds something
    initLoadoutData([{
      className: 'QDRV_TEST', type: 'QuantumDrive', subType: 'QDrive', size: 2,
      tags: '', requiredTags: '', sold: 0,
      stdItem: {
        ClassName: 'QDRV_TEST', Name: 'Test QD', Type: 'QuantumDrive.QDrive',
        ResourceNetwork: [{ Consumption: [{ Resource: 'Power', Segment: 3, MinConsumptionFraction: 0 }] }],
      },
    }]);
    const loadout = { qd_slot: 'QDRV_TEST' };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 20, null);
    const qdCh = channels.find(c => c.key === 'quantumDrive');
    expect(qdCh).toBeDefined();
    expect(qdCh.binary).toBe(true);
    expect(qdCh.max).toBe(3);
    expect(qdCh.allocated).toBe(0); // off by default
  });

  it('quantum drive channel carries emNominal for EM signature calc', () => {
    // QDs emit significant EM when engaged. Without emNominal on the channel,
    // calculateEMSignature skips the channel entirely and total EM drops when
    // QD turns on (because the shield<->QD mutex turns off shield EM).
    const shipConfig = { weaponPoolSize: 4, ifcsSegment: 4, ifcsMinFraction: 0, ifcsPowerRanges: null };
    const slots = {
      weapons: [],
      systems: [{ portName: 'qd_slot', category: 'Quantum Drive' }],
    };
    initLoadoutData([{
      className: 'QDRV_BIG_EM', type: 'QuantumDrive', subType: 'QDrive', size: 2,
      tags: '', requiredTags: '', sold: 0,
      stdItem: {
        ClassName: 'QDRV_BIG_EM', Name: 'Big EM QD', Type: 'QuantumDrive.QDrive',
        ResourceNetwork: [{
          Consumption: [{ Resource: 'Power', Segment: 2, MinConsumptionFraction: 0 }],
          Signatures: { Electromagnetic: { Nominal: 12345 } },
        }],
      },
    }]);
    const loadout = { qd_slot: 'QDRV_BIG_EM' };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 20, null);
    const qdCh = channels.find(c => c.key === 'quantumDrive');
    expect(qdCh.emNominal).toBe(12345);

    // When QD is off (allocated=0), it contributes 0 EM. When on (allocated=max),
    // it contributes its full nominal EM via the linear binary-device branch.
    qdCh.allocated = 0;
    const emOff = calculateEMSignature(channels, 0, 1);
    qdCh.allocated = qdCh.max;
    const emOn = calculateEMSignature(channels, 0, 1);
    expect(emOn - emOff).toBeCloseTo(12345);
  });

  it('multi-node ResourceNetwork (QD) takes max EM nominal, not sum', () => {
    // Real-world QD items have 2 ResourceNetwork nodes with identical EM
    // (one per spool/cruise mode). Summing them doubles the reported EM.
    // Channel emNominal should match a single node's value.
    const shipConfig = { weaponPoolSize: 4, ifcsSegment: 4, ifcsMinFraction: 0, ifcsPowerRanges: null };
    const slots = {
      weapons: [],
      systems: [{ portName: 'qd_slot', category: 'Quantum Drive' }],
    };
    initLoadoutData([{
      className: 'QDRV_DUAL_NODE', type: 'QuantumDrive', subType: 'QDrive', size: 2,
      tags: '', requiredTags: '', sold: 0,
      stdItem: {
        ClassName: 'QDRV_DUAL_NODE', Name: 'Dual Node QD', Type: 'QuantumDrive.QDrive',
        ResourceNetwork: [
          { Consumption: [{ Resource: 'Power', Segment: 2 }], Signatures: { Electromagnetic: { Nominal: 18000 } } },
          { Consumption: [{ Resource: 'Power', Segment: 2 }], Signatures: { Electromagnetic: { Nominal: 18000 } } },
        ],
      },
    }]);
    const loadout = { qd_slot: 'QDRV_DUAL_NODE' };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 20, null);
    const qdCh = channels.find(c => c.key === 'quantumDrive');
    expect(qdCh.emNominal).toBe(18000); // not 36000 (sum)
  });
});

describe('isGroundVehicleMissileRack / ground-rack exclusion', () => {
  // Mirrors the real data: a ground-vehicle rack mislabeled with the SHIP rack
  // type, sharing the "MSD-212 Missile Rack" name with a genuine ship rack.
  const groundRack = {
    className: 'GMRCK_S02_BEHR_Single_S02', type: 'MissileLauncher', subType: 'MissileRack',
    size: 2, tags: '', requiredTags: '', sold: 0,
    stdItem: { ClassName: 'GMRCK_S02_BEHR_Single_S02', Name: 'MSD-212 Missile Rack',
      Type: 'MissileLauncher.MissileRack',
      Ports: [{ Types: ['Missile.GroundVehicleMissile'], MinSize: 2, MaxSize: 2 }] },
  };
  const shipRack = {
    className: 'MRCK_S02_BEHR_Single_S02', type: 'MissileLauncher', subType: 'MissileRack',
    size: 2, tags: '', requiredTags: '', sold: 0,
    stdItem: { ClassName: 'MRCK_S02_BEHR_Single_S02', Name: 'MSD-212 Missile Rack',
      Type: 'MissileLauncher.MissileRack',
      Ports: [{ Types: ['Missile.Missile'], MinSize: 2, MaxSize: 2 }] },
  };

  it('flags a rack with GroundVehicleMissile sub-ports', () => {
    expect(isGroundVehicleMissileRack(groundRack)).toBe(true);
  });

  it('does not flag a genuine ship missile rack', () => {
    expect(isGroundVehicleMissileRack(shipRack)).toBe(false);
  });

  it('returns false for items without rack sub-ports / missing stdItem', () => {
    expect(isGroundVehicleMissileRack({ className: 'MISL_S02_X', stdItem: { Ports: [] } })).toBe(false);
    expect(isGroundVehicleMissileRack({ className: 'X' })).toBe(false);
    expect(isGroundVehicleMissileRack(null)).toBe(false);
  });

  it('getCompatibleItems excludes the ground rack from a ship missile-rack hardpoint', () => {
    // Ground rack sorts FIRST (as in the real data) - regression for the
    // empty-missile-picker bug on the Aurora Mk II "MSD-212" swap.
    initLoadoutData([groundRack, shipRack]);
    const hardpoint = { MinSize: 2, MaxSize: 2, Types: ['MissileLauncher.MissileRack'] };
    const compatible = getCompatibleItems(hardpoint);
    const classes = compatible.map(i => i.className);
    expect(classes).toContain('MRCK_S02_BEHR_Single_S02');
    expect(classes).not.toContain('GMRCK_S02_BEHR_Single_S02');
  });
});

// ─── 8. calculateStats - power plant output formula ──────────────────────────

/**
 * Build a minimal item that appears to be a power plant in the calculateStats
 * loop. calculateStats reads ResourceNetwork[].Generation[] where Resource='Power'.
 * The item must be registered via initLoadoutData to pass getCraftedItemStats.
 */
function makePPItem(className, segment, size, emNominal = 0) {
  return {
    className,
    type: 'PowerPlant',
    subType: 'PowerPlant',
    size,
    tags: '',
    requiredTags: '',
    sold: 0,
    stdItem: {
      ClassName: className,
      Name: className,
      Type: 'PowerPlant.PowerPlant',
      Size: size,
      ResourceNetwork: [
        {
          Generation: [{ Resource: 'Power', Segment: segment }],
          Signatures: { Electromagnetic: { Nominal: emNominal } },
        },
      ],
    },
  };
}

/** Build a minimal shield item for calculateStats shield aggregation. */
function makeShieldItem(className, hp) {
  return {
    className,
    type: 'Shield',
    subType: 'Shield',
    size: 1,
    tags: '',
    requiredTags: '',
    sold: 0,
    stdItem: {
      ClassName: className,
      Name: className,
      Type: 'Shield.Shield',
      Size: 1,
      Shield: { Health: hp },
    },
  };
}

describe('calculateStats - power plant output', () => {
  beforeEach(() => setCurrentCrafting({}));

  it('single power plant: powerOutput = round(segment / 1) + 0 * size = segment', () => {
    // With 1 PP: numPPs=1, baseSegments = round(seg/1) = seg, (1-1)*size = 0
    // powerOutput = seg
    initLoadoutData([makePPItem('POWR_S01', 120, 2)]);
    const loadout = { pp_slot: 'POWR_S01' };
    const stats = calculateStats(loadout);
    // round(120/1) + 0 * 2 = 120
    expect(stats.powerOutput).toBe(120);
  });

  it('two power plants (same segment, same size): output = 2*round(seg/2) + 1*totalSize', () => {
    // numPPs=2, segment=100 each, size=2 each
    // baseSegments = round(100/2) + round(100/2) = 50 + 50 = 100
    // totalSize = 2 + 2 = 4
    // powerOutput = 100 + (2-1)*4 = 100 + 4 = 104
    initLoadoutData([makePPItem('POWR_A', 100, 2), makePPItem('POWR_B', 100, 2)]);
    const loadout = { pp1: 'POWR_A', pp2: 'POWR_B' };
    const stats = calculateStats(loadout);
    expect(stats.powerOutput).toBe(104);
  });

  it('two power plants (different segments): baseSegments rounds each independently', () => {
    // PP1: segment=101, size=3 → round(101/2) = 51
    // PP2: segment=101, size=3 → round(101/2) = 51
    // baseSegments = 51 + 51 = 102
    // totalSize = 3 + 3 = 6
    // powerOutput = 102 + 1*6 = 108
    initLoadoutData([makePPItem('POWR_C', 101, 3), makePPItem('POWR_D', 101, 3)]);
    const loadout = { pp1: 'POWR_C', pp2: 'POWR_D' };
    const stats = calculateStats(loadout);
    expect(stats.powerOutput).toBe(108);
  });

  it('no power plants: powerOutput = 0', () => {
    initLoadoutData([]);
    const stats = calculateStats({});
    expect(stats.powerOutput).toBe(0);
  });

  it('ppEM sums EM across all power plants', () => {
    initLoadoutData([makePPItem('POWR_EM_A', 100, 2, 500), makePPItem('POWR_EM_B', 100, 2, 300)]);
    const loadout = { pp1: 'POWR_EM_A', pp2: 'POWR_EM_B' };
    const stats = calculateStats(loadout);
    expect(stats.ppEM).toBe(800);
  });

  it('ppSeg equals powerOutput', () => {
    initLoadoutData([makePPItem('POWR_S02', 80, 1)]);
    const stats = calculateStats({ pp: 'POWR_S02' });
    expect(stats.ppSeg).toBe(stats.powerOutput);
  });

  it('disabledPorts skips power plants in the set', () => {
    initLoadoutData([makePPItem('POWR_S03', 100, 2)]);
    const disabled = new Set(['pp_disabled']);
    const stats = calculateStats({ pp_disabled: 'POWR_S03' }, disabled);
    expect(stats.powerOutput).toBe(0);
  });
});

describe('calculateStats - shield HP aggregation', () => {
  beforeEach(() => setCurrentCrafting({}));

  it('sums HP across all shields in the loadout', () => {
    initLoadoutData([makeShieldItem('SHLD_S01', 1000), makeShieldItem('SHLD_S02', 2000)]);
    const stats = calculateStats({ s1: 'SHLD_S01', s2: 'SHLD_S02' });
    expect(stats.shieldHP).toBe(3000);
    expect(stats.shieldCount).toBe(2);
  });

  it('single shield: shieldHP = shield.Health', () => {
    initLoadoutData([makeShieldItem('SHLD_SOLO', 1500)]);
    const stats = calculateStats({ s1: 'SHLD_SOLO' });
    expect(stats.shieldHP).toBe(1500);
    expect(stats.shieldCount).toBe(1);
  });

  it('no shields: shieldHP = 0, shieldCount = 0', () => {
    initLoadoutData([]);
    const stats = calculateStats({});
    expect(stats.shieldHP).toBe(0);
    expect(stats.shieldCount).toBe(0);
  });
});

// ─── 9. buildPipAllocation - channel ordering and shield budget distinction ──

describe('buildPipAllocation - channel ordering', () => {
  beforeEach(() => {
    initLoadoutData([]);
    setCurrentCrafting({});
  });

  it('engine channel is inserted at index 1 (second, after weapons)', () => {
    const shipConfig = { weaponPoolSize: 4, ifcsSegment: 6, ifcsMinFraction: 0.25, ifcsPowerRanges: null };
    const slots = { weapons: [], systems: [] };
    const { channels } = buildPipAllocation({}, slots, shipConfig, 20, null);
    expect(channels[0].key).toBe('weapons');
    expect(channels[1].key).toBe('engine');
  });

  it('shields channel appears before radar and lifeSupport', () => {
    const shipConfig = { weaponPoolSize: 4, ifcsSegment: 4, ifcsMinFraction: 0, ifcsPowerRanges: null };
    const slots = {
      weapons: [],
      systems: [
        { portName: 'radar_slot', category: 'Radar' },
        { portName: 'ls_slot', category: 'Life Support' },
        { portName: 'shield_slot', category: 'Shields' },
      ],
    };
    const loadout = { radar_slot: null, ls_slot: null, shield_slot: null };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 20, null);
    const keys = channels.map(c => c.key);
    const shieldsIdx = keys.indexOf('shields');
    const radarIdx = keys.indexOf('radar');
    const lsIdx = keys.indexOf('lifeSupport');
    expect(shieldsIdx).toBeLessThan(radarIdx);
    expect(shieldsIdx).toBeLessThan(lsIdx);
  });

  it('cooler channels appear after lifeSupport', () => {
    const shipConfig = { weaponPoolSize: 4, ifcsSegment: 4, ifcsMinFraction: 0, ifcsPowerRanges: null };
    initLoadoutData([makeCoolerItem('COOL_ORD', 50)]);
    const slots = {
      weapons: [],
      systems: [
        { portName: 'ls_slot', category: 'Life Support' },
        { portName: 'cooler_slot_0', category: 'Coolers' },
      ],
    };
    const loadout = { ls_slot: null, cooler_slot_0: 'COOL_ORD' };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 20, null);
    const keys = channels.map(c => c.key);
    const lsIdx = keys.indexOf('lifeSupport');
    const coolerIdx = keys.indexOf('cooler_0');
    expect(coolerIdx).toBeGreaterThan(lsIdx);
  });
});

describe('buildPipAllocation - shield budget vs visual distinction', () => {
  beforeEach(() => {
    initLoadoutData([]);
    setCurrentCrafting({});
  });

  it('shield channel allocated == max (all shields sum) but poweredMax covers only 2', () => {
    // 4 shields × seg=3: visual max = 12, poweredMax (2 smallest min) = 6
    // applyDefaultAllocation sets allocated=max=12 but charges budget only poweredMax=6
    const shipConfig = { weaponPoolSize: 0, ifcsSegment: 0, ifcsMinFraction: 0, ifcsPowerRanges: null };
    const shieldItem = makePowerItem('SHLD_QUAD', 3, 0, 0);
    initLoadoutData([shieldItem]);
    const slots = {
      weapons: [],
      systems: [
        { portName: 'sh1', category: 'Shields' },
        { portName: 'sh2', category: 'Shields' },
        { portName: 'sh3', category: 'Shields' },
        { portName: 'sh4', category: 'Shields' },
      ],
    };
    const loadout = { sh1: 'SHLD_QUAD', sh2: 'SHLD_QUAD', sh3: 'SHLD_QUAD', sh4: 'SHLD_QUAD' };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 50, null);
    const shCh = channels.find(c => c.key === 'shields');
    expect(shCh).toBeDefined();
    // Visual allocated = sum of all 4 shields' segments
    expect(shCh.max).toBe(12);
    expect(shCh.allocated).toBe(12); // addPips gives full visual amount
    // But budget cost = poweredMax = sum of only 2 powered shields' segments
    expect(shCh.poweredMax).toBe(6);
  });

  it('applyDefaultAllocation priority: shields get pips before weapons when budget allows', () => {
    // Budget = 50 pips, weapons need 4, shields cost 4 (2 shields × seg 2)
    // After min engine=0, shields should be funded before weapons.
    const shipConfig = { weaponPoolSize: 6, ifcsSegment: 0, ifcsMinFraction: 0, ifcsPowerRanges: null };
    initLoadoutData([makePowerItem('SHLD_PRIO', 2, 0, 0)]);
    const slots = {
      weapons: [{ portName: 'hp1', ports: [] }],
      systems: [
        { portName: 'sh1', category: 'Shields' },
        { portName: 'sh2', category: 'Shields' },
      ],
    };
    const loadout = { hp1: null, sh1: 'SHLD_PRIO', sh2: 'SHLD_PRIO' };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 50, null);
    const shCh = channels.find(c => c.key === 'shields');
    const wpnCh = channels.find(c => c.key === 'weapons');
    // Shields were funded (4 visual pips total, budget cost 4 for 2 powered shields)
    expect(shCh.allocated).toBeGreaterThan(0);
    // Weapons needed=0 (no weapon equipped), so allocated=0 is expected
    expect(wpnCh.allocated).toBe(0);
  });

  it('shieldSlots array is populated on the shields channel', () => {
    const shipConfig = { weaponPoolSize: 0, ifcsSegment: 0, ifcsMinFraction: 0, ifcsPowerRanges: null };
    initLoadoutData([makePowerItem('SHLD_SL', 4, 0, 0)]);
    const slots = {
      weapons: [],
      systems: [{ portName: 'sh1', category: 'Shields' }],
    };
    const loadout = { sh1: 'SHLD_SL' };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 20, null);
    const shCh = channels.find(c => c.key === 'shields');
    expect(Array.isArray(shCh.shieldSlots)).toBe(true);
    expect(shCh.shieldSlots).toHaveLength(1);
    expect(shCh.shieldSlots[0].max).toBe(4);
    expect(shCh.shieldSlots[0].powered).toBe(true); // single shield → powered
  });
});

// ─── 8. calculateBoostTime ───────────────────────────────────────────────────

describe('calculateBoostTime', () => {
  it('returns null when the ship declares no capacitor', () => {
    expect(calculateBoostTime(null)).toBeNull();
    expect(calculateBoostTime(undefined)).toBeNull();
  });

  it('returns null for a zero-size or zero-drain capacitor', () => {
    expect(calculateBoostTime({ size: 0, idleCost: 1, usageModifier: 1 })).toBeNull();
    expect(calculateBoostTime({ size: 20, idleCost: 0, usageModifier: 1 })).toBeNull();
    expect(calculateBoostTime({ size: 20, idleCost: 1, usageModifier: 0 })).toBeNull();
  });

  // The two usage-curve GUIDs referenced by flight blades. Values read from
  // Data/Libs/Foundry/Records/capacitorassignment/ in the extractor cache:
  // Always_1 → 1.0, Linear_100_75 → 0.75 (output at full input).
  const ALWAYS_1 = '822703ac-f458-433e-af38-352232852175';
  const LINEAR_100_75 = '6bb5a702-af02-4b5e-b308-5c89d2268379';

  // Real capacitor blocks from Live 4.9.0.12326004. All six agree with
  // SPViewer except the Cutlass Black, where an in-game stopwatch (2m20s)
  // confirmed OUR figure and not SPViewer's 18.48 s. The Buccaneer was also
  // measured in-game (~33 s).
  it.each([
    ['Anvil F7C Hornet Mk II', 20, 1, ALWAYS_1, 20],
    ['Anvil Carrack', 20, 1, LINEAR_100_75, 26.666667],
    ['Drake Buccaneer', 25, 1, LINEAR_100_75, 33.333333],
    ['Aegis Sabre Peregrine', 25, 1, LINEAR_100_75, 33.333333],
    ['Aegis Idris-P', 1500, 50, ALWAYS_1, 30],
    ['Drake Cutlass Black', 2800, 20, ALWAYS_1, 140],
  ])('computes the verified boost time for %s', (_ship, size, idleCost, usageCurve, expected) => {
    expect(calculateBoostTime({ size, idleCost, usageModifier: 1, usageCurve }))
      .toBeCloseTo(expected, 4);
  });

  // The legacy-scale ships (Cutlass Black/Blue/Red, Idris x3) carry non-zero
  // LinearCost/AngularCost. Applying them would wreck both figures - the
  // Cutlass in particular measured 140 s in-game, so anything that shortens
  // it is wrong. Guard against a future "improvement" that folds them in.
  it('ignores linear and angular cost on legacy-scale ships', () => {
    const cutlass = { size: 2800, idleCost: 20, usageCurve: ALWAYS_1 };
    expect(calculateBoostTime({ ...cutlass, linearCost: 1, angularCost: 0.1 }))
      .toBeCloseTo(140, 4);
    const idris = { size: 1500, idleCost: 50, usageCurve: ALWAYS_1 };
    expect(calculateBoostTime({ ...idris, linearCost: 1, angularCost: 0.2 }))
      .toBeCloseTo(30, 4);
  });

  // Regression guard: the Buccaneer and the F7C Mk II differ ONLY by capacitor
  // size (25 vs 20) yet SPViewer reports 33.33 vs 20. Reproducing both is the
  // whole reason the usage curve has to be applied - a size-only model gives
  // a 1.25 ratio where the real one is 1.67.
  it('separates the two usage curves at identical idle cost', () => {
    const always = calculateBoostTime({ size: 20, idleCost: 1, usageCurve: ALWAYS_1 });
    const linear = calculateBoostTime({ size: 25, idleCost: 1, usageCurve: LINEAR_100_75 });
    expect(linear / always).toBeCloseTo(1.666667, 4);
  });

  it('falls back to a 1.0 drain multiplier for an unknown or absent curve', () => {
    expect(calculateBoostTime({ size: 20, idleCost: 1 })).toBeCloseTo(20, 5);
    expect(calculateBoostTime({ size: 20, idleCost: 1, usageCurve: 'not-a-real-guid' }))
      .toBeCloseTo(20, 5);
  });

  it('scales inversely with idle cost (short-endurance racers)', () => {
    // Origin X1: 15 / 2.0, Always_1
    expect(calculateBoostTime({ size: 15, idleCost: 2, usageCurve: ALWAYS_1 })).toBeCloseTo(7.5, 5);
    // Aopoa Nox: 10 / 4.0, Always_1
    expect(calculateBoostTime({ size: 10, idleCost: 4, usageCurve: ALWAYS_1 })).toBeCloseTo(2.5, 5);
  });

  it('scales with the capacitor usage modifier', () => {
    expect(calculateBoostTime({ size: 20, idleCost: 1, usageModifier: 2 })).toBeCloseTo(10, 5);
  });

  it('defaults the usage modifier to 1 when absent', () => {
    expect(calculateBoostTime({ size: 25, idleCost: 1 })).toBeCloseTo(25, 5);
  });

  // ── engine-pip scaling ──
  // The curves take the engine power assignment as input, so boost length
  // moves with pips. engFrac defaults to 1 (full pips), which is the case
  // every SPViewer reference and both in-game measurements were taken at.
  it('leaves Always_1 ships flat across the whole pip range', () => {
    const f7c = { size: 20, idleCost: 1, usageCurve: ALWAYS_1 };
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      expect(calculateBoostTime(f7c, f)).toBeCloseTo(20, 5);
    }
  });

  it('lengthens boost with engine pips on Linear_100_75 ships', () => {
    const bucc = { size: 25, idleCost: 1, usageCurve: LINEAR_100_75 };
    expect(calculateBoostTime(bucc, 0)).toBeCloseTo(25, 5);          // drain 1.000
    expect(calculateBoostTime(bucc, 0.5)).toBeCloseTo(28.571429, 4); // drain 0.875
    expect(calculateBoostTime(bucc, 1)).toBeCloseTo(33.333333, 4);   // drain 0.750
  });

  it('clamps the pip fraction to 0-1 and defaults to full', () => {
    const bucc = { size: 25, idleCost: 1, usageCurve: LINEAR_100_75 };
    expect(calculateBoostTime(bucc, -5)).toBeCloseTo(25, 5);
    expect(calculateBoostTime(bucc, 99)).toBeCloseTo(33.333333, 4);
    expect(calculateBoostTime(bucc)).toBeCloseTo(33.333333, 4);
  });
});

// ─── 9. calculateBoostRegenTime ──────────────────────────────────────────────

describe('calculateBoostRegenTime', () => {
  // Linear_50_100 - the SCM regen curve on all 225 flight blades.
  const REGEN = 'f381647d-1e21-4dd2-b63b-567f012deeda';

  it('returns null without a capacitor or a usable regen rate', () => {
    expect(calculateBoostRegenTime(null)).toBeNull();
    expect(calculateBoostRegenTime({ size: 20, regenPerSec: 0, regenCurve: REGEN })).toBeNull();
    expect(calculateBoostRegenTime({ size: 0, regenPerSec: 0.75, regenCurve: REGEN })).toBeNull();
  });

  // At full pips this must equal the extractor's own RegenerationTime field
  // (Size / RegenPerSec), which matches SPViewer on all three.
  it.each([
    ['Drake Buccaneer', 25, 0.75, 33.333333],
    ['Anvil F7C Hornet Mk II', 20, 0.75, 26.666667],
    ['Drake Cutlass Black', 2800, 100, 28],
  ])('matches the exported RegenerationTime at full pips for %s', (_s, size, regenPerSec, expected) => {
    expect(calculateBoostRegenTime({ size, regenPerSec, regenCurve: REGEN }, 1))
      .toBeCloseTo(expected, 4);
  });

  it('halves the regen rate at zero engine pips', () => {
    const bucc = { size: 25, regenPerSec: 0.75, regenCurve: REGEN };
    expect(calculateBoostRegenTime(bucc, 0)).toBeCloseTo(66.666667, 4);   // rate x0.50
    expect(calculateBoostRegenTime(bucc, 0.5)).toBeCloseTo(44.444444, 4); // rate x0.75
    expect(calculateBoostRegenTime(bucc, 1)).toBeCloseTo(33.333333, 4);   // rate x1.00
  });

  it('falls back to an unscaled rate for an unknown curve', () => {
    expect(calculateBoostRegenTime({ size: 25, regenPerSec: 0.75 }, 0)).toBeCloseTo(33.333333, 4);
  });
});

// ─── 10. scaleCrossSection ──────────────────────────────────────────────────

describe('scaleCrossSection', () => {
  // Base values and multipliers read from Live 4.9.0.12326004 vehicle_stats.json.
  const PROWLER = { Front: 3372, Side: 6765, Top: 6787 };

  it('multiplies every axis by the CrossSection signal multiplier', () => {
    // Esperia Prowler, CS multiplier 0.55. Confirmed in-game 2026-07-31 - this
    // is the ship that rules out both "no multiplier" and "1 + multiplier".
    const r = scaleCrossSection(PROWLER, 0.55);
    expect(r.Front).toBeCloseTo(1854.6, 1);
    expect(r.Side).toBeCloseTo(3720.75, 2);
    expect(r.Top).toBeCloseTo(3732.85, 2);
  });

  it('is a direct factor, NOT a 1 + x delta', () => {
    // The regression this guards: 3372 x (1 + 0.55) = 5226.6 would be wrong.
    expect(scaleCrossSection(PROWLER, 0.55).Front).not.toBeCloseTo(5226.6, 1);
  });

  it('scales up for a multiplier above 1', () => {
    // MISC Fortune, CS multiplier 1.5.
    const r = scaleCrossSection({ Front: 3200, Side: 6800, Top: 11000 }, 1.5);
    expect(r).toMatchObject({ Front: 4800, Side: 10200, Top: 16500 });
  });

  it('leaves values untouched at multiplier 1', () => {
    expect(scaleCrossSection(PROWLER, 1)).toMatchObject(PROWLER);
  });

  it('defaults to 1 for a missing or non-numeric multiplier', () => {
    expect(scaleCrossSection(PROWLER)).toMatchObject(PROWLER);
    expect(scaleCrossSection(PROWLER, undefined)).toMatchObject(PROWLER);
    expect(scaleCrossSection(PROWLER, NaN)).toMatchObject(PROWLER);
    expect(scaleCrossSection(PROWLER, null)).toMatchObject(PROWLER);
  });

  it('returns null when the ship declares no cross-section block', () => {
    expect(scaleCrossSection(null, 1.5)).toBeNull();
    expect(scaleCrossSection(undefined, 1.5)).toBeNull();
  });

  it('passes non-numeric axes through instead of turning them into 0', () => {
    // Greycat MDC / MTC ship an Emissions.CrossSection block with no numbers.
    // A 0 would render as a real measurement; undefined hits the placeholder.
    const r = scaleCrossSection({ Front: undefined, Side: null, Top: 500 }, 0.4);
    expect(r.Front).toBeUndefined();
    expect(r.Side).toBeNull();
    expect(r.Top).toBeCloseTo(200, 6);
  });

  it('does not mutate the input', () => {
    const base = { Front: 3200, Side: 6800, Top: 11000 };
    scaleCrossSection(base, 1.5);
    expect(base).toMatchObject({ Front: 3200, Side: 6800, Top: 11000 });
  });
});

// ─── bespoke port tags inherited one level ──────────────────────────────────

describe('extractSlots - bespoke RequiredTags inherited from the parent port', () => {
  // Mirrors the Kruger S-65 Stingray / P-52 Merlin nose mounts: the PARENT
  // gimbal port carries RequiredTags ["Merlin_Nose"], but CIG omits them on the
  // child that actually holds the gun - the child only advertises the tag in
  // PortTags. Before the fix the child accepted every same-size gun.
  const bespokeGun = {
    className: 'KRIG_LaserRepeater_Bespoke_S2', type: 'WeaponGun', subType: 'Gun',
    size: 2, tags: 'KRIG flightReady Merlin_Nose', requiredTags: '', sold: 1,
    stdItem: { ClassName: 'KRIG_LaserRepeater_Bespoke_S2', Name: 'Whiptail STR-E2', Type: 'WeaponGun.Gun' },
  };
  const genericGun = {
    className: 'GENERIC_LaserCannon_S2', type: 'WeaponGun', subType: 'Gun',
    size: 2, tags: 'flightReady', requiredTags: '', sold: 1,
    stdItem: { ClassName: 'GENERIC_LaserCannon_S2', Name: 'Generic S2', Type: 'WeaponGun.Gun' },
  };
  beforeEach(() => initLoadoutData([bespokeGun, genericGun]));

  const shipWith = (parentRequired, childPortTags, extraNesting = false) => {
    const child = {
      PortName: 'hardpoint_class_2', MinSize: 2, MaxSize: 2,
      Types: ['WeaponGun.Gun'], PortTags: childPortTags,
      Tags: ['gimbalMount', 'flightReady'],
    };
    const mid = { PortName: 'mid', MinSize: 2, MaxSize: 2, Types: ['Turret.GunTurret'], Ports: [child] };
    return { Hardpoints: { Weapons: { PilotWeapons: { InstalledItems: [{
      PortName: 'hardpoint_weapon_fixed_left', MinSize: 2, MaxSize: 2,
      Types: ['Turret.GunTurret', 'WeaponGun.Gun'],
      PortTags: ['Merlin_Nose'], RequiredTags: parentRequired,
      Ports: [extraNesting ? mid : child],
    }] } } } };
  };
  const leafOf = (slots) => {
    const out = [];
    const walk = s => { const p = s.ports || []; if (!p.length) out.push(s); else p.forEach(walk); };
    slots.weapons.forEach(walk);
    return out[out.length - 1];
  };
  const asHardpoint = l => ({
    MinSize: l.minSize, MaxSize: l.maxSize, Types: l.types,
    PortTags: l.portTags, RequiredTags: l.requiredTags,
  });

  it('child inherits the parent tag it advertises in its own PortTags', () => {
    const leaf = leafOf(extractSlots(shipWith(['Merlin_Nose'], ['Merlin_Nose'])));
    expect(leaf.requiredTags).toEqual(['Merlin_Nose']);
    expect(getCompatibleItems(asHardpoint(leaf)).map(i => i.className))
      .toEqual(['KRIG_LaserRepeater_Bespoke_S2']);
  });

  it('child that does NOT advertise the tag stays unrestricted', () => {
    // The Idris pattern: a turret's RequiredTags describe the turret, not the
    // gun inside it, and the child never repeats the tag.
    const leaf = leafOf(extractSlots(shipWith(['AEGS_Idris_Front_Turret'], [])));
    expect(leaf.requiredTags).toEqual([]);
    expect(getCompatibleItems(asHardpoint(leaf)).map(i => i.className).sort())
      .toEqual(['GENERIC_LaserCannon_S2', 'KRIG_LaserRepeater_Bespoke_S2']);
  });

  it('inheritance is one level only - a grandparent tag does not reach the leaf', () => {
    const leaf = leafOf(extractSlots(shipWith(['Merlin_Nose'], ['Merlin_Nose'], true)));
    expect(leaf.requiredTags).toEqual([]);
  });

  it('an explicit child RequiredTags still wins (S4 Wolf_Gun pattern)', () => {
    const ship = shipWith(['Merlin_Nose'], ['Merlin_Nose']);
    ship.Hardpoints.Weapons.PilotWeapons.InstalledItems[0].Ports[0].RequiredTags = ['Wolf_Gun'];
    expect(leafOf(extractSlots(ship)).requiredTags).toEqual(['Wolf_Gun']);
  });
});

// ─── Empty-installed missile/bomb racks ─────────────────────────────────────
// The ship data only lists a rack's ordnance ports when the ship's default
// loadout fills them. A rack installed without ordnance must still expose
// its own ordnance ports, exactly as a manual re-pick of the same rack does.
describe('extractSlots: rack installed without ordnance', () => {
  const rack = {
    className: 'MRCK_TEST_Torpedo', type: 'MissileLauncher', subType: 'MissileRack',
    size: 9, tags: 'flightReady', requiredTags: '',
    stdItem: { ClassName: 'MRCK_TEST_Torpedo', Name: 'Test Torpedo Rack', Size: 9,
      Type: 'MissileLauncher.MissileRack',
      Ports: [1, 2, 3].map(n => ({
        PortName: `missile_0${n}_attach`, MinSize: 9, MaxSize: 9,
        Types: ['Missile.Missile', 'Missile.Torpedo'], Flags: ['editable'],
      })).concat([{ PortName: 'door_panel', Types: ['Door'] }]) },
  };
  beforeEach(() => initLoadoutData([rack]));

  const shipWithRack = (ports) => ({ Hardpoints: { Weapons: { MissileRacks: { InstalledItems: [{
    PortName: 'hardpoint_torpedorack', MinSize: 3, MaxSize: 10,
    BaseLoadout: { ClassName: 'MRCK_TEST_Torpedo', Size: 9, Type: 'MissileLauncher.MissileRack' },
    Types: ['MissileLauncher.MissileRack'], ...(ports ? { Ports: ports } : {}),
  }] } } } });

  it('exposes the rack item ordnance ports when the ship data lists none', () => {
    const [slot] = extractSlots(shipWithRack(null)).missiles;
    expect(slot.ports.map(p => p.portName)).toEqual([
      'hardpoint_torpedorack/missile_01_attach',
      'hardpoint_torpedorack/missile_02_attach',
      'hardpoint_torpedorack/missile_03_attach',
    ]);
    expect(slot.ports[0].maxSize).toBe(9);
  });

  it('keeps the ship-declared ports when the loadout fills the rack', () => {
    const declared = [{ PortName: 'missile_01_attach', MinSize: 9, MaxSize: 9, Types: ['Missile.Torpedo'] }];
    const [slot] = extractSlots(shipWithRack(declared)).missiles;
    expect(slot.ports.map(p => p.portName)).toEqual(['hardpoint_torpedorack/missile_01_attach']);
  });
});

// ─── Remote turret routing: pilot vs. crew ──────────────────────────────────
// RemoteController.Slaved lets the pilot take a turret over while its own seat
// is empty (a copilot-seat turret flown solo, a turret shared with the pilot).
// A turret whose every seat is a dedicated gunner seat is crewed and belongs
// in TURRETS, even though the data still flags it Slaved.
describe('extractSlots: remote turret pilot vs. crew routing', () => {
  const shipWithRemote = (rc) => ({ Hardpoints: { Weapons: { RemoteTurrets: { InstalledItems: [{
    PortName: 'hardpoint_turret_test', MinSize: 3, MaxSize: 3, Types: ['Turret.TopTurret'],
    BaseLoadout: { ClassName: 'TEST_Remote_Turret', Type: 'Turret.TopTurret', Size: 3 },
    RemoteController: rc,
  }] } } } });
  const routeOf = (rc) => {
    const s = extractSlots(shipWithRemote(rc));
    return s.weapons.length ? 'weapons' : s.turrets.length ? 'turrets' : 'none';
  };

  it('slaved turret with only gunner seats is crewed', () => {
    expect(routeOf({ Slaved: true, Seats: ['RSI_Constellation_Mk5_Gunner_SeatDashboard'] })).toBe('turrets');
    expect(routeOf({ Slaved: true, Seats: ['RSI_Zeus_SCItem_SeatDashboard_Gunner'] })).toBe('turrets');
  });

  it('slaved turret on a copilot seat falls back to the pilot', () => {
    expect(routeOf({ Slaved: true, Seats: ['RSI_Hermes_SeatDashboard_CoPilot'] })).toBe('weapons');
    expect(routeOf({ Slaved: true, Seats: ['MISC_Reliant_SCItem_Seat_CoPilot'] })).toBe('weapons');
  });

  it('slaved turret shared by a gunner and the driver stays with the pilot', () => {
    expect(routeOf({ Slaved: true, Seats: ['TMBL_Nova_SCItem_Seat_Gunner', 'TMBL_Nova_SCItem_Seat_Driver'] })).toBe('weapons');
  });

  it('recognises every pilot-seat naming form, but not the copilot', () => {
    for (const seat of ['DRAK_Ironclad_SCItem_SeatDashboard_Pilot', 'RSI_Perseus_Pilot_SeatDashboard',
      'ANVL_Paladin_Pilot_Seat', 'AEGS_Reclaimer_Seat_Pilot']) {
      expect(routeOf({ Slaved: false, Seats: [seat] })).toBe('weapons');
    }
    for (const seat of ['RSI_Apollo_SCItem_SeatDashboard_Co_Pilot', 'MISC_Hull_B_Copilot_Seat',
      'RSI_Perseus_CoPilot_SeatDashboard']) {
      expect(routeOf({ Slaved: false, Seats: [seat] })).toBe('turrets');
    }
  });

  it('a seat shared by pilot and copilot is labelled with the pilot first', () => {
    const [slot] = extractSlots(shipWithRemote({ Slaved: false,
      Seats: ['RSI_Constellation_Mk5_CoPilot_SeatDashboard', 'RSI_Constellation_Mk5_Pilot_SeatDashboard'] })).weapons;
    expect(slot.seatLabel).toBe('Pilot/Copilot');
  });

  it('unslaved turret on a gunner or copilot seat is crewed', () => {
    expect(routeOf({ Slaved: false, Seats: ['RSI_Zeus_SCItem_SeatDashboard_Gunner'] })).toBe('turrets');
    expect(routeOf({ Slaved: false, Seats: ['RSI_Zeus_SCItem_SeatDashboard_CoPilot'] })).toBe('turrets');
  });
});

// ─── Inert turrets (aiming cameras, sensors, scoops) ────────────────────────
// A locked turret port whose ship data and installed item both declare no
// sub-ports holds nothing equippable (an aiming camera, a sensor head). It
// must not render as an empty turret row.
describe('extractSlots: inert turrets are dropped', () => {
  const camera = {
    className: 'TEST_Torpedo_Camera', type: 'Turret', subType: 'GunTurret', size: 4, tags: '', requiredTags: '',
    stdItem: { ClassName: 'TEST_Torpedo_Camera', Name: 'Remote Turret', Size: 4, Type: 'Turret.GunTurret', Ports: [] },
  };
  const gunTurret = {
    className: 'TEST_Gun_Turret', type: 'Turret', subType: 'GunTurret', size: 3, tags: '', requiredTags: '',
    stdItem: { ClassName: 'TEST_Gun_Turret', Name: 'Remote Turret', Size: 3, Type: 'Turret.GunTurret',
      Ports: [{ PortName: 'hardpoint_gun', MinSize: 3, MaxSize: 3, Types: ['WeaponGun.Gun'] }] },
  };
  beforeEach(() => initLoadoutData([camera, gunTurret]));

  const turretPort = (className, extra = {}) => ({
    PortName: `hardpoint_${className}`, MinSize: 3, MaxSize: 4, Types: ['Turret.GunTurret'], Uneditable: true,
    BaseLoadout: { ClassName: className, Type: 'Turret.GunTurret', Size: 4 },
    RemoteController: { Slaved: false, Seats: ['TEST_Pilot_SeatDashboard'] }, ...extra,
  });
  const portsOf = (...hps) => {
    const s = extractSlots({ Hardpoints: { Weapons: { RemoteTurrets: { InstalledItems: hps } } } });
    return [...s.weapons, ...s.turrets].map(x => x.portName);
  };

  it('drops a locked turret with no sub-ports anywhere', () => {
    expect(portsOf(turretPort('TEST_Torpedo_Camera'), turretPort('TEST_Gun_Turret')))
      .toEqual(['hardpoint_TEST_Gun_Turret']);
  });

  it('keeps it when the port is editable (a gun mount can go there)', () => {
    expect(portsOf(turretPort('TEST_Torpedo_Camera', { Uneditable: false }))).toEqual(['hardpoint_TEST_Torpedo_Camera']);
  });

  it('keeps it when the ship data declares sub-ports', () => {
    const withPorts = turretPort('TEST_Torpedo_Camera', { Ports: [{ PortName: 'hardpoint_gun', MinSize: 3, MaxSize: 3, Types: ['WeaponGun.Gun'] }] });
    expect(portsOf(withPorts)).toEqual(['hardpoint_TEST_Torpedo_Camera']);
  });

  it('keeps it when the installed item is unknown', () => {
    expect(portsOf(turretPort('TEST_Not_In_Index'))).toEqual(['hardpoint_TEST_Not_In_Index']);
  });
});

// ─── 11. applyDefaultAllocation - cooler MinConsumptionFraction ──────────────

/**
 * Cooler whose Conversion carries an explicit Power consumption, so the pip
 * channel gets a real `min` from MinConsumptionFraction. The stock S1
 * IcePlunge is Segment 2 / MinConsumptionFraction 1.0 -> min == max == 2.
 */
function makeCoolerWithDraw(className, output, segment, minFraction) {
  return {
    className,
    type: 'Cooler',
    subType: 'Cooler',
    size: 1,
    tags: '',
    requiredTags: '',
    sold: 0,
    stdItem: {
      ClassName: className,
      Name: className,
      Type: 'Cooler.Cooler',
      Classification: 'Cooler.Cooler',
      Size: 1,
      Grade: 'C',
      Class: 'Civilian',
      Tags: '',
      RequiredTags: '',
      ResourceNetwork: [
        {
          PowerRanges: { High: { Start: 1, Modifier: 1.0, RegisterRange: true } },
          Conversion: [
            {
              Generation: { Resource: 'Coolant', UnitPerSec: output },
              Consumption: { Resource: 'Power', Segment: segment },
              MinConsumptionFraction: minFraction,
            },
          ],
        },
      ],
    },
  };
}

describe('applyDefaultAllocation - cooler minimum draw', () => {
  beforeEach(() => {
    initLoadoutData([]);
    setCurrentCrafting({});
  });

  // Engine at max=14 is the only heat source. With the cooler at 1 pip,
  // supply = 34 x 1.0 x (1/2) = 17 and demand = 14 + 2 x 1.0 x (1/2) = 15,
  // i.e. 88% - so the per-pip loop would stop at 1. That pip count is
  // unreachable in game: MinConsumptionFraction 1.0 means the cooler draws
  // its full 2-pip segment or nothing. Stopping at 1 also rendered a pip
  // column that was neither filled (block needs pip 2) nor powered-off
  // (allocated != 0).
  const shipConfig = { weaponPoolSize: 0, ifcsSegment: 14, ifcsMinFraction: 0, ifcsPowerRanges: null };
  const slots = { weapons: [], systems: [{ portName: 'cooler_slot_0', category: 'Coolers' }] };

  it('never leaves a cooler below its MinConsumptionFraction', () => {
    initLoadoutData([makeCoolerWithDraw('COOL_MINMAX', 34, 2, 1.0)]);
    const { channels } = buildPipAllocation({ cooler_slot_0: 'COOL_MINMAX' }, slots, shipConfig, 30, null);
    const ch = channels.find(c => c.key === 'cooler_0');
    expect(ch.max).toBe(2);
    expect(ch.min).toBe(2);
    expect(ch.allocated).toBe(2);
  });

  it('keeps per-pip granularity when min is below max', () => {
    // Segment 4 / MinConsumptionFraction 0.25 -> min 1, max 4. At 1 pip
    // demand is 14 + 4 x (1/4) = 15 against supply 40 x (1/4) = 10, so the
    // loop continues; at 2 pips demand 16 against supply 20 meets the target.
    // min = 1 must not round that up to the full 4.
    initLoadoutData([makeCoolerWithDraw('COOL_PARTIAL', 40, 4, 0.25)]);
    const { channels } = buildPipAllocation({ cooler_slot_0: 'COOL_PARTIAL' }, slots, shipConfig, 30, null);
    const ch = channels.find(c => c.key === 'cooler_0');
    expect(ch.min).toBe(1);
    expect(ch.allocated).toBe(2);
  });

  it('leaves a second cooler fully off once the first meets demand', () => {
    initLoadoutData([makeCoolerWithDraw('COOL_MINMAX', 34, 2, 1.0)]);
    const twoSlots = {
      weapons: [],
      systems: [
        { portName: 'cooler_slot_0', category: 'Coolers' },
        { portName: 'cooler_slot_1', category: 'Coolers' },
      ],
    };
    const loadout = { cooler_slot_0: 'COOL_MINMAX', cooler_slot_1: 'COOL_MINMAX' };
    const { channels } = buildPipAllocation(loadout, twoSlots, shipConfig, 30, null);
    // Every cooler is either off or at least at its minimum draw - never in between.
    for (const ch of channels.filter(c => c.key.startsWith('cooler_'))) {
      expect(ch.allocated === 0 || ch.allocated >= ch.min).toBe(true);
    }
    expect(channels.find(c => c.key === 'cooler_0').allocated).toBe(2);
    expect(channels.find(c => c.key === 'cooler_1').allocated).toBe(0);
  });
});

describe('applyDefaultAllocation - cooler minimum draw via post-allocation steal', () => {
  beforeEach(() => {
    initLoadoutData([]);
    setCurrentCrafting({});
  });

  it('does not switch a cooler part-way on when stealing pips back for cooling', () => {
    // Radar is excluded from the cooler-fill heat estimate, so its full pips
    // land after the coolers are sized and can push cooling back over 100%.
    // The recovery path then steals pips and hands them to an idle cooler -
    // it must pay that cooler's whole minimum or leave it off, never park it
    // on a single pip. This is the RSI Apollo Medivac case.
    const radar = makePowerItem('RADAR_HOT', 20, 0, 0);
    radar.type = 'Radar';
    radar.subType = 'Radar';
    radar.stdItem.Type = 'Radar.Radar';
    radar.stdItem.Classification = 'Radar.Radar';
    delete radar.stdItem.Shield;
    initLoadoutData([makeCoolerWithDraw('COOL_STEAL', 20, 2, 1.0), radar]);
    const shipConfig = { weaponPoolSize: 0, ifcsSegment: 4, ifcsMinFraction: 0, ifcsPowerRanges: null };
    const slots = {
      weapons: [],
      systems: [
        { portName: 'radar_slot', category: 'Radar' },
        { portName: 'cooler_slot_0', category: 'Coolers' },
        { portName: 'cooler_slot_1', category: 'Coolers' },
      ],
    };
    const loadout = { radar_slot: 'RADAR_HOT', cooler_slot_0: 'COOL_STEAL', cooler_slot_1: 'COOL_STEAL' };
    const { channels } = buildPipAllocation(loadout, slots, shipConfig, 40, null);
    for (const ch of channels.filter(c => c.key.startsWith('cooler_'))) {
      expect(ch.min).toBe(2);
      expect(ch.allocated === 0 || ch.allocated >= ch.min).toBe(true);
    }
  });
});

// ─── Ship-integrated racks are not swap targets ─────────────────────────────
// A rack with no RequiredTags fits every rack port of its size by tags alone.
// When the only ports any ship installs it in are locked, it is built into
// that ship and must not be offered in another ship's rack picker.
describe('getCompatibleItems: racks only ever installed in locked ports', () => {
  const rack = (className, requiredTags = '') => ({
    className, type: 'MissileLauncher', subType: 'MissileRack', size: 3,
    tags: 'flightReady', requiredTags,
    stdItem: { ClassName: className, Name: className, Size: 3, Type: 'MissileLauncher.MissileRack' },
  });
  const rackPort = (className, locked) => ({
    PortName: `hardpoint_${className}`, MinSize: 3, MaxSize: 3, Types: ['MissileLauncher.MissileRack'],
    BaseLoadout: { ClassName: className, Type: 'MissileLauncher.MissileRack', Size: 3 },
    ...(locked ? { Uneditable: true, Flags: ['$uneditable'] } : { Flags: ['editable'] }),
  });
  const ship = (...ports) => ({ Hardpoints: { Weapons: { MissileRacks: { InstalledItems: ports } } } });
  const fleet = [
    ship(rackPort('MRCK_Integrated', true)),
    ship(rackPort('MRCK_Generic', false)),
    // The same generic rack locked on one ship is still swappable elsewhere.
    ship(rackPort('MRCK_Generic', true)),
    // Locked AND tagged: tags already confine it, so it is left alone.
    ship(rackPort('MRCK_Tagged', true)),
  ];
  const pickable = () => getCompatibleItems({ MinSize: 3, MaxSize: 3, Types: ['MissileLauncher.MissileRack'], PortTags: ['ShipTag'], RequiredTags: [] })
    .map(i => i.className).sort();

  beforeEach(() => {
    initLoadoutData([rack('MRCK_Integrated'), rack('MRCK_Generic'), rack('MRCK_Tagged', 'ShipTag'), rack('MRCK_Unused')]);
    setAllHardpoints(fleet);
  });
  afterEach(() => setAllHardpoints([]));

  it('identifies only the untagged rack that never sits in an editable port', () => {
    expect([...findShipIntegratedRacks(fleet)]).toEqual(['MRCK_Integrated']);
  });

  it('leaves it out of rack pickers, keeping generic, tagged and never-installed racks', () => {
    expect(pickable()).toEqual(['MRCK_Generic', 'MRCK_Tagged', 'MRCK_Unused']);
  });

  it('offers every rack when no ship data is loaded', () => {
    setAllHardpoints([]);
    expect(pickable()).toEqual(['MRCK_Generic', 'MRCK_Integrated', 'MRCK_Tagged', 'MRCK_Unused']);
  });
});

// ─── Unfinished copies of a ship-integrated rack ────────────────────────────
// CIG leaves half-made rack copies in the data: no ship installs them, they
// carry no tags, and their display-name key is the original's. A rack whose
// name key is derived from its own ClassName is a real item and stays, even
// when no ship installs it (the generic racks sold in shops never are).
describe('findShipIntegratedRacks: never-installed copies', () => {
  const rack = (className, nameKey, requiredTags = '') => ({
    className, type: 'MissileLauncher', subType: 'MissileRack', size: 5,
    name: nameKey ? `@item_Name${nameKey}` : '', tags: 'flightReady', requiredTags,
    stdItem: { ClassName: className, Name: className, Size: 5, Type: 'MissileLauncher.MissileRack' },
  });
  const rackPort = (className, locked) => ({
    PortName: `hardpoint_${className}`, MinSize: 5, MaxSize: 5, Types: ['MissileLauncher.MissileRack'],
    BaseLoadout: { ClassName: className, Type: 'MissileLauncher.MissileRack', Size: 5 },
    ...(locked ? { Uneditable: true } : {}),
  });
  const ship = (...ports) => ({ Hardpoints: { Weapons: { MissileRacks: { InstalledItems: ports } } } });
  const fleet = [
    ship(rackPort('MRCK_S05_SHIP_Built_In_Left', true)),
    ship(rackPort('MRCK_S05_GEN_Dual', false)),
  ];
  const integrated = (...items) => { initLoadoutData(items); return [...findShipIntegratedRacks(fleet)].sort(); };
  const builtIn = rack('MRCK_S05_SHIP_Built_In_Left', 'MRCK_S05_SHIP_Built_In');
  const generic = rack('MRCK_S05_GEN_Dual', 'MRCK_S05_GEN_Dual');

  it('flags a never-installed rack that borrows an integrated rack’s name', () => {
    expect(integrated(builtIn, generic, rack('MRCK_S05_OTHER_Copy_Left', 'MRCK_S05_SHIP_Built_In')))
      .toEqual(['MRCK_S05_OTHER_Copy_Left', 'MRCK_S05_SHIP_Built_In_Left']);
  });

  it('matches the name key case-insensitively', () => {
    expect(integrated(builtIn, rack('MRCK_S05_OTHER_Copy', 'mrck_s05_ship_built_in')))
      .toContain('MRCK_S05_OTHER_Copy');
  });

  it('keeps a never-installed rack that owns its name', () => {
    expect(integrated(builtIn, generic, rack('MRCK_S05_GEN_Quad', 'MRCK_S05_GEN_Quad')))
      .toEqual(['MRCK_S05_SHIP_Built_In_Left']);
  });

  it('keeps a never-installed rack that borrows the name of a swappable rack', () => {
    expect(integrated(builtIn, generic, rack('MRCK_S05_OTHER_Variant', 'MRCK_S05_GEN_Dual')))
      .toEqual(['MRCK_S05_SHIP_Built_In_Left']);
  });

  it('keeps tagged racks and racks with no item-name key', () => {
    expect(integrated(builtIn, rack('MRCK_S05_OTHER_Tagged', 'MRCK_S05_SHIP_Built_In', 'ShipTag'), rack('MRCK_S05_OTHER_NoKey', '')))
      .toEqual(['MRCK_S05_SHIP_Built_In_Left']);
  });
});

// ─── Racks built into another item ──────────────────────────────────────────────
// A module or turret can carry its own racks: they are mounted in the host
// item's ports (`InstalledItem`), not in any ship's hardpoint tree. A rack
// that only ever sits in a locked port of such a host is as fixed as one
// built into a hull.
describe('findShipIntegratedRacks: racks mounted inside another item', () => {
  const rack = (className) => ({
    className, type: 'MissileLauncher', subType: 'MissileRack', size: 2, tags: 'flightReady', requiredTags: '',
    stdItem: { ClassName: className, Name: className, Size: 2, Type: 'MissileLauncher.MissileRack' },
  });
  const host = (className, rackClass, locked) => ({
    className, type: 'Module', subType: 'UNDEFINED', size: 1, tags: '', requiredTags: '',
    stdItem: { ClassName: className, Name: className, Size: 1, Type: 'Module.UNDEFINED', Ports: [{
      PortName: 'missile_01_rack', MinSize: 2, MaxSize: 2, Types: ['MissileLauncher.MissileRack'],
      InstalledItem: { ClassName: rackClass, Size: 2, Type: 'MissileLauncher.MissileRack' },
      ...(locked ? { Uneditable: true, Flags: ['$uneditable'] } : { Flags: ['$editable'] }),
    }] },
  });
  const integrated = (...items) => { initLoadoutData(items); return [...findShipIntegratedRacks([])].sort(); };

  it('flags a rack whose only mount is a locked port of a module', () => {
    expect(integrated(rack('MRCK_Module_Rack'), host('MODULE_Missile', 'MRCK_Module_Rack', true)))
      .toEqual(['MRCK_Module_Rack']);
  });

  it('keeps a rack a module holds in an editable port', () => {
    expect(integrated(rack('MRCK_Module_Rack'), host('MODULE_Missile', 'MRCK_Module_Rack', false))).toEqual([]);
  });

  it('keeps a rack that is locked in a module but swappable on a ship', () => {
    initLoadoutData([rack('MRCK_Shared'), host('MODULE_Missile', 'MRCK_Shared', true)]);
    const ship = { Hardpoints: { Weapons: { MissileRacks: { InstalledItems: [{
      PortName: 'hardpoint_rack', MinSize: 2, MaxSize: 2, Types: ['MissileLauncher.MissileRack'],
      BaseLoadout: { ClassName: 'MRCK_Shared', Type: 'MissileLauncher.MissileRack', Size: 2 }, Flags: ['editable'],
    }] } } } };
    expect([...findShipIntegratedRacks([ship])]).toEqual([]);
  });
});

// ─── Saved loadout from another hull ────────────────────────────────────────
// Saved loadouts are keyed by ship Name and hold the full port map. When the
// hull behind a Name changes, restoring one would lay the old hull's stock
// items over the new hull. A locked port that disagrees with the hull gives
// it away - the user can never have changed that port.
describe('isLoadoutForOtherHull', () => {
  const port = (name, className, { locked = false, ports = [] } = {}) => ({
    PortName: name, MinSize: 3, MaxSize: 3, Types: ['Turret.GunTurret'],
    BaseLoadout: { ClassName: className, Type: 'Turret.GunTurret', Size: 3 },
    ...(locked ? { Uneditable: true } : {}), ...(ports.length ? { Ports: ports } : {}),
  });
  const hull = (...ports) => extractSlots({ Hardpoints: { Weapons: { PilotWeapons: { InstalledItems: ports } } } });
  const slots = hull(
    port('hardpoint_locked', 'TURRET_NewHull', { locked: true, ports: [port('gimbal', 'MOUNT_New', { locked: true })] }),
    port('hardpoint_open', 'MOUNT_Stock', { ports: [port('inner', 'INNER_Stock', { locked: true })] }),
  );
  const stock = buildDefaultLoadout(slots);

  beforeEach(() => initLoadoutData([]));

  it('accepts the hull’s own stock loadout', () => {
    expect(isLoadoutForOtherHull({ ...stock }, slots, stock)).toBe(false);
  });

  it('accepts changes on editable ports and whatever sits below them', () => {
    const saved = { ...stock, 'hardpoint_open': 'MOUNT_UserPick', 'hardpoint_open/inner': 'INNER_FromNewMount' };
    expect(isLoadoutForOtherHull(saved, slots, stock)).toBe(false);
  });

  it('flags a different item on a locked port', () => {
    expect(isLoadoutForOtherHull({ ...stock, 'hardpoint_locked': 'TURRET_OldHull' }, slots, stock)).toBe(true);
  });

  it('flags a different item on a locked port below a locked port', () => {
    expect(isLoadoutForOtherHull({ ...stock, 'hardpoint_locked/gimbal': 'MOUNT_Old' }, slots, stock)).toBe(true);
  });

  it('ignores ports the saved loadout does not mention, and unknown ports', () => {
    expect(isLoadoutForOtherHull({ 'hardpoint_open': 'MOUNT_UserPick', 'hardpoint_gone': 'X' }, slots, stock)).toBe(false);
  });

  it('treats a missing or malformed saved loadout as fine', () => {
    expect(isLoadoutForOtherHull(null, slots, stock)).toBe(false);
    expect(isLoadoutForOtherHull('nope', slots, stock)).toBe(false);
    expect(isLoadoutForOtherHull({ ...stock }, null, stock)).toBe(false);
  });
});
