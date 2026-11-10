/**
 * Tests for sustained.js helpers - currently focused on `computeBurstDPS`.
 *
 * Coverage:
 *  1. Non-burst weapon (no BurstRoundsPerMinute) - falls back to
 *     `DamagePerSecond` so the displayed number matches what we showed
 *     before the burst-RPM extractor change
 *  2. Burst-fire weapon (BurstRoundsPerMinute present) - uses
 *     `alpha × burstRPM / 60`, matches the Erkul/SPViewer convention
 *  3. Beam (no DamagePerShot) - falls back to `DamagePerSecond` directly
 *  4. Missing firing block / empty inputs - safe zero return
 *  5. Multi-damage-type alpha is summed across keys
 */

import { describe, it, expect } from 'vitest';
import { computeBurstDPS, classifyFiringMode, fullRecoveryTime, getWeaponCadence } from '../js/sustained.js';

describe('computeBurstDPS', () => {
  it('falls back to DamagePerSecond when BurstRoundsPerMinute is absent', () => {
    // Plain Cannon: no burst-fire pattern. Pre-burst-RPM extractor data
    // looked exactly like this - the helper must preserve those numbers.
    const firing = {
      RoundsPerMinute: 150,
      DamagePerShot: { Energy: 97.2 },
      DamagePerSecond: { Energy: 243.0 },
    };
    expect(computeBurstDPS(firing)).toBeCloseTo(243.0, 4);
  });

  it('uses BurstRoundsPerMinute × alpha / 60 when present (Echion-style)', () => {
    // Echion Repeater: 3-shot burst. Sustained 526.83 RPM (834 DPS),
    // inner burst 800 RPM → 1266.67 burst DPS.
    const firing = {
      RoundsPerMinute: 526.83,
      BurstRoundsPerMinute: 800,
      ShotPerAction: 3,
      DamagePerShot: { Energy: 95 },
      DamagePerSecond: { Energy: 834.15 },
    };
    expect(computeBurstDPS(firing)).toBeCloseTo(1266.67, 1);
  });

  it('sums alpha across multiple damage types', () => {
    // Hypothetical mixed-damage burst weapon - make sure the helper
    // doesn't drop Physical/Distortion etc.
    const firing = {
      BurstRoundsPerMinute: 600,
      DamagePerShot: { Energy: 40, Physical: 60 },
      DamagePerSecond: { Energy: 200, Physical: 300 },
    };
    // (40 + 60) × 600 / 60 = 1000
    expect(computeBurstDPS(firing)).toBeCloseTo(1000, 4);
  });

  it('falls back for beams (no DamagePerShot, RPM = 0)', () => {
    // Beam weapon: DamagePerSecond comes from the Beam block, RPM is 0
    // and DamagePerShot is absent. Falls through to the DPS sum.
    const firing = {
      RoundsPerMinute: 0,
      FireType: 'beam',
      DamagePerSecond: { Energy: 15000 },
    };
    expect(computeBurstDPS(firing)).toBeCloseTo(15000, 4);
  });

  it('returns 0 for missing or empty input', () => {
    expect(computeBurstDPS(null)).toBe(0);
    expect(computeBurstDPS(undefined)).toBe(0);
    expect(computeBurstDPS({})).toBe(0);
  });

  it('falls back when BurstRoundsPerMinute is present but DamagePerShot is missing', () => {
    // Defensive: malformed firing block with burst-RPM but no per-shot
    // data must not blow up - fall back to DPS sum.
    const firing = {
      BurstRoundsPerMinute: 800,
      DamagePerSecond: { Energy: 834 },
    };
    expect(computeBurstDPS(firing)).toBeCloseTo(834, 4);
  });
});

describe('classifyFiringMode', () => {
  it('energy when a MaxAmmo pool is present (even with stray heat)', () => {
    expect(classifyFiringMode({ MaxAmmo: 75 }, null)).toBe('energy');
    // Stray HeatPerShot + no OverheatTemp must NOT win over the pool.
    expect(classifyFiringMode({ MaxAmmo: 75 }, { HeatPerShot: 1800 })).toBe('energy');
  });
  it('heat only with a real OverheatTemp AND HeatPerShot', () => {
    expect(classifyFiringMode(null, { OverheatTemp: 100, HeatPerShot: 0.5 })).toBe('heat');
    expect(classifyFiringMode(null, { OverheatTemp: 100, HeatPerShot: 0 })).toBe('continuous');
    expect(classifyFiringMode(null, { HeatPerShot: 1800 })).toBe('continuous'); // no OverheatTemp
  });
  it('continuous when neither pool nor real heat', () => {
    expect(classifyFiringMode(null, null)).toBe('continuous');
    expect(classifyFiringMode({}, {})).toBe('continuous');
  });
});

describe('fullRecoveryTime', () => {
  it('energy: pool / regen + cooldown', () => {
    expect(fullRecoveryTime({ MaxAmmo: 75, MaxRegenPerSec: 15, Cooldown: 0.75 }, null)).toBeCloseTo(5.75, 5);
  });
  it('heat: natural cool to MinTemp, not OverheatFixTime', () => {
    const hp = { OverheatTemp: 100, MinTemp: 0, CoolingPerSecond: 25, TimeTillCoolingStarts: 0.5, HeatPerShot: 0.5, OverheatFixTime: 9 };
    expect(fullRecoveryTime(null, hp)).toBeCloseTo(4.5, 5); // (100-0)/25 + 0.5
  });
  it('continuous: 0', () => {
    expect(fullRecoveryTime(null, null)).toBe(0);
  });
});

describe('getWeaponCadence - canonical economy fields', () => {
  it('energy repeater carrying a stray HeatPerShot classifies as energy', () => {
    const c = getWeaponCadence(
      { Firing: [{ RoundsPerMinute: 350, HeatPerShot: 1800 }], HeatParameters: { LockOnOverheat: false } },
      { MaxAmmo: 75, MaxRegenPerSec: 15, Cooldown: 0.75 },
    );
    expect(c.mode).toBe('energy');
    expect(c.magazine).toBe(75);
    expect(c.fullRecoveryTime).toBeCloseTo(5.75, 5);
    expect(c.continuousFireTime).toBeCloseTo(75 * (60 / 350), 5);
  });
  it('ballistic with real heat classifies as heat with natural-cool recovery', () => {
    const c = getWeaponCadence({
      Firing: [{ RoundsPerMinute: 600, HeatPerShot: 0.5 }],
      Ammunition: { Capacity: 9999 },
      HeatParameters: { OverheatTemp: 100, MinTemp: 0, CoolingPerSecond: 25, TimeTillCoolingStarts: 0.5, OverheatFixTime: 9 },
    }, null);
    expect(c.mode).toBe('heat');
    expect(c.fullRecoveryTime).toBeCloseTo(4.5, 5); // NOT the 9s OverheatFixTime
  });
  it('continuous gun: unbounded magazine, no recovery', () => {
    const c = getWeaponCadence({ Firing: [{ RoundsPerMinute: 60 }], Ammunition: { Capacity: 2000 } }, null);
    expect(c.mode).toBe('continuous');
    expect(c.magazine).toBe(Infinity);
    expect(c.continuousFireTime).toBe(Infinity);
    expect(c.fullRecoveryTime).toBe(0);
  });

  // Regression: the NEVER_OVERHEATS sentinel used to pass through as a real
  // 999999-round magazine, so the "full cooldown" any consumer derived from it
  // (999999 x shotInterval + OverheatFixTime) was astronomically large. Real
  // C-788 numbers: 40 RPM, 12 heat/shot, 25.4 cooling/s after a 0.84 s delay -
  // cooling between shots (25.4 x 0.66 = 16.8) beats HeatPerShot, so the gun
  // never overheats and must be modelled as continuous-fire.
  it('never-overheating ballistic is continuous, not a 999999-round magazine', () => {
    const c = getWeaponCadence({
      Firing: [{ RoundsPerMinute: 40, HeatPerShot: 12 }],
      Ammunition: { Capacity: 270 },
      HeatParameters: { MinTemp: 0, OverheatTemp: 100, CoolingPerSecond: 25.4, TimeTillCoolingStarts: 0.84, OverheatFixTime: 4.32 },
    }, null);
    expect(c.magazine).toBe(Infinity);
    expect(c.reloadTime).toBe(0);
    expect(c.continuousFireTime).toBe(Infinity);
    // computeSliderMax (ttkCalcUI) only counts weapons with a finite magazine
    // AND a real reload pause, so this gun no longer contributes the old
    // 999999 * 1.5 + 4.32 = 1500002.8 s upper bound to the TTK pause slider.
    expect(Number.isFinite(c.magazine) && c.reloadTime > 0).toBe(false);
  });

  it('heat-limited gun that DOES overheat keeps its real magazine', () => {
    // No cooling between shots: ceil(100 / 6) = 17 rounds before overheat.
    const c = getWeaponCadence({
      Firing: [{ RoundsPerMinute: 300, HeatPerShot: 6 }],
      Ammunition: { Capacity: 381 },
      HeatParameters: { MinTemp: 0, OverheatTemp: 100, CoolingPerSecond: 0, TimeTillCoolingStarts: 0, OverheatFixTime: 4 },
    }, null);
    expect(c.magazine).toBe(17);
    expect(c.reloadTime).toBeCloseTo(4, 5);
  });
});
