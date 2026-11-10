/**
 * Tests for tierEngine.js pure functions.
 *
 * Focus areas:
 *  1. categorize - weapon type bucketing
 *  2. computeDeflectionLadder - anchor ships to per-damage-type thresholds
 *  3. computeTiers - sets _tier on weapon records from the ladder
 *  4. getImmuneShips - which ships are immune to a given weapon
 *  5. deriveTier - single-weapon tier re-derivation (used for crafted-weapon recompute)
 *  6. tierRank / TIER_META - ladder ordering and display metadata
 */

import { describe, it, expect, vi } from 'vitest';
import {
  categorize, computeDeflectionLadder, computeTiers, getImmuneShips, deriveTier,
  tierRank, TIER_META, TOP_TIER, CLEARS_FIGHTERS_TIER
} from '../js/tierEngine.js';

// ─── Minimal fixture helpers ─────────────────────────────────────────────────

/** Minimal ship record for tier tests. */
function makeShip(name, physDefl, energyDefl) {
  return {
    Name: name,
    'Deflection physical': physDefl,
    'Deflection energy': energyDefl,
  };
}

/**
 * Roster carrying every anchor named in DEFLECTION_BANDS, at its Live 4.9.0
 * deflection, plus the Idris (no anchor - the Capital band reads the global
 * max instead). Deliberately real values so the fixture doubles as a record of
 * what the shipped ladder looks like.
 */
const ROSTER = [
  makeShip('Anvil Arrow', 12, 6),
  makeShip('Esperia Talon', 8, 10),
  makeShip('Anvil F7C Hornet Mk II', 24, 13),
  makeShip('MISC Hull A', 18, 19),
  makeShip('Anvil F8A Lightning', 54, 29),
  makeShip('MISC Freelancer', 41, 43),
  makeShip('Aegis Redeemer', 116, 110),
  // Not anchors: they sit above the Gunship ceiling, in the Heavy Gunship
  // band. Present so the fixture exercises non-anchor ships inside a band.
  makeShip('Anvil Asgard', 139, 88),
  makeShip('RSI Apollo Medivac', 121, 116),
  makeShip('Anvil Carrack', 420, 240),
  makeShip('MISC Starlancer TAC', 347, 396),
  makeShip('Aegis Hammerhead', 531, 380),
  makeShip('Aegis Reclaimer', 495, 418),
  makeShip('Aegis Idris-P', 554, 485),
];

/** Minimal weapon record with Alpha damage. Type string drives categorize(). */
function makeWeapon(type, alpha) {
  return { Type: type, Alpha: alpha };
}

/** Weapon with PerPellet instead of Alpha (scattergun). */
function makeScatterWeapon(type, perPellet) {
  return { Type: type, PerPellet: perPellet };
}

/** Beam weapon (no alpha, uses Sustained). */
function makeBeamWeapon(type, sustained) {
  return { Type: type, Alpha: 0, Sustained: sustained };
}

/** Tier of a single weapon against the standard roster. */
function tierOf(type, alpha) {
  const w = makeWeapon(type, alpha);
  computeTiers([w], ROSTER);
  return w._tier;
}

// ─── 1. categorize ───────────────────────────────────────────────────────────

describe('categorize', () => {
  it('classifies ballistic types', () => {
    expect(categorize('Ballistic Cannon')).toBe('Ballistic');
    expect(categorize('Mass Driver')).toBe('Ballistic');
    // Underscore-separated 'MASS_DRIVER' returns 'Other' (\s* doesn't match _).
    // Verified harmless against Live 4.8.3: the underscore form appears nowhere
    // in the game data (only "Mass Driver"/"MassDriver"/"mass driver"), and the
    // tierEngine call site receives deriveType() output which normalizes mass
    // drivers to the literal 'Ballistic Cannon' via WEAPON_TYPE_MAP anyway.
    expect(categorize('MASS_DRIVER')).toBe('Other');
    expect(categorize('ballistic repeater')).toBe('Ballistic');
  });

  it('classifies energy types', () => {
    expect(categorize('Laser Repeater')).toBe('Energy');
    expect(categorize('Plasma Cannon')).toBe('Energy');
    expect(categorize('Tachyon Cannon')).toBe('Energy');
    expect(categorize('Neutron Cannon')).toBe('Energy');
  });

  it('classifies distortion types', () => {
    expect(categorize('Distortion Cannon')).toBe('Distortion');
    expect(categorize('distortion repeater')).toBe('Distortion');
  });

  it('falls through to Other for unrecognised types', () => {
    expect(categorize('Mystery Weapon')).toBe('Other');
    expect(categorize('')).toBe('Other');
    expect(categorize('Rocket')).toBe('Other');
  });
});

// ─── 2. computeDeflectionLadder ──────────────────────────────────────────────

describe('computeDeflectionLadder', () => {
  it('derives both thresholds per band from the anchor ships', () => {
    const ladder = computeDeflectionLadder(ROSTER);
    expect(ladder.map(b => [b.key, b.physical, b.energy])).toEqual([
      ['lf', 12, 10],
      ['mf', 24, 19],
      ['hf', 54, 43],
      ['gs', 116, 110],
      ['hg', 420, 396],
      ['sc', 531, 418],
      ['cp', 554, 485],
    ]);
  });

  it('reads the top band from the global max, not from an anchor', () => {
    // The Idris is named by no band. Adding a tougher hull must still raise
    // the Capital ceiling, otherwise a weapon would claim to beat everything.
    const ladder = computeDeflectionLadder([...ROSTER, makeShip('Aegis Javelin', 900, 800)]);
    const top = ladder[ladder.length - 1];
    expect(top.key).toBe(TOP_TIER);
    expect([top.physical, top.energy]).toEqual([900, 800]);
  });

  it('keeps thresholds monotonic where the anchors disagree between types', () => {
    // Hammerhead out-deflects Reclaimer on physical (531 vs 495) but loses on
    // energy (380 vs 418), and Starlancer TAC's 396 energy sits above both the
    // Carrack's 240 and the Hammerhead's 380. The running max keeps every
    // ladder step non-decreasing regardless.
    const ladder = computeDeflectionLadder(ROSTER);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].physical).toBeGreaterThanOrEqual(ladder[i - 1].physical);
      expect(ladder[i].energy).toBeGreaterThanOrEqual(ladder[i - 1].energy);
    }
  });

  it('warns and falls back to the surviving anchors when one goes missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withoutCarrack = ROSTER.filter(s => s.Name !== 'Anvil Carrack');
    const ladder = computeDeflectionLadder(withoutCarrack);
    const hg = ladder.find(b => b.key === 'hg');
    const gs = ladder.find(b => b.key === 'gs');
    // The band's other anchor (Starlancer TAC 347/396) still counts, so the
    // ceiling drops from 420 to 347 rather than collapsing onto 'gs'. Losing
    // an anchor makes the band too EASY, which is why the warning matters -
    // it is the signal to re-verify DEFLECTION_BANDS after a data refresh.
    expect(hg.physical).toBe(347);
    expect(hg.energy).toBe(396);
    expect(hg.physical).toBeGreaterThanOrEqual(gs.physical);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Anvil Carrack'));
    warn.mockRestore();
  });

  it('never lets a band with no surviving anchors undercut the one below', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noGunships = ROSTER.filter(s => s.Name !== 'Aegis Redeemer');
    const ladder = computeDeflectionLadder(noGunships);
    const gs = ladder.find(b => b.key === 'gs');
    const hf = ladder.find(b => b.key === 'hf');
    // Its only anchor gone: the running max holds the ceiling at the 'hf'
    // level, so 'gs' becomes unreachable instead of free.
    expect([gs.physical, gs.energy]).toEqual([hf.physical, hf.energy]);
    warn.mockRestore();
  });

  it('does not throw on an empty ship list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => computeDeflectionLadder([])).not.toThrow();
    expect(computeDeflectionLadder([]).every(b => b.physical === 0 && b.energy === 0)).toBe(true);
    warn.mockRestore();
  });
});

// ─── 3. computeTiers ─────────────────────────────────────────────────────────

describe('computeTiers', () => {
  it('sets _category on each weapon', () => {
    const w = makeWeapon('Ballistic Cannon', 50);
    computeTiers([w], ROSTER);
    expect(w._category).toBe('Ballistic');
  });

  it('places ballistic weapons on the physical ladder', () => {
    expect(tierOf('Ballistic Cannon', 11)).toBe('none');
    expect(tierOf('Ballistic Cannon', 12)).toBe('lf');
    expect(tierOf('Ballistic Cannon', 24)).toBe('mf');
    expect(tierOf('Ballistic Cannon', 54)).toBe('hf');
    expect(tierOf('Ballistic Cannon', 116)).toBe('gs');
    // A non-anchor ship above its band's ceiling does not create a step: the
    // Asgard's 139 is inside the Heavy Gunship band, not a threshold of its own.
    expect(tierOf('Ballistic Cannon', 139)).toBe('gs');
    expect(tierOf('Ballistic Cannon', 420)).toBe('hg');
    expect(tierOf('Ballistic Cannon', 531)).toBe('sc');
    expect(tierOf('Ballistic Cannon', 554)).toBe('cp');
  });

  it('places energy weapons on the energy ladder', () => {
    expect(tierOf('Laser Cannon', 9)).toBe('none');
    expect(tierOf('Laser Cannon', 10)).toBe('lf');
    expect(tierOf('Laser Cannon', 19)).toBe('mf');
    expect(tierOf('Laser Cannon', 43)).toBe('hf');
    expect(tierOf('Laser Cannon', 110)).toBe('gs');
    expect(tierOf('Laser Cannon', 396)).toBe('hg');
    expect(tierOf('Laser Cannon', 418)).toBe('sc');
    expect(tierOf('Laser Cannon', 485)).toBe('cp');
  });

  it('rates the same damage differently for ballistic and energy', () => {
    // 396 damage clears Starlancer TAC's energy deflection (top of 'hg') but
    // falls short of the Carrack's 420 physical, so a ballistic gun at the
    // same number only reaches 'gs'. This is the whole reason the ladder is
    // computed per damage type.
    expect(tierOf('Laser Cannon', 396)).toBe('hg');
    expect(tierOf('Ballistic Cannon', 396)).toBe('gs');
  });

  it('one damage short of a threshold stays on the band below', () => {
    expect(tierOf('Ballistic Cannon', 115)).toBe('hf');
    expect(tierOf('Laser Cannon', 109)).toBe('hf');
    expect(tierOf('Ballistic Cannon', 530)).toBe('hg');
    expect(tierOf('Ballistic Cannon', 553)).toBe('sc');
    expect(tierOf('Laser Cannon', 417)).toBe('hg');
  });

  it('distortion/other weapons always reach the top tier (bypass)', () => {
    const dist  = makeWeapon('Distortion Cannon', 1);
    const other = makeWeapon('Mystery Weapon', 1);
    computeTiers([dist, other], ROSTER);
    expect(dist._tier).toBe(TOP_TIER);
    expect(other._tier).toBe(TOP_TIER);
  });

  it('uses PerPellet for scattergun weapons (ignores Alpha)', () => {
    // PerPellet 60 clears the F8A's 54 physical → 'hf', even though the
    // combined Alpha of 600 would have reached 'sc'.
    const w = { Type: 'Ballistic Scattergun', Alpha: 600, PerPellet: 60 };
    computeTiers([w], ROSTER);
    expect(w._tier).toBe('hf');
    expect(makeScatterWeapon('Ballistic Scattergun', 60).PerPellet).toBe(60);
  });

  it('uses Sustained for beam weapons (Alpha=0)', () => {
    const w = makeBeamWeapon('Laser Beam', 485);
    computeTiers([w], ROSTER);
    expect(w._tier).toBe(TOP_TIER);
  });

  it('handles an empty ships list gracefully (all thresholds = 0)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // getDeflectionDamage: Alpha=0 does NOT satisfy (Alpha != null && Alpha > 0),
    // so dmg = w.Sustained = undefined. Then (dmg != null) is false → 'none'.
    // Characterization: a weapon with alpha=0 gets 'none' even with no ships.
    const w = makeWeapon('Ballistic Cannon', 0);
    computeTiers([w], []);
    expect(w._tier).toBe('none');

    // But a weapon with alpha > 0 and no ships reaches the top (0 >= 0).
    const w2 = makeWeapon('Ballistic Cannon', 1);
    computeTiers([w2], []);
    expect(w2._tier).toBe(TOP_TIER);
    warn.mockRestore();
  });

  it('handles empty weapons list gracefully (no mutations)', () => {
    expect(() => computeTiers([], ROSTER)).not.toThrow();
  });
});

// ─── 4. getImmuneShips ───────────────────────────────────────────────────────

describe('getImmuneShips', () => {
  const fighter   = makeShip('Gladius', 80, 60);
  const freighter = makeShip('Hull C', 300, 200);

  it('returns bypass=true for distortion weapons (no immune ships)', () => {
    const w = { Type: 'Distortion Cannon', Alpha: 1, _category: 'Distortion' };
    const result = getImmuneShips(w, [fighter, freighter]);
    expect(result.bypass).toBe(true);
    expect(result.immune).toHaveLength(0);
  });

  it('returns bypass=true for Other category', () => {
    const w = { Type: 'Mystery', Alpha: 999, _category: 'Other' };
    const result = getImmuneShips(w, [fighter, freighter]);
    expect(result.bypass).toBe(true);
  });

  it('lists ships where physical deflection > weapon alpha', () => {
    const w = { Type: 'Ballistic Cannon', Alpha: 150, _category: 'Ballistic' };
    // fighter phys 80 < 150 → not immune. freighter phys 300 > 150 → immune.
    const { immune, bypass } = getImmuneShips(w, [fighter, freighter]);
    expect(bypass).toBe(false);
    expect(immune).toHaveLength(1);
    expect(immune[0].Name).toBe('Hull C');
  });

  it('lists ships where energy deflection > weapon alpha', () => {
    const w = { Type: 'Laser Cannon', Alpha: 100, _category: 'Energy' };
    // fighter energy 60 < 100 → not immune. freighter energy 200 > 100 → immune.
    const { immune } = getImmuneShips(w, [fighter, freighter]);
    expect(immune).toHaveLength(1);
    expect(immune[0].Name).toBe('Hull C');
  });

  it('returns empty immune list when weapon penetrates all ships', () => {
    const w = { Type: 'Ballistic Cannon', Alpha: 500, _category: 'Ballistic' };
    const { immune } = getImmuneShips(w, [fighter, freighter]);
    expect(immune).toHaveLength(0);
  });

  it('uses PerPellet damage when present', () => {
    // PerPellet 50 < freighter phys 300, and < fighter phys 80 → both immune
    const w = { Type: 'Ballistic Scattergun', Alpha: 999, PerPellet: 50, _category: 'Ballistic' };
    const { immune } = getImmuneShips(w, [fighter, freighter]);
    expect(immune).toHaveLength(2);
  });

  it('skips ships with null/NaN deflection values', () => {
    const badShip = { Name: 'Unknown', 'Deflection physical': null, 'Deflection energy': null };
    const w = { Type: 'Ballistic Cannon', Alpha: 10, _category: 'Ballistic' };
    // badShip has null deflection - the filter checks !isNaN(def), so null is excluded from immune
    const { immune } = getImmuneShips(w, [badShip]);
    expect(immune).toHaveLength(0);
  });

  it('sorts ballistic results by physical deflection, toughest first', () => {
    const roster = [
      makeShip('Soft', 60, 300),
      makeShip('Hard', 300, 60),
      makeShip('Middle', 150, 150),
    ];
    const w = { Type: 'Ballistic Cannon', Alpha: 10, _category: 'Ballistic' };
    expect(getImmuneShips(w, roster).immune.map(s => s.Name)).toEqual(['Hard', 'Middle', 'Soft']);
  });

  it('sorts energy results by energy deflection, toughest first', () => {
    // Same roster, opposite order - the sort key follows the damage type.
    const roster = [
      makeShip('Soft', 60, 300),
      makeShip('Hard', 300, 60),
      makeShip('Middle', 150, 150),
    ];
    const w = { Type: 'Laser Cannon', Alpha: 10, _category: 'Energy' };
    expect(getImmuneShips(w, roster).immune.map(s => s.Name)).toEqual(['Soft', 'Middle', 'Hard']);
  });

  it('breaks deflection ties by name so the order is stable', () => {
    const roster = [makeShip('Zeus', 100, 100), makeShip('Argo', 100, 100), makeShip('Mirai', 100, 100)];
    const w = { Type: 'Ballistic Cannon', Alpha: 10, _category: 'Ballistic' };
    expect(getImmuneShips(w, roster).immune.map(s => s.Name)).toEqual(['Argo', 'Mirai', 'Zeus']);
  });

  it('does not reorder the caller\'s roster', () => {
    const roster = [makeShip('Soft', 60, 60), makeShip('Hard', 300, 300)];
    const before = roster.map(s => s.Name);
    getImmuneShips({ Type: 'Ballistic Cannon', Alpha: 10, _category: 'Ballistic' }, roster);
    expect(roster.map(s => s.Name)).toEqual(before);
  });

  it('stays in step with the tier at the top band (nothing immune)', () => {
    const w = makeWeapon('Ballistic Cannon', 554);
    computeTiers([w], ROSTER);
    expect(w._tier).toBe(TOP_TIER);
    expect(getImmuneShips(w, ROSTER).immune).toHaveLength(0);
  });
});

// ─── 5. deriveTier ───────────────────────────────────────────────────────────

describe('deriveTier', () => {
  it('returns the same band as computeTiers for the same record', () => {
    const weapons = [
      makeWeapon('Ballistic Cannon', 11),
      makeWeapon('Ballistic Cannon', 54),
      makeWeapon('Ballistic Cannon', 420),
      makeWeapon('Laser Cannon', 396),
      makeWeapon('Laser Cannon', 485),
      makeWeapon('Distortion Cannon', 1),
    ];
    computeTiers(weapons, ROSTER);
    for (const w of weapons) {
      expect(deriveTier(w, ROSTER)).toBe(w._tier);
    }
  });

  it('falls back to categorize() when the record has no _category', () => {
    // Crafted-weapon recompute spreads the parsed base record (which carries
    // _category), but a caller without one must not silently land on 'Other'
    // and get a free top tier.
    const w = { Type: 'Ballistic Cannon', Alpha: 20 };
    expect(deriveTier(w, ROSTER)).toBe('lf');
  });

  it('picks up a ladder change when the ship list is swapped', () => {
    // The ladder is cached on the ships array identity - a different roster
    // must not reuse the previous thresholds.
    const w = { Type: 'Ballistic Cannon', Alpha: 20, _category: 'Ballistic' };
    expect(deriveTier(w, ROSTER)).toBe('lf');
    const softer = ROSTER.map(s => ({ ...s, 'Deflection physical': 1, 'Deflection energy': 1 }));
    expect(deriveTier(w, softer)).toBe(TOP_TIER);
    expect(deriveTier(w, ROSTER)).toBe('lf');
  });
});

// ─── 6. tierRank / TIER_META ─────────────────────────────────────────────────

describe('tier ordering and metadata', () => {
  it('ranks the ladder from none up to the top band', () => {
    const keys = ['none', 'lf', 'mf', 'hf', 'gs', 'hg', 'sc', 'cp'];
    expect(keys.map(tierRank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(tierRank(TOP_TIER)).toBe(keys.length - 1);
  });

  it('returns -1 for unknown keys', () => {
    // The pre-4.9 keys, so stale persisted state sorts below everything
    // instead of throwing.
    expect(tierRank('all')).toBe(-1);
    expect(tierRank('fighters')).toBe(-1);
    expect(tierRank(undefined)).toBe(-1);
  });

  it('puts the fighter-clearing cutoff above the medium fighter band', () => {
    expect(tierRank(CLEARS_FIGHTERS_TIER)).toBeGreaterThan(tierRank('mf'));
    expect(tierRank(CLEARS_FIGHTERS_TIER)).toBeLessThan(tierRank('gs'));
  });

  it('has a label and a badge for every tier key', () => {
    for (const key of ['none', 'lf', 'mf', 'hf', 'gs', 'hg', 'sc', 'cp']) {
      const meta = TIER_META.get(key);
      expect(meta.label).toBeTruthy();
      expect(meta.badge).toBeTruthy();
    }
    expect(TIER_META.get('sc').badge).toBe('SC');
  });
});
