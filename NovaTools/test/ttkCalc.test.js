import { describe, it, expect } from 'vitest';
import { getWeaponCadence } from '../js/sustained.js';
import { buildTtkOpponentProfile, simulateTtk, totalSustainedDPS, classifyTurretWeapon, computeOptimalPauseLen } from '../js/ttkCalc.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Plain opponent profile (bypasses the DB-backed builder) for sim tests. */
function ttkOpp({
  shieldHp = 0, resPhys = 0, resEnergy = 0, resDist = 0,
  // Energy/distortion absorption default to 1 (every 4.x shield is
  // shield-first for those types); physical absorption defaults to 0.
  absPhys = 0, absEnergy = 1, absDist = 1,
  armorHp = 0, deflPhys = 0, deflEnergy = 0, deflDist = 0,
  hullPhys = 1, hullEnergy = 1, hullDist = 1,
  penComponent = 1, vitalHp = 0,
  ppHp = 0, ppDistMax = 0, ppDecayDelay = 0, ppDecayRate = 0,
}) {
  return {
    shield: {
      hp: shieldHp, maxHp: shieldHp, faceCount: 1, totalHp: shieldHp,
      resistance: { phys: resPhys, energy: resEnergy, dist: resDist },
      absorption: { phys: absPhys, energy: absEnergy, dist: absDist },
    },
    armor: {
      hp: armorHp, maxHp: armorHp,
      threshold: { phys: deflPhys, energy: deflEnergy, dist: deflDist },
      durabilityMult: { phys: 1, energy: 1, dist: 1 },
    },
    hull: {
      damageMult: { phys: hullPhys, energy: hullEnergy, dist: hullDist },
      penetration: { fuse: 1, component: penComponent },
      vitalParts: {}, smallestVitalHp: vitalHp,
    },
    powerplant: {
      hp: ppHp, maxHp: ppHp, distortionMax: ppDistMax,
      distortionDecayDelay: ppDecayDelay, distortionDecayRate: ppDecayRate,
    },
  };
}

/** One weapon group with a 1s shot interval, continuous fire, given alpha. */
function grp({ phys = 0, energy = 0, dist = 0, basePen = 0, count = 1, interval = 1 }) {
  return {
    className: 'TEST', name: 'Test', count,
    alpha: phys + energy + dist,
    dmgByType: { phys, energy, dist },
    basePen, sustainedDPS: (phys + energy + dist) / interval,
    cadence: { rpm: 60 / interval, shotInterval: interval, magazine: Infinity, reloadTime: 0 },
  };
}

// ─── getWeaponCadence ───────────────────────────────────────────────────────

describe('getWeaponCadence', () => {
  it('energy weapon: regen-limited magazine + reload', () => {
    const c = getWeaponCadence(
      { Firing: [{ RoundsPerMinute: 150 }] },
      { MaxAmmo: 300, MaxRegenPerSec: 50, Cooldown: 1 },
    );
    expect(c.shotInterval).toBeCloseTo(0.4);
    expect(c.magazine).toBe(300);
    expect(c.reloadTime).toBeCloseTo(7); // 300/50 + 1
  });

  it('ballistic with heat: rounds-before-overheat magazine + overheat fix reload', () => {
    const c = getWeaponCadence({
      Firing: [{ RoundsPerMinute: 60, HeatPerShot: 10 }],
      Ammunition: { Capacity: 2000 },
      HeatParameters: { OverheatTemp: 100, MinTemp: 0, OverheatFixTime: 0.75 },
    }, null);
    expect(c.shotInterval).toBeCloseTo(1);
    expect(c.magazine).toBe(10);        // ceil(100/10)
    expect(c.reloadTime).toBeCloseTo(0.75);
  });

  it('continuous fire (no heat, no regen) → unbounded magazine, no reload', () => {
    const c = getWeaponCadence(
      { Firing: [{ RoundsPerMinute: 60 }], Ammunition: { Capacity: 2000 } }, null,
    );
    expect(c.magazine).toBe(Infinity);
    expect(c.reloadTime).toBe(0);
  });

  it('no per-shot rate (beam / rpm 0) → null', () => {
    expect(getWeaponCadence({ Firing: [{}] }, null)).toBeNull();
    expect(getWeaponCadence({ Firing: [{ RoundsPerMinute: 0 }] }, null)).toBeNull();
  });
});

// ─── buildTtkOpponentProfile ────────────────────────────────────────────────

describe('buildTtkOpponentProfile', () => {
  it('adds power-plant pools from the PP item', () => {
    const op = buildTtkOpponentProfile(
      {}, null,
      { Durability: { Health: 6300, Distortion: { MaximumDamage: 17000 } } },
    );
    expect(op.powerplant.hp).toBe(6300);
    expect(op.powerplant.maxHp).toBe(6300);
    expect(op.powerplant.distortionMax).toBe(17000);
  });

  it('sums power-plant HP across all generators (ppCount)', () => {
    // Paladin-like: 3 × Maelstrom (750 hp / 6500 dist each). A round hits one
    // component at a time, so each generator has to be shot down in turn.
    const op = buildTtkOpponentProfile(
      {}, null,
      { Durability: { Health: 750, Distortion: { MaximumDamage: 6500 } } },
      1, 1, 1, 3,
    );
    expect(op.powerplant.hp).toBe(2250);
    expect(op.powerplant.maxHp).toBe(2250);
  });

  it('does NOT sum the distortion pool across generators', () => {
    // Distortion is explosive: one shot saturates every generator in the blast
    // at full value rather than splitting between them, so three generators
    // fill in the same time as one. Summing made a 2-plant Hornet Mk II read
    // 11 000 and doubled every distort-power-plant time.
    const pp = { Durability: { Health: 750, Distortion: { MaximumDamage: 6500 } } };
    const one = buildTtkOpponentProfile({}, null, pp, 1, 1, 1, 1);
    const three = buildTtkOpponentProfile({}, null, pp, 1, 1, 1, 3);
    expect(one.powerplant.distortionMax).toBe(6500);
    expect(three.powerplant.distortionMax).toBe(6500);
  });

  it('zeros power-plant pools when no PP item', () => {
    const op = buildTtkOpponentProfile({}, null, null);
    expect(op.powerplant).toEqual({
      hp: 0, maxHp: 0, distortionMax: 0,
      distortionDecayDelay: 0, distortionDecayRate: 0,
    });
  });

  it('falls back to the LARGEST Parts entry (main body) when VitalParts is empty', () => {
    // Defensive fallback: per-part HP in Parts is dominated by cosmetic pieces,
    // so kill = destroying the main body (largest part), not a small fin.
    const ship = {
      Hull: { StructureHealthPoints: { VitalParts: {}, Parts: { fin: 500, body: 918000, aileron: 1000 } } },
    };
    const op = buildTtkOpponentProfile(ship, null, null);
    expect(op.hull.smallestVitalHp).toBe(918000);
  });

  it('prefers the smallest VitalPart when populated (fastest structural kill)', () => {
    const ship = {
      Hull: { StructureHealthPoints: { VitalParts: { nose: 2350, body: 5000 }, Parts: { fin: 500 } } },
    };
    const op = buildTtkOpponentProfile(ship, null, null);
    expect(op.hull.smallestVitalHp).toBe(2350);
  });

  it('handles Parts entries shaped as { Health } objects', () => {
    const ship = {
      Hull: { StructureHealthPoints: { VitalParts: {}, Parts: { nose: { Health: 4000 }, body: { Health: 9000 } } } },
    };
    const op = buildTtkOpponentProfile(ship, null, null);
    expect(op.hull.smallestVitalHp).toBe(9000);
  });
});

// ─── simulateTtk ────────────────────────────────────────────────────────────

describe('simulateTtk - basic outcomes', () => {
  it('no weapons → all Infinity with reason', () => {
    const r = simulateTtk([], ttkOpp({ shieldHp: 100 }));
    expect(r.breakShields).toBe(Infinity);
    expect(r.reasons.breakShields).toBe('no weapons');
  });

  it('breaks shields at the expected clock time', () => {
    // 250 shield HP, 100 energy alpha/shot, 1s interval:
    // t0→150, t1→50, t2→0  ⇒ breakShields = 2
    const r = simulateTtk([grp({ energy: 100 })], ttkOpp({ shieldHp: 250 }));
    expect(r.breakShields).toBe(2);
  });

  it('kills vital once shield/armor are down', () => {
    // shield 0, armor 0, vital 100, phys 50/shot, deflection 0:
    // t0→50, t1→0 ⇒ killVital = 1
    const r = simulateTtk([grp({ phys: 50, basePen: 0 })], ttkOpp({ vitalHp: 100 }));
    expect(r.killVital).toBe(1);
  });

  it('disables power plant via penetration leak', () => {
    // shield/armor 0 → penRatio 1.0; basePen+penComponent 1 ⇒ componentDmg = alpha.
    // ppHp 200, 100/shot: t0→100, t1→0 ⇒ disablePowerplant = 1
    const r = simulateTtk(
      [grp({ phys: 100, basePen: 1 })],
      ttkOpp({ vitalHp: 999999, ppHp: 200, penComponent: 1 }),
    );
    expect(r.disablePowerplant).toBe(1);
  });

  it('energy weapons disable the power plant too (not physical-only)', () => {
    // Same as above with energy: with the shield down, energy runs the same
    // armor -> component pipeline, so a penetrating energy weapon disables the PP.
    const r = simulateTtk(
      [grp({ energy: 100, basePen: 1 })],
      ttkOpp({ vitalHp: 999999, ppHp: 200, penComponent: 1 }),
    );
    expect(r.disablePowerplant).toBe(1);
  });

  it('disables via distortion pool fill', () => {
    // shield 0 → full distortion leak = alpha. distMax 300, 100/shot:
    // t0→100, t1→200, t2→300 ⇒ disableDistortion = 2
    const r = simulateTtk(
      [grp({ dist: 100 })],
      ttkOpp({ ppHp: 1, ppDistMax: 300 }),
    );
    expect(r.disableDistortion).toBe(2);
  });
});

// ─── simulateTtk - distortion decay ─────────────────────────────────────────

describe('simulateTtk - distortion decay', () => {
  // A finite magazine forces a sync pause, which is the only place decay can
  // get a window: continuous fire lands a hit every shotInterval and each hit
  // restarts the delay, so an uninterrupted burst never decays at all.
  function burstGrp({ dist, interval = 1, magazine = 3 }) {
    return {
      className: 'TEST', name: 'Test', count: 1,
      alpha: dist, dmgByType: { phys: 0, energy: 0, dist },
      basePen: 0, sustainedDPS: dist / interval,
      cadence: { rpm: 60 / interval, shotInterval: interval, magazine, reloadTime: 0 },
    };
  }

  it('a pause shorter than the decay delay costs nothing', () => {
    // 3-shot magazine, 4 s pause, 5 s delay: the pool never bleeds, so this
    // matches the pre-decay behaviour exactly (100 per shot, 500 pool).
    const r = simulateTtk(
      [burstGrp({ dist: 100 })],
      ttkOpp({ ppHp: 1, ppDistMax: 500, ppDecayDelay: 5, ppDecayRate: 50 }),
      { pauseLen: 4 },
    );
    // Shots at t = 0, 1, 2 (pool 300), pause 2 → 6, shots at 6 and 7.
    expect(r.disableDistortion).toBe(7);
  });

  it('a pause longer than the delay bleeds the pool', () => {
    // Same fight with a 1 s delay: the pause runs 2 → 6 and decay starts 1 s
    // after the last hit, so 3 s at 50/s = 150 bleeds off. The second burst
    // opens from 150 instead of 300 and the pool needs a third burst.
    const r = simulateTtk(
      [burstGrp({ dist: 100 })],
      ttkOpp({ ppHp: 1, ppDistMax: 500, ppDecayDelay: 1, ppDecayRate: 50 }),
      { pauseLen: 4 },
    );
    expect(r.disableDistortion).toBeGreaterThan(8);
  });

  it('a single hit restarts the delay', () => {
    // The decay delay is measured from the LAST distortion hit, not from the
    // start of the pause, so one shot mid-gap resets the clock. Firing every
    // 2 s against a 3 s delay therefore never decays, even though the pool
    // would drain in 10 s if the shooting stopped.
    const r = simulateTtk(
      [grp({ dist: 100, interval: 2 })],
      ttkOpp({ ppHp: 1, ppDistMax: 500, ppDecayDelay: 3, ppDecayRate: 50 }),
    );
    expect(r.disableDistortion).toBe(8); // 5 shots at t = 0, 2, 4, 6, 8
  });

  it('names decay as the cause when it outruns the incoming fire', () => {
    // 100 per 3-shot burst against a 5 000 pool with a 1 s delay and 500/s
    // decay: every pause wipes what the burst added, so the pool never peaks.
    const r = simulateTtk(
      [burstGrp({ dist: 100 })],
      ttkOpp({ ppHp: 1, ppDistMax: 5000, ppDecayDelay: 1, ppDecayRate: 500 }),
      { pauseLen: 6 },
    );
    expect(r.disableDistortion).toBe(Infinity);
    expect(r.reasons.disableDistortion).toBe('distortion decays faster than it lands');
  });

  it('optimizeFor distortion picks a pause under the decay delay', () => {
    // Kill and soft-disable disagree: the vital part dies inside the first
    // burst at any pause (so the default target is indifferent and takes the
    // largest pause), while distortion needs the pool to survive the gaps.
    const weapons = [burstGrp({ dist: 100 }), grp({ energy: 500, basePen: 10 })];
    const opp = ttkOpp({
      vitalHp: 400, ppHp: 99999, penComponent: 1,
      ppDistMax: 500, ppDecayDelay: 1, ppDecayRate: 200,
    });
    const search = { minPause: 1, maxPause: 6, step: 1 };
    const forKill = computeOptimalPauseLen(weapons, opp, search);
    const forDist = computeOptimalPauseLen(weapons, opp, { ...search, optimizeFor: 'distortion' });
    expect(forKill).toBe(6);
    expect(forDist).toBe(1);
  });

  it('optimizeFor distortion falls back when the pool is unreachable', () => {
    // No distortion weapon at all - the option must not strand the caller
    // without a suggestion.
    const weapons = [grp({ energy: 500, basePen: 10 })];
    const opp = ttkOpp({ vitalHp: 400, ppHp: 99999, penComponent: 1, ppDistMax: 500 });
    const search = { minPause: 1, maxPause: 6, step: 1, optimizeFor: 'distortion' };
    expect(computeOptimalPauseLen(weapons, opp, search)).toBe(6);
  });

  it('no decay data (rate 0) leaves the pool permanent', () => {
    const r = simulateTtk(
      [burstGrp({ dist: 100 })],
      ttkOpp({ ppHp: 1, ppDistMax: 500 }),
      { pauseLen: 30 },
    );
    // Shots at t = 0, 1, 2, pause 2 → 32, shots at 32 and 33. Nothing bleeds
    // off across the 30 s gap when the generator ships no decay data.
    expect(r.disableDistortion).toBe(33);
  });
});

describe('simulateTtk - Infinity cases', () => {
  it('never breaks shields when alpha is fully deflected and no shield', () => {
    const r = simulateTtk([grp({ phys: 10, basePen: 0 })], ttkOpp({ vitalHp: 100, deflPhys: 9999, armorHp: 50 }));
    expect(r.breakShields).toBe(Infinity);
    expect(r.reasons.breakShields).toBe('no shield');
  });

  it('cannot kill when every shot is deflected by armor threshold', () => {
    const r = simulateTtk([grp({ phys: 10, basePen: 0 })], ttkOpp({ armorHp: 500, deflPhys: 9999, vitalHp: 100 }));
    expect(r.killVital).toBe(Infinity);
    expect(r.reasons.killVital).toBe('cannot penetrate to hull');
  });

  it('no distortion weapons → distortion disable Infinity', () => {
    const r = simulateTtk([grp({ energy: 100 })], ttkOpp({ shieldHp: 100, ppDistMax: 500 }));
    expect(r.disableDistortion).toBe(Infinity);
    expect(r.reasons.disableDistortion).toBe('no distortion weapons');
  });

  it('distortion weapon but shields never break → "shields absorb all distortion"', () => {
    // Distortion weapon present, but armor threshold deflects every post-shield
    // shot so shields never drop (no shield here) - with 100% shield distortion
    // absorption the pool can never fill. Use a live shield that can't be broken.
    const r = simulateTtk(
      [grp({ dist: 5 })],
      ttkOpp({ shieldHp: 100000, resDist: 1, absDist: 1, ppDistMax: 500 }),
    );
    expect(r.disableDistortion).toBe(Infinity);
    expect(r.reasons.disableDistortion).toBe('shields absorb all distortion');
  });
});

describe('simulateTtk - ballistic cannot fully deplete a shield', () => {
  it('pure ballistic never breaks a live shield (absorption taper asymptotes above 0)', () => {
    // Realistic physical absorption 0.45: each shot drains baseAbs x shieldFrac
    // of the mitigated alpha - an exponential decay that asymptotes above 0, so
    // the shield never reaches 0. High deflection blocks every post-shield shot,
    // so nothing penetrates either: the loadout achieves nothing.
    const r = simulateTtk(
      [grp({ phys: 100, basePen: 0 })],
      ttkOpp({ shieldHp: 1000, absPhys: 0.45, armorHp: 500, deflPhys: 9999, vitalHp: 100 }),
    );
    expect(r.breakShields).toBe(Infinity);
    expect(r.reasons.breakShields).toBe('ballistic fire can\'t fully deplete a shield');
    expect(r.killVital).toBe(Infinity);
  });

  it('penetrating ballistic kills the vital but never depletes the shield', () => {
    // The shield never empties (ballistic absorption taper), but the pass-through
    // strips the thin armor and destroys the vital. Outcomes are independent:
    // killVital is finite, breakShields stays Infinity with the MECHANICAL reason
    // (the sim no longer stops at the kill, so it's never "ship destroyed first").
    const r = simulateTtk(
      [grp({ phys: 500, basePen: 0 })],
      ttkOpp({ shieldHp: 5000, absPhys: 0.45, armorHp: 200, deflPhys: 0, vitalHp: 300 }),
    );
    expect(r.killVital).toBeLessThan(Infinity);
    expect(r.breakShields).toBe(Infinity);
    expect(r.reasons.breakShields).toBe('ballistic fire can\'t fully deplete a shield');
  });

  it('ballistic that only penetrates once the shield is low still kills (no premature give-up)', () => {
    // At full shield the pass-through (100 x (1 - 0.45) = 55) is below the 70
    // deflection threshold, so every shot is deflected. As the shield drains the
    // absorption falls and the pass-through climbs; below ~67% shield it clears
    // 70 and starts stripping armor, then the hull. breakShields stays Infinity
    // (ballistic can't fully deplete), but the kill IS reachable - the sim must
    // keep grinding the shield down, not abort while it's still high. This is the
    // F7C-M-vs-Guardian case (regression guard).
    const r = simulateTtk(
      [grp({ phys: 100, basePen: 0 })],
      ttkOpp({ shieldHp: 1000, absPhys: 0.45, deflPhys: 70, armorHp: 50, vitalHp: 50 }),
    );
    expect(r.breakShields).toBe(Infinity);
    expect(r.reasons.breakShields).toBe('ballistic fire can\'t fully deplete a shield');
    expect(r.killVital).toBeLessThan(Infinity);
  });

  it('adding an energy weapon lets the shield actually break (untapered drain)', () => {
    // Same un-penetrable target, but an energy weapon now drives the shield to
    // exactly 0 (all-or-nothing absorption, no taper) → finite break.
    const r = simulateTtk(
      [grp({ phys: 100, basePen: 0 }), grp({ energy: 100 })],
      ttkOpp({ shieldHp: 600, absPhys: 0.45, armorHp: 500, deflPhys: 9999, deflEnergy: 9999, vitalHp: 100 }),
    );
    expect(r.breakShields).toBeLessThan(Infinity);
  });

  it('ballistic + distortion releases distortion to break the shield (no energy needed)', () => {
    // No energy weapon, so holding distortion would deadlock (ballistic can't
    // deplete the shield). The sim must release distortion - its flat resistance
    // bleed (resDist 0 → 50/shot, untapered) drains the shield to 0.
    const r = simulateTtk(
      [grp({ phys: 100, basePen: 0 }), grp({ dist: 50 })],
      ttkOpp({
        shieldHp: 300, absPhys: 0.45, resDist: 0, absDist: 1,
        armorHp: 500, deflPhys: 9999, vitalHp: 999999, ppHp: 1, ppDistMax: 200,
      }),
      { distortionMode: 'hold' },
    );
    expect(r.breakShields).toBeLessThan(Infinity);
  });
});

describe('simulateTtk - power-plant reach gate (ppReach)', () => {
  // Baseline: basePen 1, penComponent 1, ppHp 200, 100/shot → disable at t=1.
  // (Same shape as the "disables power plant via penetration leak" test.)
  const leakOpp = () => ttkOpp({ vitalHp: 999999, ppHp: 200, penComponent: 1 });

  it('blocks the power-plant disable when basePen is below ppReach', () => {
    const r = simulateTtk([grp({ phys: 100, basePen: 1 })], leakOpp(), { ppReach: 2 });
    expect(r.disablePowerplant).toBe(Infinity);
    expect(r.reasons.disablePowerplant).toBe('penetration below 2 m reach');
  });

  it('allows the disable when basePen meets or exceeds ppReach', () => {
    const r = simulateTtk([grp({ phys: 100, basePen: 3 })], leakOpp(), { ppReach: 2 });
    expect(r.disablePowerplant).toBe(1);
  });

  it('ppReach 0 (off) preserves the ungated behavior', () => {
    const r = simulateTtk([grp({ phys: 100, basePen: 1 })], leakOpp(), { ppReach: 0 });
    expect(r.disablePowerplant).toBe(1);
  });

  it('does NOT gate the vital kill - a shallow weapon still destroys the vital part', () => {
    // basePen 1 well below ppReach 5, but the kill goes through hull damage,
    // which the reach gate must not touch (only the power-plant outcomes are).
    const r = simulateTtk(
      [grp({ phys: 100, basePen: 1 })],
      ttkOpp({ vitalHp: 100, ppHp: 999999, penComponent: 1 }),
      { ppReach: 5 },
    );
    expect(r.killVital).not.toBe(Infinity);
  });

  it('does NOT gate distortion - basePen 0 (PTU 4.9 shape) still fills the pool', () => {
    // PTU 4.9 zeroed BasePenetrationDistance on every distortion weapon, yet
    // distortion still disables when the shot lands on the component section.
    // Reach is aim-based (ideal aim assumed), so ppReach must not block it.
    const r = simulateTtk(
      [grp({ dist: 100, basePen: 0 })],
      ttkOpp({ ppHp: 1, ppDistMax: 300, vitalHp: 999999 }),
      { ppReach: 5 },
    );
    expect(r.disableDistortion).toBe(2); // 300 pool / 100 per shot -> 3rd shot at t=2
  });

  it('does NOT gate distortion - basePen below ppReach is irrelevant', () => {
    const r = simulateTtk(
      [grp({ dist: 100, basePen: 1 })],
      ttkOpp({ ppHp: 1, ppDistMax: 300, vitalHp: 999999 }),
      { ppReach: 5 },
    );
    expect(r.disableDistortion).not.toBe(Infinity);
  });
});

describe('simulateTtk - distortion fire policy', () => {
  it('hold mode keeps the distortion pool empty until the shield breaks', () => {
    // Energy breaks a 200-hp shield in 4 shots (t=3). With hold mode the
    // distortion weapon is holstered until then, so disableDistortion lands
    // strictly AFTER the shield break - never during the shield-up phase.
    const energy = grp({ energy: 50, interval: 1 });
    const dist = grp({ dist: 100, interval: 1 });
    const r = simulateTtk(
      [energy, dist],
      ttkOpp({ shieldHp: 200, absDist: 1, ppHp: 1, ppDistMax: 200 }),
      { distortionMode: 'hold' },
    );
    expect(r.breakShields).toBeLessThan(Infinity);
    expect(r.disableDistortion).toBeGreaterThanOrEqual(r.breakShields);
  });

  it('both policies reach the distortion disable (mode is honored, not stuck)', () => {
    const mk = () => [grp({ energy: 50, interval: 1 }), grp({ dist: 100, interval: 1 })];
    const op = () => ttkOpp({ shieldHp: 200, absDist: 1, ppHp: 1, ppDistMax: 200 });
    const hold = simulateTtk(mk(), op(), { distortionMode: 'hold' });
    const always = simulateTtk(mk(), op(), { distortionMode: 'always' });
    expect(hold.disableDistortion).toBeLessThan(Infinity);
    expect(always.disableDistortion).toBeLessThan(Infinity);
  });

  it('distortion fire suppresses shield regen (pool fills despite a regenerating shield)', () => {
    // After the shield breaks, only distortion keeps firing. A high regen rate
    // with a short delay would normally let the shield climb back and re-absorb
    // distortion - but distortion now resets the regen timer, so the pool fills.
    const breaker = grp({ energy: 200, interval: 1 });   // breaks 150-hp shield in 1 shot
    const dist = grp({ dist: 60, interval: 0.5 });        // fires faster than damagedDelay
    const op = ttkOpp({ shieldHp: 150, absDist: 1, ppHp: 1, ppDistMax: 240 });
    op.shield.regenRate = 1000; op.shield.damagedDelay = 1; op.shield.downedDelay = 0;
    const r = simulateTtk([breaker, dist], op, { pauseLen: 1 });
    expect(r.disableDistortion).toBeLessThan(Infinity);
  });
});

describe('simulateTtk - defensive-state snapshot', () => {
  it('records shield 0% with armor still full at a clean break (energy, shield-first)', () => {
    // Energy 100/shot, shield 300 breaks in exactly 3 shots with NO overflow
    // (the third shot's 100 mitigated exactly drains the last 100 of shield), so
    // armor is untouched at the break instant. Energy is shield-first: nothing
    // reaches armor while the shield is up.
    const r = simulateTtk([grp({ energy: 100 })], ttkOpp({ shieldHp: 300, armorHp: 80, vitalHp: 50, deflEnergy: 0 }));
    expect(r.breakShields).toBe(2);
    expect(r.snapshot.breakShields.shieldPct).toBe(0);
    expect(r.snapshot.breakShields.armorPct).toBe(1);
  });

  it('records shield + armor both gone at the vital kill', () => {
    const r = simulateTtk([grp({ energy: 100 })], ttkOpp({ shieldHp: 300, armorHp: 80, vitalHp: 50, deflEnergy: 0 }));
    expect(r.killVital).not.toBe(Infinity);
    expect(r.snapshot.killVital.shieldPct).toBe(0);
    expect(r.snapshot.killVital.armorPct).toBe(0);
  });

  it('distortion only accumulates after shields drop (100% shield distortion absorption)', () => {
    // Realistic shield: absDist = 1, so distortion does ZERO through a live
    // shield - the pool can only fill once the shield is gone. Distortion
    // 100/shot, shield 200 (breaks in 2 shots), pool max 200 (fills in 2 more).
    // The disable therefore always lands with the shield already at 0%.
    const r = simulateTtk(
      [grp({ dist: 100 })],
      ttkOpp({ shieldHp: 200, resDist: 0, absDist: 1, ppHp: 1, ppDistMax: 200 }),
    );
    expect(r.disableDistortion).not.toBe(Infinity);
    expect(r.snapshot.disableDistortion.shieldPct).toBe(0);
  });

  it('leaves snapshot null for outcomes never reached', () => {
    const r = simulateTtk([grp({ energy: 100 })], ttkOpp({ shieldHp: 100, ppDistMax: 500 }));
    expect(r.disableDistortion).toBe(Infinity);
    expect(r.snapshot.disableDistortion).toBeNull();
  });
});

describe('simulateTtk - combined cadence', () => {
  it('two groups break shields faster than either alone', () => {
    const fast = grp({ energy: 50, interval: 1 });
    const slow = grp({ energy: 50, interval: 2 });
    const op = () => ttkOpp({ shieldHp: 300 });
    const both = simulateTtk([fast, slow], op()).breakShields;
    const onlyFast = simulateTtk([fast], op()).breakShields;
    expect(both).toBeLessThan(onlyFast);
  });
});

describe('totalSustainedDPS', () => {
  it('count-weights per-group sustained DPS', () => {
    expect(totalSustainedDPS([{ sustainedDPS: 100, count: 4 }, { sustainedDPS: 50, count: 2 }])).toBe(500);
  });
});

// ─── classifyTurretWeapon ───────────────────────────────────────────────────

describe('classifyTurretWeapon', () => {
  it('flags PDC turrets regardless of weapon (they auto-target missiles/craft)', () => {
    // M2C "Swarm" is an S1 energy PDC laser - category drives the verdict.
    expect(classifyTurretWeapon('PDC Turret', 1, { energy: 10 })).toBe('pdc');
    // category wins even for a would-be combat weapon
    expect(classifyTurretWeapon('PDC Turret', 4, { phys: 65 })).toBe('pdc');
  });

  it('flags bespoke S1 ballistic gatlings as anti-personnel (e.g. YellowJacket)', () => {
    expect(classifyTurretWeapon('Manned Turret', 1, { phys: 7.56 })).toBe('antipersonnel');
  });

  it('keeps real gunner turrets as combat', () => {
    // S4 energy repeater on a manned turret (e.g. Asgard / Constellation)
    expect(classifyTurretWeapon('Manned Turret', 4, { energy: 65.43 })).toBe('combat');
    // an S1 ENERGY gun on a normal turret is not anti-personnel (only ballistic is)
    expect(classifyTurretWeapon('Manned Turret', 1, { energy: 12 })).toBe('combat');
    // an S2 ballistic gun is too big to be a door gun
    expect(classifyTurretWeapon('Remote Turret (Crew)', 2, { phys: 30 })).toBe('combat');
    // a mixed phys+energy S1 is not the pure-ballistic anti-personnel signature
    expect(classifyTurretWeapon('Manned Turret', 1, { phys: 5, energy: 5 })).toBe('combat');
  });
});

// ─── simulateTtk - synchronized pause cycle ────────────────────────────────

/**
 * Build a "finite-magazine" group: a weapon that empties after `magazine` shots
 * and reloads in `reloadTime` seconds. Used to exercise the dictator / synced-
 * pause path that continuous-fire groups (the default in grp()) bypass.
 */
function magGrp({ phys = 0, energy = 0, dist = 0, count = 1, interval = 1, magazine = 5, reloadTime = 3, basePen = 0 }) {
  return {
    className: 'TEST_MAG', name: 'TestMag', count,
    alpha: phys + energy + dist,
    dmgByType: { phys, energy, dist },
    basePen, sustainedDPS: (phys + energy + dist) / interval,
    cadence: { rpm: 60 / interval, shotInterval: interval, magazine, reloadTime },
  };
}

describe('simulateTtk - synchronized pause', () => {
  it('finite-magazine weapon alone becomes its own dictator and pauses correctly', () => {
    // 5-shot mag, 1s interval. 5×100 = 500 dmg before pause, pause 4s, then mag refills.
    // Shield 1000: needs 10 shots total = 2 full cycles. 1st cycle finishes at t=4
    // (shots at t=0..4), pause 4s → 2nd cycle starts at t=8, shots at t=8..12.
    // Shield breaks on 10th shot at t=12.
    const w = magGrp({ energy: 100, magazine: 5, reloadTime: 99, interval: 1 });
    const r = simulateTtk([w], ttkOpp({ shieldHp: 1000 }), { pauseLen: 4 });
    expect(r.breakShields).toBe(12);
  });

  it('longer synced pause delays the kill (sync rhythm shapes the clock)', () => {
    // Same finite-only loadout, two pause lengths. The longer pause directly
    // extends each cycle's wall-clock duration, so the same total damage takes
    // proportionally longer to land.
    const w = () => magGrp({ energy: 50, magazine: 3, reloadTime: 99, interval: 1 });
    const op = () => ttkOpp({ shieldHp: 600 });
    const fast = simulateTtk([w()], op(), { pauseLen: 2 });
    const slow = simulateTtk([w()], op(), { pauseLen: 10 });
    // 600 / 150-per-cycle = 4 cycles. Each cycle = 3s fire + pauseLen pause.
    // fast: 4*(3+2)-1 = 14s? Trace: t=0,1,2 → pause to 5 → 5,6,7 → pause to 10 → ...
    // Just compare magnitudes - the cycles are real so slow >> fast.
    expect(fast.breakShields).toBeLessThan(slow.breakShields);
    expect(slow.breakShields).toBeGreaterThan(fast.breakShields + 20);
  });

  it('continuous-fire weapons never trigger a pause', () => {
    // grp() default is continuous-fire (magazine Infinity). No dictator, no synced pause.
    // Behavior should match the original ideal-mode tests exactly.
    const w = grp({ energy: 100 });
    const r = simulateTtk([w], ttkOpp({ shieldHp: 250 }));
    expect(r.breakShields).toBe(2);
  });

  it('mixing one continuous + one finite: finite group is the dictator', () => {
    // Continuous laser at 1s + finite energy weapon with 2-shot mag at 1s.
    // Dictator = the finite one. Synced pause affects BOTH groups.
    // Cycle 1: t=0 both fire (50+50=100), t=1 both fire (+100=200), fin empties → pause to t=4.
    // Cycle 2: t=4 both fire (+100=300), t=5 both fire (+100=400), pause to t=8.
    // Cycle 3: t=8 both fire (+100=500). Shield 500 breaks at t=8.
    const inf = grp({ energy: 50, interval: 1 });               // continuous
    const fin = magGrp({ energy: 50, magazine: 2, reloadTime: 99, interval: 1 });
    const r = simulateTtk([inf, fin], ttkOpp({ shieldHp: 500 }), { pauseLen: 3 });
    expect(r.breakShields).toBe(8);
  });
});

// ─── simulateTtk - enemy shield regen ───────────────────────────────────────

describe('simulateTtk - shield regen', () => {
  function regenOpp({ shieldHp, regenRate, damagedDelay, downedDelay = 0 }) {
    const o = ttkOpp({ shieldHp });
    o.shield.regenRate = regenRate;
    o.shield.damagedDelay = damagedDelay;
    o.shield.downedDelay = downedDelay;
    return o;
  }

  it('regen is zero between consecutive damage events inside damagedDelay', () => {
    // Damage every 1s, damagedDelay 4s → shield never gets to regen.
    // Shield 200, 50/shot, 1s interval. Without regen breaks at t=3 (4 shots: 200→0).
    // Actually shield 200: t0→150, t1→100, t2→50, t3→0 = 3.
    const r = simulateTtk(
      [grp({ energy: 50, interval: 1 })],
      regenOpp({ shieldHp: 200, regenRate: 100, damagedDelay: 4 }),
    );
    expect(r.breakShields).toBe(3);
  });

  it('long synced pause past damagedDelay lets shield regen', () => {
    // 2-shot mag, 1s interval, 10s synced pause. damagedDelay 1s, regen 1000/s.
    // Cycle 1: t=0 fire (shield 200-50=150), t=1 fire (-50=100). Pause to t=11.
    //   Inter-event integration on next event at t=11 includes regen.
    //   Window: regenStart = lastDmgT + delay = 1 + 1 = 2. tNow = 11. tPrev = 1.
    //   Regen window = 11 - max(1, 2) = 9s. Regen = 1000 * 9 = 9000, clamped at 200. Full.
    // After regen: shield 200. Cycle 2: t=11 fire (150), t=12 fire (100). Pause to t=22. Regen to full.
    // Cycle never makes progress past 200-2*50=100 because regen always recovers.
    // Result: breakShields = Infinity.
    const r = simulateTtk(
      [magGrp({ energy: 50, magazine: 2, reloadTime: 99, interval: 1 })],
      regenOpp({ shieldHp: 200, regenRate: 1000, damagedDelay: 1 }),
      { pauseLen: 10 },
    );
    expect(r.breakShields).toBe(Infinity);
  });

  it('short synced pause inside damagedDelay prevents regen', () => {
    // Same loadout, but pauseLen=0.5 < damagedDelay 1s. Regen never starts.
    // Cycle: t=0 fire (-50), t=1 fire (-50). Pause 0.5s to t=1.5. Cycle 2: t=1.5 (-50), t=2.5 (-50).
    // Pause to t=3. Cycle 3: t=3 (-50). Shield 200 broken at 4 shots, but the last shot
    // here lands at t=3. Need exact integer-clock check: shield damage 4×50 = 200.
    const r = simulateTtk(
      [magGrp({ energy: 50, magazine: 2, reloadTime: 99, interval: 1 })],
      regenOpp({ shieldHp: 200, regenRate: 1000, damagedDelay: 1 }),
      { pauseLen: 0.5 },
    );
    expect(r.breakShields).not.toBe(Infinity);
    expect(r.breakShields).toBeLessThan(5); // breaks quickly
  });

  it('zero regen rate → shield breaks regardless of pause length', () => {
    // With regen=0, longer pauses still produce a finite break time (since
    // shield can't recover). The wall-clock time differs because cycles take
    // longer, but the OUTCOME holds: both finite, longer-pause is later.
    const w = () => magGrp({ energy: 50, magazine: 2, reloadTime: 99, interval: 1 });
    const r1 = simulateTtk([w()], regenOpp({ shieldHp: 200, regenRate: 0, damagedDelay: 1 }), { pauseLen: 0.5 });
    const r2 = simulateTtk([w()], regenOpp({ shieldHp: 200, regenRate: 0, damagedDelay: 1 }), { pauseLen: 10 });
    expect(r1.breakShields).toBeLessThan(Infinity);
    expect(r2.breakShields).toBeLessThan(Infinity);
    expect(r1.breakShields).toBeLessThan(r2.breakShields);
  });

  it('stable cycle (pause fully regens shield) terminates fast, no HARD_CAP grind', () => {
    // Burst removes 100 (2×50), pause (10s > damagedDelay 1s) fully regens the
    // 200-hp shield back to max. Every cycle is identical → no outcome ever
    // resolves. The stable-cycle detector must stop after ~2 cycles instead of
    // grinding to HARD_CAP. Without it, totalCycles would be in the thousands.
    const w = magGrp({ energy: 50, magazine: 2, reloadTime: 99, interval: 1 });
    const r = simulateTtk([w], regenOpp({ shieldHp: 200, regenRate: 10000, damagedDelay: 1 }), { pauseLen: 10 });
    expect(r.breakShields).toBe(Infinity);
    expect(r.totalCycles).toBeLessThanOrEqual(3);
  });
});

// ─── simulateTtk - per-weapon physical state across pauses ─────────────────

describe('simulateTtk - per-weapon state', () => {
  it('synced-pause cycles deliver consistent damage across multiple cycles', () => {
    // Energy weapon (so shield is hit), 2-shot mag, 1s interval, pauseLen 5s.
    // Cycle pattern: 2 shots × 100 = 200 dmg, then 5s wait. Each cycle is 6s wall.
    // Shield 1000 / 200 = 5 cycles. Cycle starts: 0, 6, 12, 18, 24.
    // 5th cycle: shots at t=24, t=25. 10th shot breaks shield at t=25.
    const w = {
      className: 'ENE', name: 'Ene', count: 1,
      alpha: 100, dmgByType: { phys: 0, energy: 100, dist: 0 }, basePen: 0,
      sustainedDPS: 50,
      cadence: { rpm: 60, shotInterval: 1, magazine: 2, reloadTime: 99 },
      heatParams: null,
      consumption: { MaxAmmo: 2, MaxRegenPerSec: 10, Cooldown: 0 },
    };
    const r = simulateTtk([w], ttkOpp({ shieldHp: 1000 }), { pauseLen: 5 });
    expect(r.breakShields).toBe(25);
  });
});

// ─── simulateTtk - residual pool carries over (CF Badger regression) ───────

describe('simulateTtk - residual pool', () => {
  // Mirrors the CF Badger scenario the user walked through: a high-fire-rate
  // energy weapon empties its pool in ~6s, then short pauses only refill
  // partially. The fix here is that the SECOND burst fires only what regen
  // brought back (not a full magazine refill on sync pause), and subsequent
  // bursts ALSO carry over residual without re-triggering the post-empty
  // cooldown. Without the fix, every cycle delivers the full-magazine damage
  // and TTK collapses by ~60%.
  it('CF-Badger-like: second burst fires only the regened ammo', () => {
    const w = {
      className: 'BADGER', name: 'Badger', count: 1,
      alpha: 100, dmgByType: { phys: 0, energy: 100, dist: 0 }, basePen: 0,
      sustainedDPS: 0,
      // 750 rpm-ish, mag 10 (small for fast test), 5/s regen, 1s cooldown.
      cadence: { rpm: 60, shotInterval: 1, magazine: 10, reloadTime: 3 },
      heatParams: null,
      consumption: { MaxAmmo: 10, MaxRegenPerSec: 5, Cooldown: 1 },
    };
    // Pause = 2s. After burst 1 empties at t=9 (10 shots at t=0..9, pool=0,
    // cooldown until t=10), pause to t=11. Regen window = 11 - 10 = 1s × 5
    // = 5 shots in pool. Burst 2 fires 5 events (t=11..15), pool=0 again at
    // t=15 (full empty, cooldown re-triggers).
    // Shield 1500: burst 1 = 1000, burst 2 = 500 → break at burst 2's 5th shot.
    const r = simulateTtk([w], ttkOpp({ shieldHp: 1500 }), { pauseLen: 2 });
    // Burst 1 ends at t=9 (1000 dmg). Sync to t=11. Burst 2 events at 11,12,13,14,15.
    // Cumulative after 5 burst-2 events: 1500 → shield breaks at t=15.
    expect(r.breakShields).toBe(15);
  });

  it('full-magazine refill on every cycle would be wrong (~3x faster)', () => {
    // Same setup but assert the floor of the OLD bug behavior: if magLeft were
    // fully reset each sync pause, burst 2 would fire 10 events again, breaking
    // shield at t=13. The new model breaks at t=15. Lock this delta in.
    const w = {
      className: 'BADGER', name: 'Badger', count: 1,
      alpha: 100, dmgByType: { phys: 0, energy: 100, dist: 0 }, basePen: 0,
      sustainedDPS: 0,
      cadence: { rpm: 60, shotInterval: 1, magazine: 10, reloadTime: 3 },
      heatParams: null,
      consumption: { MaxAmmo: 10, MaxRegenPerSec: 5, Cooldown: 1 },
    };
    // With shield 3000: burst 1 (1000), burst 2 NEW (500), then 5 events per
    // cycle thereafter. Old bug would have delivered 1000 every cycle and broken
    // shield at ~22s (3 cycles of 1000 × ~7s/cycle). New must take noticeably
    // longer because subsequent bursts deliver only 500.
    const r = simulateTtk([w], ttkOpp({ shieldHp: 3000 }), { pauseLen: 2 });
    expect(r.breakShields).toBeLessThan(Infinity);
    expect(r.breakShields).toBeGreaterThan(20);
  });
});

// ─── default pause ──────────────────────────────────────────────────────────

describe('simulateTtk - default pauseLen', () => {
  it('uses DEFAULT_PAUSE_LEN when option omitted', () => {
    // Same setup as the "finite-magazine alone" test but no pauseLen option.
    // DEFAULT_PAUSE_LEN is 3s, so cycles are 4s + 3s = 7s long? No - shots at
    // t=0..4 (5 shots), pause 3s → next cycle starts at t=8. 10 shots needed for
    // shield 1000. 10th shot at t=8+4=12. Wait same result either way... let me
    // check the math: pauseLen 4 → t=12, pauseLen 3 → t=11.
    // Cycle 1 last shot at t=4, pause to t=4+pauseLen, cycle 2 first shot at that t.
    // Cycle 2 last shot at t_start_2 + 4. With pauseLen 3: t_start_2 = 7, last shot 11.
    const w = magGrp({ energy: 100, magazine: 5, reloadTime: 99, interval: 1 });
    const r = simulateTtk([w], ttkOpp({ shieldHp: 1000 })); // no pauseLen → default 3
    expect(r.breakShields).toBe(11);
  });
});

// ─── optimal pause prefers the largest tie ──────────────────────────────────

describe('computeOptimalPauseLen - largest pause when cooldown is irrelevant', () => {
  it('picks the LARGEST pause when the kill lands in the first burst (pause never fires)', () => {
    // Kills in ~2 shots, well within a 50-shot magazine, so no sync pause ever
    // fires - every pause yields the identical kill time. Prefer the most
    // forgiving (max) pause: easier for a human than a tight rhythm, no TTK cost.
    const w = magGrp({ energy: 100, magazine: 50, reloadTime: 99, interval: 1 });
    const op = ttkOpp({ shieldHp: 100, armorHp: 0, vitalHp: 100 });
    const p = computeOptimalPauseLen([w], op, { minPause: 1, maxPause: 8, step: 1 });
    expect(p).toBe(8);
  });

  it('still picks the genuine optimum when cooldown DOES matter (multi-cycle)', () => {
    // 5-shot mag breaks a 1000-hp shield in 10 shots = 2 bursts. With no regen a
    // longer pause only delays the break, so the smallest pause is fastest and
    // must win (the largest-tie rule must not override a real difference).
    const w = magGrp({ energy: 100, magazine: 5, reloadTime: 99, interval: 1 });
    const op = ttkOpp({ shieldHp: 1000, armorHp: 0, vitalHp: 0 });
    const p = computeOptimalPauseLen([w], op, { minPause: 1, maxPause: 8, step: 1 });
    expect(p).toBe(1);
  });

  it('caps the pause strictly below the shield regen onset', () => {
    // First-burst shield break (pause-irrelevant to TTK), but the shield starts
    // regenerating at DamagedDelay 3s - the suggestion must stay below it so a
    // late shot never lets the shield recover.
    const w = magGrp({ energy: 100, magazine: 50, reloadTime: 99, interval: 1 });
    const op = ttkOpp({ shieldHp: 200, armorHp: 0, vitalHp: 0 });
    op.shield.regenRate = 1000; op.shield.damagedDelay = 3;
    const p = computeOptimalPauseLen([w], op, { minPause: 0.5, maxPause: 8, step: 0.5 });
    expect(p).toBeLessThan(3);
    expect(p).toBe(2.5); // largest 0.5-step strictly below 3
  });

  it('caps the pause at the fastest gun reload-to-100% (energy pool refill)', () => {
    // First-burst break (pause-irrelevant), no regen. Fast gun refills its 20-ammo
    // pool in 2s (10/s); slow gun needs 10s (2/s). The pause must not exceed 2s.
    const mk = (regen) => ({
      className: 'w', name: 'w', count: 1, alpha: 100, dmgByType: { phys: 0, energy: 100, dist: 0 },
      basePen: 0, sustainedDPS: 100, cadence: { rpm: 60, shotInterval: 1, magazine: 50, reloadTime: 1 },
      consumption: { MaxAmmo: 20, MaxRegenPerSec: regen, Cooldown: 0 }, heatParams: null,
    });
    const op = ttkOpp({ shieldHp: 200, armorHp: 0, vitalHp: 0 });
    const p = computeOptimalPauseLen([mk(10), mk(2)], op, { minPause: 0.5, maxPause: 8, step: 0.5 });
    expect(p).toBe(2); // fast gun: 20 / 10 = 2s
  });

  it('caps a ballistic gun at its cool-down time, NOT OverheatFixTime', () => {
    // First-burst kill (no shield), so pause is TTK-irrelevant. The ballistic gun
    // cools 100 heat at 25/s after a 0.5s delay -> 4.5s to fully cool. The 9s
    // OverheatFixTime lockout must NOT be used (we stop before overheat), so the
    // cap is 4.5s.
    const gat = {
      className: 'gat', name: 'gat', count: 1, alpha: 100, dmgByType: { phys: 100, energy: 0, dist: 0 },
      basePen: 0.5, sustainedDPS: 1000, cadence: { rpm: 600, shotInterval: 0.1, magazine: 200, reloadTime: 9 },
      consumption: null,
      heatParams: { HeatPerShot: 0.5, OverheatTemp: 100, MinTemp: 0, CoolingPerSecond: 25, TimeTillCoolingStarts: 0.5, OverheatFixTime: 9 },
    };
    const op = ttkOpp({ shieldHp: 0, armorHp: 50, vitalHp: 50, deflPhys: 0 });
    const p = computeOptimalPauseLen([gat], op, { minPause: 0.5, maxPause: 8, step: 0.5 });
    expect(p).toBe(4.5); // (100 - 0) / 25 + 0.5 = 4.5, not the 9s OverheatFixTime
  });
});

// ─── independent outcomes (sim does not stop at the hull kill) ───────────────

describe('simulateTtk - outcomes are independent of the hull kill', () => {
  it('reports a distortion soft-disable that lands AFTER the vital kill', () => {
    // Energy destroys the vital almost immediately; distortion (held until the
    // shield drops) needs longer to fill the PP distortion pool. The sim no
    // longer stops at the kill, so disableDistortion gets its real time instead
    // of Infinity 'ship destroyed first'. Distortion damages the plant once the
    // shield is down (aim-based reach), so its time is meaningful past the kill.
    const energy = grp({ energy: 100, interval: 1 });
    const dist = grp({ dist: 50, interval: 1, basePen: 5 });
    const r = simulateTtk(
      [energy, dist],
      ttkOpp({ shieldHp: 100, armorHp: 0, vitalHp: 100, resDist: 0, absDist: 1, ppHp: 1, ppDistMax: 500 }),
      { distortionMode: 'hold' },
    );
    expect(r.killVital).toBeLessThan(Infinity);
    expect(r.disableDistortion).toBeLessThan(Infinity);
    // It genuinely resolves later than the kill - the whole point of the change.
    expect(r.disableDistortion).toBeGreaterThan(r.killVital);
  });

  it('distortion soft-disable resolves past the kill even when ppReach gates physical damage', () => {
    // ppReach 5 with distortion basePen 1: the reach gate applies to PHYSICAL
    // component damage only - distortion reach is aim-based (PTU 4.9 zeroed
    // distortion penetration), so the pool still fills after the shield drops,
    // resolving on its own timeline past the vital kill.
    const energy = grp({ energy: 100, interval: 1 });
    const dist = grp({ dist: 50, interval: 1, basePen: 1 });
    const r = simulateTtk(
      [energy, dist],
      ttkOpp({ shieldHp: 100, armorHp: 0, vitalHp: 100, resDist: 0, absDist: 1, ppHp: 1, ppDistMax: 500 }),
      { distortionMode: 'hold', ppReach: 5 },
    );
    expect(r.killVital).toBeLessThan(Infinity);
    expect(r.disableDistortion).toBeLessThan(Infinity);
    expect(r.disableDistortion).toBeGreaterThan(r.killVital);
  });
});

// ─── stray HeatPerShot without OverheatTemp ─────────────────────────────────

describe('simulateTtk - heat only gates with a real OverheatTemp', () => {
  // An energy repeater (MaxAmmo pool) that carries a stray Firing.HeatPerShot
  // but NO OverheatTemp - e.g. HRST_LaserRepeater_S3 (HeatPerShot 1800). It is
  // capacitor-limited, not heat-limited: the sim must fire a full energy burst,
  // not "overheat" against the default 100 cap after a single shot (which
  // collapsed the whole loadout's burst to 0s - the F7C-M Attrition bug).
  function strayHeatGrp() {
    return {
      className: 'HRST_LaserRepeater_S3', name: 'Attrition-3', count: 1,
      alpha: 100, dmgByType: { phys: 0, energy: 100, dist: 0 }, basePen: 0,
      sustainedDPS: 100 * 350 / 60,
      cadence: { rpm: 350, shotInterval: 60 / 350, magazine: 75, reloadTime: 5.75 },
      consumption: { MaxAmmo: 75, MaxRegenPerSec: 15, Cooldown: 0.75 },
      heatParams: { HeatPerShot: 1800, CoolingPerSecond: 0 }, // no OverheatTemp
    };
  }

  it('fires a sustained burst instead of overheating after one shot', () => {
    // Shield 5000, energy 100/shot, absorption 1: 50 shots to break - well
    // within the 75-shot pool, so it resolves inside the FIRST burst with no
    // synced pauses. (deflEnergy 9999 stops progress once shields drop so the
    // sim terminates cleanly.)
    const r = simulateTtk(
      [strayHeatGrp()],
      ttkOpp({ shieldHp: 5000, armorHp: 200, deflEnergy: 9999 }),
      { pauseLen: 0.8, captureLog: true },
    );
    expect(r.breakShields).toBeLessThan(Infinity);
    // The bug ended the burst after 1 shot -> ~50 single-shot synced cycles.
    // Fixed: the shield breaks within the initial burst (cycle 1, no pauses).
    expect(r.cyclesAt.breakShields).toBeLessThanOrEqual(2);
    const firstBurstShots = r.shotLog.filter(s => s.cycle === 1).length;
    expect(firstBurstShots).toBeGreaterThan(10);
  });
});

// ─── stable-cycle latch regression ───────────────────────────────────────────

describe('simulateTtk - stable-cycle flag is not latched', () => {
  // A transient stable pause early on (a 0-duration recovery pause whose state
  // matches the prior one) must NOT latch the stable-cycle flag and truncate a
  // later cycle that makes large progress. Before the fix, this energy + held-
  // distortion loadout reported killVital = Infinity at short pauses, even
  // though the energy weapons clearly strip the armour and kill the hull.
  function rep({ name, count, dmgType, dmg, cooldown, heatPerShot = 0, basePen = 0.42 }) {
    const w = {
      Firing: [{ RoundsPerMinute: 350, HeatPerShot: heatPerShot, DamagePerShot: { [dmgType]: dmg } }],
      Consumption: { MaxAmmo: 75, MaxRegenPerSec: 15, Cooldown: cooldown },
      Ammunition: { Penetration: { BasePenetrationDistance: basePen } }, HeatParameters: { LockOnOverheat: false },
    };
    const dt = { phys: 0, energy: 0, dist: 0 }; dt[dmgType === 'Energy' ? 'energy' : 'dist'] = dmg;
    return {
      className: name, name, count, alpha: dmg, dmgByType: dt, basePen, sustainedDPS: dmg * 350 / 60,
      cadence: getWeaponCadence(w, w.Consumption),
      heatParams: { ...w.HeatParameters, HeatPerShot: heatPerShot }, consumption: w.Consumption,
    };
  }
  function guardianish() {
    return {
      shield: { hp: 21120, maxHp: 21120, faceCount: 1, totalHp: 21120, resistance: { phys: 0.25, energy: 0, dist: 0.95 },
        absorption: { phys: 0.45, energy: 1, dist: 1 }, damagedDelay: 6.33, downedDelay: 12.7, regenRate: 2006 },
      armor: { hp: 10800, maxHp: 10800, threshold: { phys: 54, energy: 40, dist: 0 }, durabilityMult: { phys: 1, energy: 1, dist: 1 } },
      hull: { damageMult: { phys: 1, energy: 1, dist: 1 }, penetration: { fuse: 1, component: 0.3 }, vitalParts: {}, smallestVitalHp: 8100 },
      powerplant: { hp: 750, maxHp: 750, distortionMax: 6500 },
    };
  }
  it('energy + held distortion completes the hull kill at a short pause', () => {
    const groups = [
      rep({ name: 'dist', count: 2, dmgType: 'Distortion', dmg: 25.7, cooldown: 0.75 }),
      rep({ name: 'a4', count: 1, dmgType: 'Energy', dmg: 100, cooldown: 0.764 }),
      rep({ name: 'a3', count: 2, dmgType: 'Energy', dmg: 86, cooldown: 0.727, heatPerShot: 1800 }),
    ];
    const r = simulateTtk(groups, guardianish(), { pauseLen: 0.8, distortionMode: 'hold' });
    expect(r.breakArmor).toBeLessThan(Infinity);
    expect(r.killVital).toBeLessThan(Infinity);
  });
});
