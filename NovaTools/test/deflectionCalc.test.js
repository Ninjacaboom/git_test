/**
 * Tests for deflectionCalc.js.
 *
 * Damage-type rules tested:
 *   - ENERGY:    shield blocks everything until depleted. Armor only when
 *                shield = 0 AND alpha ≥ threshold.
 *   - BALLISTIC: if alpha > threshold, shield AND armor take damage on
 *                the same shot (parallel penetration). Else shield-only.
 *   - DISTORT:   shield gets mitigated dmg, armor/hull untouched. The
 *                portion that gets through targets the powerplant pool
 *                (tracked as `distortionDmg`, not modeled vs HP in v1).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initLoadoutData } from '../js/loadoutManager.js';
import {
  enumerateLoadoutWeapons,
  buildOpponentProfile,
  shieldFaceCount,
  effectiveMitigation,
  simulateShot,
  computeAmmoToBreak,
  shotsToSeconds,
} from '../js/deflectionCalc.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeWeaponItem(className, displayName, { phys = 0, energy = 0, dist = 0 } = {}) {
  return {
    className, type: 'WeaponGun', subType: 'Gun', size: 2,
    tags: '', requiredTags: '', sold: 0,
    stdItem: {
      ClassName: className, Name: displayName, Type: 'WeaponGun.Gun',
      Classification: 'WeaponGun.Gun', Size: 2,
      Weapon: { Firing: [{ DamagePerShot: { Physical: phys, Energy: energy, Distortion: dist } }] },
    },
  };
}

function makeShieldItem(className, displayName, { hp = 10000, resPhys = 0.25, resEnergy = 0, resDist = 0.95 } = {}) {
  return {
    className, type: 'Shield', subType: 'Shield', size: 2,
    tags: '', requiredTags: '', sold: 0,
    stdItem: {
      ClassName: className, Name: displayName, Type: 'Shield.Shield',
      Shield: {
        Health: hp,
        Resistance: {
          Physical: { Maximum: resPhys, Minimum: 0 },
          Energy: { Maximum: resEnergy, Minimum: 0 },
          Distortion: { Maximum: resDist, Minimum: 0 },
        },
      },
    },
  };
}

function makeShipConfig({
  armorHp = 20000,
  deflPhys = 495, deflEnergy = 418, deflDist = 0,
  armorDurPhys = 0.45, armorDurEnergy = 1.0, armorDurDist = 1.0,
  hullPhys = -0.25, hullEnergy = -0.40, hullDist = 0,
  vitalParts = { body: 50000 },
  faceType, // 'Bubble' | 'Quadrant' | undefined → drives shield-face split
} = {}) {
  const cfg = {
    Armor: {
      Durability: {
        Health: armorHp,
        DamageMultipliers: { Physical: armorDurPhys, Energy: armorDurEnergy, Distortion: armorDurDist },
      },
      DamageDeflection: { Physical: deflPhys, Energy: deflEnergy, Distortion: deflDist },
      DamageMultipliers: { Physical: 1 + hullPhys, Energy: 1 + hullEnergy, Distortion: 1 + hullDist },
    },
    Hull: {
      StructureHealthPoints: { VitalParts: vitalParts },
      PenetrationDamageMultiplier: { Fuse: 1, Component: 1 },
    },
  };
  if (faceType) {
    cfg.Hardpoints = { Components: { Systems: { Shields: { FaceType: faceType } } } };
  }
  return cfg;
}

function weaponEntry(name, alpha, type /* 'phys'|'energy'|'dist' */, count = 1, pellets = 1) {
  return {
    className: name, name, type: '', category: 'Other', count,
    alpha, dmgByType: { phys: type === 'phys' ? alpha : 0, energy: type === 'energy' ? alpha : 0, dist: type === 'dist' ? alpha : 0 },
    pellets,
    ports: [],
  };
}

function opponent({
  shieldHp = 1000, resPhys = 0, resEnergy = 0, resDist = 0,
  // Absorption defaults match every 4.x shield (full energy + distortion
  // blocking, no physical). Tests that need a "naked" shield (no absorption
  // at all) pass absEnergy: 0 explicitly.
  absPhys = 0, absEnergy = 1, absDist = 1,
  armorHp = 1000, deflPhys = 100, deflEnergy = 100, deflDist = 0,
  durPhys = 1, durEnergy = 1, durDist = 1,
  hullPhys = 1, hullEnergy = 1, hullDist = 1,
  // penComponent = ship's Hull.PenetrationDamageMultiplier.Component cap.
  // 0 (default) = component damage disabled for most legacy tests.
  penComponent = 0,
  vitalHp = 5000,
} = {}) {
  return {
    shield: {
      hp: shieldHp, maxHp: shieldHp, faceCount: 1,
      resistance: { phys: resPhys, energy: resEnergy, dist: resDist },
      absorption: { phys: absPhys, energy: absEnergy, dist: absDist },
    },
    armor: { hp: armorHp, maxHp: armorHp, threshold: { phys: deflPhys, energy: deflEnergy, dist: deflDist }, durabilityMult: { phys: durPhys, energy: durEnergy, dist: durDist } },
    hull: { damageMult: { phys: hullPhys, energy: hullEnergy, dist: hullDist }, penetration: { fuse: 1, component: penComponent }, vitalParts: { body: vitalHp }, smallestVitalHp: vitalHp },
  };
}

// ─── 1. enumerateLoadoutWeapons ──────────────────────────────────────────────

describe('enumerateLoadoutWeapons', () => {
  beforeEach(() => {
    initLoadoutData([
      makeWeaponItem('WPN_BAL', 'Deadbolt I', { phys: 200 }),
      makeWeaponItem('WPN_ENE', 'Omnisky III', { energy: 400 }),
      makeWeaponItem('WPN_DIST', 'Mantis I', { dist: 150 }),
      makeWeaponItem('WPN_ZERO', 'Bespoke Empty', {}),
    ]);
  });

  it('returns empty for empty inputs', () => {
    expect(enumerateLoadoutWeapons(null, null)).toEqual([]);
    expect(enumerateLoadoutWeapons({}, { weapons: [] })).toEqual([]);
  });

  it('lists equipped weapon with correct alpha + count', () => {
    const r = enumerateLoadoutWeapons({ hp1: 'WPN_BAL' }, { weapons: [{ portName: 'hp1' }] });
    expect(r[0].alpha).toBe(200);
    expect(r[0].dmgByType.phys).toBe(200);
    expect(r[0].count).toBe(1);
  });

  it('groups multiple instances of the same className', () => {
    const r = enumerateLoadoutWeapons(
      { hp1: 'WPN_ENE', hp2: 'WPN_ENE', hp3: 'WPN_ENE' },
      { weapons: [{ portName: 'hp1' }, { portName: 'hp2' }, { portName: 'hp3' }] }
    );
    expect(r).toHaveLength(1);
    expect(r[0].count).toBe(3);
  });

  it('excludes disabled ports', () => {
    const r = enumerateLoadoutWeapons(
      { hp1: 'WPN_BAL', hp2: 'WPN_BAL' },
      { weapons: [{ portName: 'hp1' }, { portName: 'hp2' }] },
      new Set(['hp2'])
    );
    expect(r[0].count).toBe(1);
  });

  it('walks sub-ports through turret stacks', () => {
    const r = enumerateLoadoutWeapons(
      { turret: 'WPN_ZERO', 'turret/gun1': 'WPN_BAL', 'turret/gun2': 'WPN_BAL' },
      { weapons: [], turrets: [{ portName: 'turret', ports: [{ portName: 'turret/gun1' }, { portName: 'turret/gun2' }] }] }
    );
    expect(r[0].count).toBe(2);
  });

  it('skips mount-header parent when slot has sub-weapon ports (CIG stacked-mount pattern)', () => {
    // Sabre Firebird-style hardpoint: parent slot holds a "weapon" with firing
    // data but acts as a mount-header (matches weaponColumn.js convention).
    // Only the sub-weapon should contribute alpha.
    const r = enumerateLoadoutWeapons(
      { hp: 'WPN_BAL', 'hp/sub': 'WPN_ENE' },
      { weapons: [{ portName: 'hp', ports: [{ portName: 'hp/sub' }] }] }
    );
    // Only WPN_ENE should appear - WPN_BAL is the mount-header.
    expect(r).toHaveLength(1);
    expect(r[0].className).toBe('WPN_ENE');
    expect(r[0].alpha).toBe(400);
  });

  it('parent with empty sub-ports still fires (no child weapon equipped)', () => {
    // Same hardpoint shape but child is empty → parent is the only thing firing.
    // We still treat it as a mount-header (matches main UI), so result is empty.
    // This is a known limitation: if the user removes the sub-weapon, the
    // parent silently drops out of the deflection panel even though it would
    // still fire in-game. Matches loadout UI's "no DPS on mount headers" rule.
    const r = enumerateLoadoutWeapons(
      { hp: 'WPN_BAL' },
      { weapons: [{ portName: 'hp', ports: [{ portName: 'hp/sub' }] }] }
    );
    expect(r).toEqual([]);
  });

  it('skips items with 0 alpha', () => {
    const r = enumerateLoadoutWeapons({ hp1: 'WPN_ZERO' }, { weapons: [{ portName: 'hp1' }] });
    expect(r).toEqual([]);
  });
});

// ─── 2. buildOpponentProfile ─────────────────────────────────────────────────

describe('buildOpponentProfile', () => {
  it('handles null inputs gracefully', () => {
    const p = buildOpponentProfile(null, null);
    expect(p.shield.hp).toBe(0);
    expect(p.armor.hp).toBe(0);
  });

  it('sums shield HP across installed generators (no FaceType → single face)', () => {
    const ship = makeShipConfig(); // no Hardpoints → Bubble fallback, 1 face
    const shield = { Shield: { Health: 100000, Resistance: { Physical: { Maximum: 0.25 } } } };
    const p = buildOpponentProfile(ship, shield, 4, 1, 1); // 4 generators
    expect(p.shield.maxHp).toBe(400000);   // 100000 × 4 generators / 1 face
    expect(p.shield.faceCount).toBe(1);
    expect(p.shield.totalHp).toBe(400000);
    expect(p.shield.resistance.phys).toBeCloseTo(0.25);
  });

  it('splits the bubble total across shield faces (Quadrant → breakable pool is 1/4)', () => {
    const ship = makeShipConfig({ faceType: 'Quadrant' });
    const shield = { Shield: { Health: 72000 } };
    const p = buildOpponentProfile(ship, shield, 1, 1, 1);
    expect(p.shield.faceCount).toBe(4);
    expect(p.shield.maxHp).toBe(18000);    // 72000 / 4 faces - matches SPViewer
    expect(p.shield.totalHp).toBe(72000);  // full bubble retained for display
    expect(p.shield.hp).toBe(18000);
  });

  it('scales current HP via pct sliders', () => {
    const ship = makeShipConfig({ armorHp: 20000 });
    const shield = { Shield: { Health: 10000 } };
    const p = buildOpponentProfile(ship, shield, 1, 0.5, 0.25);
    expect(p.shield.hp).toBe(5000);
    expect(p.armor.hp).toBe(5000);
  });

  it('picks smallest vital part as kill target', () => {
    const p = buildOpponentProfile(makeShipConfig({ vitalParts: { Nose: 5000, Body: 50000, Tail: 1500 } }), null);
    expect(p.hull.smallestVitalHp).toBe(1500);
  });
});

// ─── 2a. shieldFaceCount ─────────────────────────────────────────────────────

describe('shieldFaceCount', () => {
  it('maps Bubble → 1 and Quadrant → 4', () => {
    expect(shieldFaceCount('Bubble')).toBe(1);
    expect(shieldFaceCount('Quadrant')).toBe(4);
  });
  it('falls back to 1 face for unknown / missing types', () => {
    expect(shieldFaceCount(undefined)).toBe(1);
    expect(shieldFaceCount(null)).toBe(1);
    expect(shieldFaceCount('Hexagonal')).toBe(1);
  });
});

// ─── 2c. shotsToSeconds ──────────────────────────────────────────────────────

describe('shotsToSeconds', () => {
  it('converts shots to seconds at the sustained fire rate (dps/alpha = shots/s)', () => {
    // sustainedDPS 175, alpha 17.5 → 10 shots/sec. 1029 shots → 102.9 s.
    expect(shotsToSeconds(1029, 175, 17.5)).toBeCloseTo(102.9, 5);
    // 5 shots/sec (dps 50, alpha 10) → 100 shots = 20 s.
    expect(shotsToSeconds(100, 50, 10)).toBeCloseTo(20, 5);
  });

  it('passes Infinity through (never breaks) and maps 0 shots to 0 s', () => {
    expect(shotsToSeconds(Infinity, 175, 17.5)).toBe(Infinity);
    expect(shotsToSeconds(0, 175, 17.5)).toBe(0);
  });

  it('returns null when the sustained rate is unknown', () => {
    expect(shotsToSeconds(100, 0, 17.5)).toBeNull();   // no sustained DPS
    expect(shotsToSeconds(100, 175, 0)).toBeNull();     // no alpha
  });
});

// ─── 2b. effectiveMitigation ─────────────────────────────────────────────────

describe('effectiveMitigation', () => {
  it('at full shield/armor returns base shield stats', () => {
    const op = opponent({
      shieldHp: 20000, resPhys: 0.25, absPhys: 0.45,
      armorHp: 7200, penComponent: 0.4,
    });
    const eff = effectiveMitigation(op);
    expect(eff.resistance.phys).toBeCloseTo(0.25, 6);
    expect(eff.absorption.phys).toBeCloseTo(0.45, 6); // base × frac(1.0)
    expect(eff.threshold.phys).toBeCloseTo(opponent({}).armor.threshold.phys, 6);
  });

  it('scales physical absorption linearly with shield HP fraction', () => {
    const op = opponent({ absPhys: 0.45 });
    op.shield = { ...op.shield, hp: 10000, maxHp: 20000 };
    const eff = effectiveMitigation(op);
    expect(eff.absorption.phys).toBeCloseTo(0.45 * 0.5, 6);
    // Resistance stays flat (not HP-scaled) while shield is up.
    expect(eff.resistance.phys).toBeCloseTo(op.shield.resistance.phys, 6);
  });

  it('zeroes phys/dist shield mitigation when shield is down (step), energy resistance persists', () => {
    const op = opponent({
      shieldHp: 0, resPhys: 0.25, resEnergy: 0.10, resDist: 0.95,
      absPhys: 0.45, absEnergy: 1, absDist: 1,
    });
    op.shield = { ...op.shield, hp: 0, maxHp: 20000 };
    const eff = effectiveMitigation(op);
    expect(eff.resistance.phys).toBe(0);
    expect(eff.resistance.dist).toBe(0);
    expect(eff.absorption.phys).toBe(0);
    expect(eff.absorption.energy).toBe(0);
    expect(eff.absorption.dist).toBe(0);
    // Energy branch applies resistance unconditionally - matches the sim.
    expect(eff.resistance.energy).toBeCloseTo(0.10, 6);
  });

  it('does not expose a scaled component-penetration value (flat hull stat)', () => {
    const op = opponent({ armorHp: 7200, penComponent: 0.4 });
    op.armor = { ...op.armor, hp: 0, maxHp: 7200 };
    const eff = effectiveMitigation(op);
    // Component penetration is a flat hull property, rendered straight from
    // the profile - effectiveMitigation must not return an armor-scaled value.
    expect(eff.componentPenetration).toBeUndefined();
  });

  it('scales deflection threshold linearly with armor fraction', () => {
    const mk = (hp) => {
      const op = opponent({ armorHp: 7200, deflPhys: 41, deflEnergy: 32 });
      op.armor = { ...op.armor, hp, maxHp: 7200 };
      return effectiveMitigation(op);
    };
    expect(mk(7200).threshold.phys).toBeCloseTo(41, 6);   // 100%
    expect(mk(5400).threshold.phys).toBeCloseTo(30.75, 6); // 75%
    expect(mk(3600).threshold.phys).toBeCloseTo(20.5, 6);  // 50%
    expect(mk(3600).threshold.energy).toBeCloseTo(16, 6);  // 32 × 0.5
    expect(mk(0).threshold.phys).toBe(0);                  // 0%
  });
});

// ─── 2b. simulateShot - MULTI-PELLET DEFLECTION ──────────────────────────────

describe('simulateShot - multi-pellet deflection', () => {
  // Regression: armor deflection is decided per IMPACT, not per trigger pull.
  // An 8-pellet scattergun with 800 summed alpha lands 100 per pellet, which a
  // 200 threshold stops cold. The sim used to compare the summed 800 against
  // the threshold and wave the whole shot through, which made scatterguns
  // sweep every top spot in a loadout search against real Live data.
  const bare = extra => opponent({ shieldHp: 0, armorHp: 5000, durPhys: 1, ...extra });

  it('deflects a spread whose PELLETS fall under the threshold', () => {
    const r = simulateShot(weaponEntry('Scatter', 800, 'phys', 1, 8), bare({ deflPhys: 200 }));
    expect(r.deflected).toBe(true);
    expect(r.armorDmg).toBe(0);
  });

  it('same alpha as ONE impact still lands - isolates the pellet gate', () => {
    const r = simulateShot(weaponEntry('Cannon', 800, 'phys', 1, 1), bare({ deflPhys: 200 }));
    expect(r.deflected).toBe(false);
    expect(r.armorDmg).toBeCloseTo(800);
  });

  it('a spread clearing the threshold per pellet deals its FULL summed damage', () => {
    // 100 per pellet vs a 50 threshold: the gate opens and application is
    // unchanged, so the spread must match an equal-alpha solid slug exactly.
    const spread = simulateShot(weaponEntry('Scatter', 800, 'phys', 1, 8), bare({ deflPhys: 50 }));
    const slug   = simulateShot(weaponEntry('Cannon', 800, 'phys', 1, 1), bare({ deflPhys: 50 }));
    expect(spread.deflected).toBe(false);
    expect(spread.armorDmg).toBeCloseTo(slug.armorDmg);
  });

  it('applies to the ballistic pass-through while the shield is still up', () => {
    // absPhys 0.45 at full shield → 55% of alpha passes through: 440 summed,
    // 55 per pellet. A 100 threshold deflects the spread but not the slug.
    const shielded = { shieldHp: 5000, absPhys: 0.45, armorHp: 5000, durPhys: 1, deflPhys: 100 };
    const spread = simulateShot(weaponEntry('Scatter', 800, 'phys', 1, 8), opponent(shielded));
    const slug   = simulateShot(weaponEntry('Cannon', 800, 'phys', 1, 1), opponent(shielded));
    expect(spread.deflected).toBe(true);
    expect(spread.armorDmg).toBe(0);
    expect(slug.deflected).toBe(false);
    // The shield tap is unaffected by pellet count - only the armor gate is.
    expect(spread.shieldDmg).toBeCloseTo(slug.shieldDmg);
  });

  it('missing/absent pellets field behaves as a single impact', () => {
    const w = weaponEntry('Legacy', 800, 'phys');
    delete w.pellets;
    expect(simulateShot(w, bare({ deflPhys: 200 })).armorDmg).toBeCloseTo(800);
  });
});

// ─── 3. simulateShot - ENERGY ────────────────────────────────────────────────

describe('simulateShot - ENERGY', () => {
  it('shield blocks everything while up - no armor damage even if alpha > threshold', () => {
    const w = weaponEntry('W', 1000, 'energy');
    const op = opponent({ shieldHp: 5000, resEnergy: 0, deflEnergy: 100 });
    const r = simulateShot(w, op);
    expect(r.shieldDmg).toBeCloseTo(1000);
    expect(r.armorDmg).toBe(0);
    expect(r.hullDmg).toBe(0);
    expect(r.deflected).toBe(false);
  });

  it('shield resistance reduces shield damage proportionally', () => {
    const w = weaponEntry('W', 1000, 'energy');
    const op = opponent({ shieldHp: 5000, resEnergy: 0.5 });
    const r = simulateShot(w, op);
    expect(r.shieldDmg).toBeCloseTo(500);
  });

  it('shield down + alpha ≥ threshold → armor damage', () => {
    const w = weaponEntry('W', 500, 'energy');
    const op = opponent({ shieldHp: 0, deflEnergy: 100, armorHp: 2000, durEnergy: 1 });
    const r = simulateShot(w, op);
    expect(r.armorDmg).toBeCloseTo(500);
    expect(r.deflected).toBe(false);
  });

  it('shield down + alpha < threshold → DEFLECTED, no armor damage', () => {
    const w = weaponEntry('W', 50, 'energy');
    const op = opponent({ shieldHp: 0, deflEnergy: 100 });
    const r = simulateShot(w, op);
    expect(r.armorDmg).toBe(0);
    expect(r.deflected).toBe(true);
  });

  it('shield down + armor drained → hull damage with hullMult', () => {
    const w = weaponEntry('W', 1000, 'energy');
    const op = opponent({ shieldHp: 0, armorHp: 0, deflEnergy: 100, hullEnergy: 0.6 });
    const r = simulateShot(w, op);
    expect(r.hullDmg).toBeCloseTo(600);
  });
});

// ─── 4. simulateShot - BALLISTIC ─────────────────────────────────────────────

describe('simulateShot - BALLISTIC', () => {
  it('alpha > threshold + shield up, zero absorption → all mitigated alpha passes through', () => {
    // absPhys=0 → effAbs=0 → shield_hp_loss = 0, post_shield = alpha × (1-res) = 600.
    // Armor takes post_shield × hullMult = 600 (hullMult default 1).
    const w = weaponEntry('W', 600, 'phys');
    const op = opponent({ shieldHp: 5000, resPhys: 0, armorHp: 2000, deflPhys: 100, durPhys: 1 });
    const r = simulateShot(w, op);
    expect(r.shieldDmg).toBe(0);
    expect(r.armorDmg).toBeCloseTo(600);
    expect(r.deflected).toBe(false);
  });

  it('alpha < threshold + shield up + zero absorption → DEFLECTED, no shield loss', () => {
    // absPhys=0 → shield doesn't absorb either. Post-shield = 50, below threshold.
    const w = weaponEntry('W', 50, 'phys');
    const op = opponent({ shieldHp: 5000, resPhys: 0, deflPhys: 100 });
    const r = simulateShot(w, op);
    expect(r.shieldDmg).toBe(0);
    expect(r.armorDmg).toBe(0);
    expect(r.deflected).toBe(true);
  });

  it('deflection threshold scales with armor: deflected at full armor, penetrates once stripped', () => {
    // Shield down so post_shield == alpha (30). Base threshold 41.
    const w = weaponEntry('W', 30, 'phys');
    const full = opponent({ shieldHp: 0, armorHp: 1000, deflPhys: 41 });
    expect(simulateShot(w, full).deflected).toBe(true);   // 30 ≤ 41 → deflected

    const half = opponent({ shieldHp: 0, armorHp: 1000, deflPhys: 41 });
    half.armor = { ...half.armor, hp: 500, maxHp: 1000 };  // 50% → threshold 20.5
    const r = simulateShot(w, half);
    expect(r.deflected).toBe(false);                       // 30 > 20.5 → through
    expect(r.armorDmg).toBeCloseTo(30);
  });

  it('applies armor durability only while armor remains (neutral once stripped)', () => {
    const w = weaponEntry('W', 1000, 'phys');
    // Armor present (hp>0) but post_shield exceeds it → durMult applies to the
    // overflow that reaches hull. durPhys 0.5, hullPhys 1.
    const withArmor = opponent({ shieldHp: 0, armorHp: 200, deflPhys: 0, durPhys: 0.5, hullPhys: 1 });
    expect(simulateShot(w, withArmor).hullDmg).toBeCloseTo((1000 - 200) * 0.5);

    // Armor fully stripped (hp 0) → durability is neutral, hull takes the raw
    // post_shield × hullMult with no durability multiplier.
    const noArmor = opponent({ shieldHp: 0, armorHp: 0, deflPhys: 0, durPhys: 0.5, hullPhys: 1 });
    expect(simulateShot(w, noArmor).hullDmg).toBeCloseTo(1000);
  });

  it('shield absorbs portion of mitigated alpha (reference model)', () => {
    // alpha 1000, res 0.25, absPhys 0.50, shield 100% full.
    // mitigated = 1000 × 0.75 = 750. effAbs = 0.50.
    // shield_hp_loss = 750 × 0.50 = 375. post_shield = 750 × 0.50 = 375.
    const w = weaponEntry('W', 1000, 'phys');
    const op = opponent({ shieldHp: 5000, resPhys: 0.25, absPhys: 0.50, armorHp: 5000, deflPhys: 100 });
    const r = simulateShot(w, op);
    expect(r.shieldDmg).toBeCloseTo(375);
    expect(r.armorDmg).toBeCloseTo(375);
  });

  it('absorption scales linearly with shield HP fraction', () => {
    // Half shield (50%) → effAbs = 0.50 × 0.50 = 0.25.
    // mitigated = 1000 × 0.75 = 750. shield_hp_loss = 750 × 0.25 = 187.5.
    // post_shield = 750 × 0.75 = 562.5.
    const w = weaponEntry('W', 1000, 'phys');
    const op = opponent({ shieldHp: 2500, resPhys: 0.25, absPhys: 0.50, armorHp: 5000, deflPhys: 100 });
    op.shield.maxHp = 5000; // 50% full
    const r = simulateShot(w, op);
    expect(r.shieldDmg).toBeCloseTo(187.5);
    expect(r.armorDmg).toBeCloseTo(562.5);
  });

  it('armor durability applies by default (game-realistic, STARC-198632)', () => {
    // Shield down, alpha 1000, durPhys 0.5, hullPhys default 1.
    // Default options.applyArmorDurability=true → armor takes 500.
    const w = weaponEntry('W', 1000, 'phys');
    const op = opponent({ shieldHp: 0, armorHp: 5000, deflPhys: 100, durPhys: 0.5 });
    const r = simulateShot(w, op);
    expect(r.armorDmg).toBeCloseTo(500);
  });

  it('opt-out: applyArmorDurability=false skips durability (matches the reference display)', () => {
    const w = weaponEntry('W', 1000, 'phys');
    const op = opponent({ shieldHp: 0, armorHp: 5000, deflPhys: 100, durPhys: 0.5 });
    const r = simulateShot(w, op, { applyArmorDurability: false });
    expect(r.armorDmg).toBeCloseTo(1000);
  });

  it('armor break overflows into hull within the same shot', () => {
    // Reference (Idris MasDriver vs Anvil Arrow):
    //   post_shield > armor.hp -> armor_dmg caps at armor.hp,
    //   hull_dmg = (post_shield − armor.hp) × hullMult.
    // With alpha 1000 vs armor 100 + hullMult 0.75:
    //   armor_dmg = 100 (cap), hull_dmg = (1000 − 100) × 0.75 = 675
    const w = weaponEntry('W', 1000, 'phys');
    const op = opponent({ shieldHp: 0, armorHp: 100, deflPhys: 100, durPhys: 1, hullPhys: 0.75 });
    const r = simulateShot(w, op);
    expect(r.armorDmg).toBe(100);
    expect(r.hullDmg).toBeCloseTo(675);
  });

  it('armor at 0 + alpha penetrates → full vital damage', () => {
    const w = weaponEntry('W', 1000, 'phys');
    const op = opponent({ shieldHp: 0, armorHp: 0, deflPhys: 100, hullPhys: 0.75 });
    const r = simulateShot(w, op);
    expect(r.armorDmg).toBe(0);
    expect(r.hullDmg).toBeCloseTo(750); // 1000 × 0.75
  });
});

// ─── 5. simulateShot - DISTORTION ────────────────────────────────────────────

describe('simulateShot - DISTORTION', () => {
  it('shield up: shield catches mitigated dmg; PP dmg gated by absorption', () => {
    // Game-realistic: most shields have 100% distortion absorption, so PP
    // damage is essentially zero while shield is up.
    const w = weaponEntry('W', 100, 'dist');
    const op = opponent({ shieldHp: 5000, resDist: 0.95, absDist: 1.0 });
    const r = simulateShot(w, op);
    expect(r.shieldDmg).toBeCloseTo(5);   // 100 × (1 - 0.95)
    expect(r.distortionDmg).toBe(0);      // 100 × (1 - 1.0)
    expect(r.armorDmg).toBe(0);
    expect(r.hullDmg).toBe(0);
    expect(r.deflected).toBe(false);
  });

  it('shield up + low absorption: portion of alpha leaks to PP', () => {
    const w = weaponEntry('W', 100, 'dist');
    const op = opponent({ shieldHp: 5000, resDist: 0.95, absDist: 0.5 });
    const r = simulateShot(w, op);
    expect(r.shieldDmg).toBeCloseTo(5);   // shield HP loss
    expect(r.distortionDmg).toBeCloseTo(50); // 100 × (1 - 0.5)
  });

  it('shield down: full alpha goes to powerplant pool, armor/vital untouched', () => {
    const w = weaponEntry('W', 100, 'dist');
    const op = opponent({ shieldHp: 0, resDist: 0.95 });
    const r = simulateShot(w, op);
    expect(r.shieldDmg).toBe(0);
    expect(r.distortionDmg).toBe(100);
    expect(r.armorDmg).toBe(0);
    expect(r.hullDmg).toBe(0);
  });

  it('does not flag DEFLECTED - distortion is never blocked by armor threshold', () => {
    const w = weaponEntry('W', 5, 'dist');
    const op = opponent({ shieldHp: 0, deflDist: 100 });
    const r = simulateShot(w, op);
    expect(r.deflected).toBe(false);
  });
});

// ─── 6. simulateShot - mixed type ────────────────────────────────────────────

describe('simulateShot - mixed-type weapon', () => {
  it('runs each damage component through its own chain', () => {
    const w = {
      className: 'W', name: 'W', type: '', category: 'Other', count: 1,
      alpha: 350,
      dmgByType: { phys: 200, energy: 100, dist: 50 },
      ports: [],
    };
    const op = opponent({ shieldHp: 0, deflPhys: 100, deflEnergy: 50, durPhys: 1, durEnergy: 1 });
    const r = simulateShot(w, op);
    // Phys 200 (penetrates), armor +200. Energy 100 (≥ 50), armor +100. Dist 50, no armor.
    expect(r.armorDmg).toBeCloseTo(300);
    // Distortion still contributes to its own pool.
    expect(r.distortionDmg).toBeCloseTo(50);
  });
});

// ─── 6b. Reference scenarios ────────────────────────────────────────

describe('Reference scenarios', () => {
  // Polaris armor: dur phys 0.81 / energy 1.28, hull phys 0.75 / energy 0.60.
  // Glacis shield: resPhys 25% / energy 0% / dist 95%. absPhys 45% / energy
  // 100% / dist 100%. Verified from Live 4.8.0 game data.
  const polaris = {
    shield: { hp: 162000 * 4, maxHp: 162000 * 4, faceCount: 4,
      resistance: { phys: 0.25, energy: 0, dist: 0.95 },
      absorption: { phys: 0.45, energy: 1.0, dist: 1.0 } },
    armor: { hp: 48960, maxHp: 48960,
      threshold: { phys: 495, energy: 418, dist: 0 },
      durabilityMult: { phys: 0.81, energy: 1.28, dist: 1 } },
    hull: { damageMult: { phys: 0.75, energy: 0.60, dist: 1 },
      penetration: { fuse: 1, component: 1 },
      vitalParts: { Body: 50000 }, smallestVitalHp: 50000 },
  };

  it('Polaris ballistic Deadbolt I: alpha 202.5 → DEFLECTED (shield up)', () => {
    const w = weaponEntry('Deadbolt I', 202.5, 'phys');
    // postShield = 202.5 × 0.75 × 0.55 = 83.5 < 495 threshold → deflected
    const r = simulateShot(w, polaris);
    expect(r.deflected).toBe(true);
    expect(r.armorDmg).toBe(0);
  });

  it('Polaris ballistic Deadbolt IV @ 100% shield: shield 230.5, post 281.8 → DEFLECTED', () => {
    // Reference chain (Deadbolt IV α=683.1 vs Polaris, res=0.25, baseAbs=0.45):
    //   mitigated = 683.1 × 0.75 = 512.33
    //   shield_hp_loss = 512.33 × 0.45 = 230.55
    //   post_shield   = 512.33 × 0.55 = 281.78  < 495 → DEFLECTED
    const w = weaponEntry('Deadbolt IV', 683.1, 'phys');
    const r = simulateShot(w, polaris);
    expect(r.deflected).toBe(true);
    expect(r.armorDmg).toBe(0);
    expect(r.shieldDmg).toBeCloseTo(230.55, 1);
  });

  it('Polaris ballistic Deadbolt IV @ 50% shield: shield 115.3, post 397.1 → DEFLECTED', () => {
    // effAbs = 0.45 × 0.5 = 0.225.
    //   shield_hp_loss = 512.33 × 0.225 = 115.27
    //   post_shield   = 512.33 × 0.775 = 397.05  < 495 → DEFLECTED
    const half = {
      ...polaris,
      shield: { ...polaris.shield, hp: polaris.shield.maxHp * 0.5 },
    };
    const w = weaponEntry('Deadbolt IV', 683.1, 'phys');
    const r = simulateShot(w, half);
    expect(r.deflected).toBe(true);
    expect(r.shieldDmg).toBeCloseTo(115.27, 1);
    expect(r.armorDmg).toBe(0);
  });

  it('Polaris ballistic Deadbolt IV @ 8% shield: shield 18.4, post 493.9 → DEFLECTED', () => {
    // effAbs = 0.45 × 0.08 = 0.036.
    //   shield_hp_loss = 512.33 × 0.036 = 18.44
    //   post_shield   = 512.33 × 0.964 = 493.88  < 495 → DEFLECTED
    const low = {
      ...polaris,
      shield: { ...polaris.shield, hp: polaris.shield.maxHp * 0.08 },
    };
    const w = weaponEntry('Deadbolt IV', 683.1, 'phys');
    const r = simulateShot(w, low);
    expect(r.deflected).toBe(true);
    expect(r.shieldDmg).toBeCloseTo(18.44, 1);
    expect(r.armorDmg).toBe(0);
  });

  it('Polaris ballistic Deadbolt IV @ 7% shield: shield 16.1, post 496.2 → armor 301.5 (with durability, default)', () => {
    // effAbs = 0.45 × 0.07 = 0.0315.
    //   shield_hp_loss = 512.33 × 0.0315 = 16.14
    //   post_shield   = 512.33 × 0.9685 = 496.19  > 495 → penetrates
    //   armor_dmg     = 496.19 × 0.81 (dur) × 0.75 (hull) = 301.43
    // Default (applyArmorDurability=true) - game-realistic if STARC-198632 fix landed.
    const critical = {
      ...polaris,
      shield: { ...polaris.shield, hp: polaris.shield.maxHp * 0.07 },
    };
    const w = weaponEntry('Deadbolt IV', 683.1, 'phys');
    const r = simulateShot(w, critical);
    expect(r.deflected).toBe(false);
    expect(r.shieldDmg).toBeCloseTo(16.14, 1);
    expect(r.armorDmg).toBeCloseTo(301.43, 1);
  });

  it('Polaris ballistic Deadbolt IV @ 7% shield, durability off: armor 372.1 (matches the reference display)', () => {
    // Same scenario but opt-out of durability - the reference mitigation panel
    // shows armor durability with ⚠️ and doesn't apply it. Matches the
    // screenshot value 372.1.
    const critical = {
      ...polaris,
      shield: { ...polaris.shield, hp: polaris.shield.maxHp * 0.07 },
    };
    const w = weaponEntry('Deadbolt IV', 683.1, 'phys');
    const r = simulateShot(w, critical, { applyArmorDurability: false });
    expect(r.deflected).toBe(false);
    expect(r.armorDmg).toBeCloseTo(372.14, 1);
  });

  it('Polaris ballistic big shot: alpha 1500 → armor damage even at full shield (with durability)', () => {
    // mitigated = 1500 × 0.75 = 1125. effAbs = 0.45.
    //   shield_hp_loss = 1125 × 0.45 = 506.25
    //   post_shield   = 1125 × 0.55 = 618.75 > 495 → penetrates
    //   armor_dmg     = 618.75 × 0.81 × 0.75 = 375.89
    const w = weaponEntry('Big', 1500, 'phys');
    const r = simulateShot(w, polaris);
    expect(r.deflected).toBe(false);
    expect(r.shieldDmg).toBeCloseTo(506.25, 1);
    expect(r.armorDmg).toBeCloseTo(375.89, 1);
  });

  const scorpius = {
    shield: { hp: 0, maxHp: 4488, faceCount: 1,
      resistance: { phys: 0.25, energy: 0, dist: 0.95 },
      absorption: { phys: 0.45, energy: 1.0, dist: 1.0 } },
    armor: { hp: 8640, maxHp: 8640,
      threshold: { phys: 50, energy: 40, dist: 0 },
      durabilityMult: { phys: 0.81, energy: 1.28, dist: 1 } },
    hull: { damageMult: { phys: 0.75, energy: 0.60, dist: 1 },
      penetration: { fuse: 1, component: 1 },
      vitalParts: { Body: 6540 }, smallestVitalHp: 6540 },
  };

  it('Scorpius energy Attrition-4: alpha 100 → armor 60 (shield down, no durability)', () => {
    // reference match: 100 × 0.60 hullMult.energy = 60 (durability off).
    // applyArmorDurability=true would give 100 × 1.28 × 0.60 = 76.8.
    const w = weaponEntry('Attrition-4', 100, 'energy');
    const r = simulateShot(w, scorpius, { applyArmorDurability: false });
    expect(r.deflected).toBe(false);
    expect(r.armorDmg).toBeCloseTo(60);
    expect(r.hullDmg).toBe(0); // armor still up
  });

  it('Scorpius energy Attrition-4: ammo to break armor = 144 (8640/60, no durability)', () => {
    const w = weaponEntry('Attrition-4', 100, 'energy');
    const r = computeAmmoToBreak(w, scorpius, { applyArmorDurability: false });
    expect(r.armor).toBe(144);
  });

  it('Scorpius energy Attrition-3: alpha 86 → armor ammo 167 (mid-shot break, no durability)', () => {
    // 86 × 0.6 = 51.6 per shot. After 166 full shots armor = 74.4 HP left;
    // shot 167's post-shield 86 > 74.4 -> armor breaks mid-shot (cap +
    // overflow into hull). So 167 shots, not 168 - the new armor-break
    // overflow model counts the breaking shot once instead of needing a
    // whole extra shot to mop up the residual 22.8 HP.
    const w = weaponEntry('Attrition-3', 86, 'energy');
    const r = computeAmmoToBreak(w, scorpius, { applyArmorDurability: false });
    expect(r.armor).toBe(167);
  });

  it('Scorpius distortion DR Model-XJ2: shield down → no armor/hull damage, PP gets full alpha', () => {
    const w = weaponEntry('DR Model-XJ2', 38.5, 'dist');
    const r = simulateShot(w, scorpius);
    expect(r.armorDmg).toBe(0);
    expect(r.hullDmg).toBe(0);
    expect(r.distortionDmg).toBe(38.5);
  });

  // ─── Component penetration reference cases (Guardian MX / FullStop) ───
  //
  // Guardian MX: hullMult.phys = 0.75, hullMult.energy = 1.10,
  // armor.hp = 10800 (max), Component pen cap = 0.60.
  // FullStop shields: zero resistance + zero absorption (in test data).
  const guardian = (armorPct) => ({
    shield: {
      hp: 0, maxHp: 0, faceCount: 2,
      resistance: { phys: 0, energy: 0, dist: 0 },
      absorption: { phys: 0, energy: 0, dist: 0 },
    },
    armor: {
      hp: Math.round(10800 * armorPct), maxHp: 10800,
      threshold: { phys: 27, energy: 20, dist: 0 },
      durabilityMult: { phys: 0.85, energy: 1.21, dist: 1 },
    },
    hull: {
      damageMult: { phys: 0.75, energy: 1.10, dist: 1 },
      penetration: { fuse: 1, component: 0.60 },
      vitalParts: { Body: 15510 }, smallestVitalHp: 15510,
    },
  });

  it('M6A vs Guardian @armor 100% shield 0%: PEN ~0.18 m / ~24 component dmg', () => {
    // Reference: PEN 0.2 m / 23.1 dmg, x0.034 multiplier.
    // Our approximation uses RESIDUAL=0.06 -> 0.036 multiplier, 0.18 m.
    // Within ~5% of the displayed value.
    const w = { ...weaponEntry('M6A', 615.28, 'energy'), basePen: 3.0 };
    const r = simulateShot(w, guardian(1.0), { applyArmorDurability: false });
    expect(r.armorDmg).toBeCloseTo(676.8, 0);  // 615.28 × 1.10
    expect(r.hullDmg).toBe(0);
    expect(r.penDistance).toBeCloseTo(0.18, 1);
    expect(r.componentDmg).toBeCloseTo(24.4, 0);  // 676.8 × 0.036
  });

  it('M6A vs Guardian @armor 50%: PEN ~1.59 m / ~215 component dmg', () => {
    // Reference: PEN 1.7 m / 226.2 dmg, x0.33 multiplier.
    const w = { ...weaponEntry('M6A', 615.28, 'energy'), basePen: 3.0 };
    const r = simulateShot(w, guardian(0.5), { applyArmorDurability: false });
    expect(r.armorDmg).toBeCloseTo(676.8, 0);
    expect(r.penDistance).toBeCloseTo(1.59, 1);
    expect(r.componentDmg).toBeCloseTo(215.2, 0);  // 676.8 × 0.318
  });

  it('M6A vs Guardian @armor 0%: PEN 3.0 m / 406 component dmg (no armor)', () => {
    // Reference: PEN 3.0 m / 406.1 dmg, x0.60 multiplier (ship max).
    const w = { ...weaponEntry('M6A', 615.28, 'energy'), basePen: 3.0 };
    const r = simulateShot(w, guardian(0), { applyArmorDurability: false });
    expect(r.armorDmg).toBe(0);
    expect(r.hullDmg).toBeCloseTo(676.8, 0);
    expect(r.penDistance).toBeCloseTo(3.0, 1);
    expect(r.componentDmg).toBeCloseTo(406.1, 0);
  });

  it('Deadbolt IV vs Guardian @armor 0%: PEN 6.6 m / 564 component dmg', () => {
    // Reference: PEN 6.6 m / 307.4 dmg, x0.60 multiplier.
    // hull_dmg = 683.1 × 0.75 = 512.3, component = 512.3 × 0.60 = 307.4
    const w = { ...weaponEntry('Deadbolt IV', 683.1, 'phys'), basePen: 6.6 };
    const r = simulateShot(w, guardian(0), { applyArmorDurability: false });
    expect(r.hullDmg).toBeCloseTo(512.3, 0);
    expect(r.penDistance).toBeCloseTo(6.6, 1);
    expect(r.componentDmg).toBeCloseTo(307.4, 0);
  });

  // ─── Armor break overflow reference (Idris MasDriver vs Anvil Arrow) ───
  it('Mass Driver vs Anvil Arrow: shield + armor break overflow + maxed component pen', () => {
    // Reference at shield/armor 100%:
    //   alpha 288320 ballistic, Arrow shield 3168 / armor 3300
    //   mitigated = 288320 × (1 - 0.25) = 216240
    //   shield tries to absorb 216240 × 0.45 = 97308, capped at 3168 HP -> breaks
    //   post_shield = mitigated - shieldDmg = 216240 - 3168 = 213072
    //   armor breaks -> armor_dmg 3300, hull_dmg (213072-3300)×0.75 = 157329
    //   component max (broken armor) -> 213072 × 0.75 × 0.30 = 47941.2
    const arrow = {
      shield: {
        hp: 3168, maxHp: 3168, faceCount: 1,
        resistance: { phys: 0.25, energy: 0, dist: 0.95 },
        absorption: { phys: 0.45, energy: 1.0, dist: 1.0 },
      },
      armor: {
        hp: 3300, maxHp: 3300,
        threshold: { phys: 12, energy: 6, dist: 0 },
        durabilityMult: { phys: 0.81, energy: 1.15, dist: 1 },
      },
      hull: {
        damageMult: { phys: 0.75, energy: 0.60, dist: 1 },
        penetration: { fuse: 1, component: 0.30 },
        vitalParts: { Body: 25000 }, smallestVitalHp: 25000,
      },
    };
    const w = { ...weaponEntry('Mass Driver', 288320, 'phys'), basePen: 50.4 };
    const r = simulateShot(w, arrow, { applyArmorDurability: false });
    expect(r.shieldDmg).toBe(3168);              // capped at shield HP (break)
    expect(r.armorDmg).toBe(3300);                // capped at armor HP (break)
    expect(r.hullDmg).toBeCloseTo(157329, 0);     // (213072 − 3300) × 0.75
    expect(r.componentDmg).toBeCloseTo(47941.2, 1); // 213072 × 0.75 × 0.30
    expect(r.penDistance).toBeCloseTo(50.4, 1);   // max pen (broke armor)
  });

  // ─── Energy shield overflow (shot exceeds remaining shield HP) ───
  it('Energy: alpha exceeds remaining shield HP → overflow leaks to armor', () => {
    // Shield at 8% (507 HP remaining), alpha 678.3 energy, abs.energy 1.0.
    // Old (broken): postShield = 678.3 × (1-1.0) = 0 → 0 armor dmg.
    // New (correct): shield absorbs 507, postShield = 678.3 - 507 = 171.3.
    const op = {
      shield: {
        hp: 507, maxHp: 6340, faceCount: 1,
        resistance: { phys: 0, energy: 0, dist: 0 },
        absorption: { phys: 0, energy: 1.0, dist: 1.0 },
      },
      armor: {
        hp: 5000, maxHp: 5000,
        threshold: { phys: 12, energy: 6, dist: 0 },
        durabilityMult: { phys: 1, energy: 1, dist: 1 },
      },
      hull: {
        damageMult: { phys: 1, energy: 1, dist: 1 },
        penetration: { fuse: 1, component: 0.30 },
        vitalParts: { Body: 10000 }, smallestVitalHp: 10000,
      },
    };
    const w = { ...weaponEntry('M6A', 678.3, 'energy'), basePen: 3.0 };
    const r = simulateShot(w, op, { applyArmorDurability: false });
    expect(r.shieldDmg).toBe(507);                 // capped at shield HP (break)
    expect(r.armorDmg).toBeCloseTo(171.3, 1);      // 678.3 − 507 overflow
    expect(r.hullDmg).toBe(0);                     // armor absorbs all overflow
  });
});

// ─── 7. computeAmmoToBreak ───────────────────────────────────────────────────

describe('computeAmmoToBreak', () => {
  it('energy weapon: shield must drop first before armor takes any damage', () => {
    const w = weaponEntry('W', 100, 'energy');
    const op = opponent({ shieldHp: 500, armorHp: 200, vitalHp: 0, deflEnergy: 50 });
    const r = computeAmmoToBreak(w, op);
    expect(r.shield).toBe(5);
    expect(r.armor).toBeGreaterThanOrEqual(r.shield);
  });

  it('ballistic above threshold: armor can drop BEFORE shield', () => {
    const w = weaponEntry('W', 500, 'phys');
    const op = opponent({ shieldHp: 2000, armorHp: 500, vitalHp: 5000, deflPhys: 100, durPhys: 1 });
    const r = computeAmmoToBreak(w, op);
    expect(r.armor).toBe(1);              // armor drained shot 1
    expect(r.shield).toBeGreaterThanOrEqual(r.armor);
  });

  it('ballistic below threshold: deflected → armor + vital = Infinity', () => {
    const w = weaponEntry('W', 50, 'phys');
    const op = opponent({ shieldHp: 0, armorHp: 1000, deflPhys: 100 });
    const r = computeAmmoToBreak(w, op);
    expect(r.shield).toBe(0);
    expect(r.armor).toBe(Infinity);
    expect(r.hull).toBe(Infinity);
  });

  it('distortion weapon: shield drains, but armor/vital stay Infinity', () => {
    const w = weaponEntry('W', 100, 'dist');
    const op = opponent({ shieldHp: 1000, armorHp: 1000, resDist: 0.95 });
    const r = computeAmmoToBreak(w, op);
    // shield mitigated to 5 dmg/shot → 1000/5 = 200 shots
    expect(r.shield).toBe(200);
    expect(r.armor).toBe(Infinity);
    expect(r.hull).toBe(Infinity);
  });

  it('reports per-weapon shots regardless of stack count (reference convention)', () => {
    const w = weaponEntry('W', 100, 'energy', 4);
    const op = opponent({ shieldHp: 1000, armorHp: 0, vitalHp: 0 });
    const r = computeAmmoToBreak(w, op);
    // 100 dmg per shot from one weapon → 10 shots to break 1000 HP shield.
    // count=4 is informational only; reference convention is per-instance.
    expect(r.shield).toBe(10);
  });

  it('returns 0 for stages already at 0 HP at start', () => {
    const w = weaponEntry('W', 100, 'energy');
    const op = opponent({ shieldHp: 0, armorHp: 0, vitalHp: 1000, deflEnergy: 0 });
    const r = computeAmmoToBreak(w, op);
    expect(r.shield).toBe(0);
    expect(r.armor).toBe(0);
    expect(r.hull).toBe(10);
  });
});
