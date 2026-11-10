/**
 * Sustained DPS calculation (infinite time average).
 * Computes true average DPS over infinite fire-reload cycles:
 *   sustained = (dmgPerShot * roundsPerCycle) / cycleTime
 * Accounts for heat overheat cooldown and energy ammo regen.
 */

// Intentionally sums only Physical+Energy+Distortion (ship damage types).
// weaponParser's sumDamage also counts FPS-only types (Thermal/Biochemical/Stun).
function sumShipDamage(dmgObj) {
  if (!dmgObj) return 0;
  return (dmgObj.Physical || 0) + (dmgObj.Energy || 0) + (dmgObj.Distortion || 0);
}

/**
 * Sentinel `roundsBeforeOverheat` returns for guns that never reach their
 * overheat threshold - either they carry no heat at all, or cooling between
 * shots meets/exceeds HeatPerShot (e.g. C-788, S10 Mass Driver).
 *
 * Deliberately a large FINITE number rather than Infinity: calcSustainedDPS
 * divides damage by a cycle time built from this value, and Infinity there
 * yields NaN. Consumers that need the "never overheats" case must therefore
 * recognise it by comparison, not by `Number.isFinite`.
 */
export const NEVER_OVERHEATS = 999999;

function roundsBeforeOverheat(weapon) {
  const hp = weapon.HeatParameters || {};
  const firing = weapon.Firing?.[0] || {};

  const minTemp = hp.MinTemp || 0;
  const overheatTemp = hp.OverheatTemp || 100;
  const coolingPerSec = hp.CoolingPerSecond || 0;
  const coolDelay = hp.TimeTillCoolingStarts || 0;
  const rpm = firing.RoundsPerMinute || 0;
  const heatPerShot = firing.HeatPerShot || 0;

  if (rpm <= 0 || heatPerShot <= 0) return NEVER_OVERHEATS;

  const shotInterval = 60 / rpm;
  let coolingBetweenShots = 0;
  if (shotInterval > coolDelay) {
    coolingBetweenShots = coolingPerSec * (shotInterval - coolDelay);
  }

  const netHeatPerShot = heatPerShot - coolingBetweenShots;
  if (netHeatPerShot <= 0) return NEVER_OVERHEATS;

  return Math.ceil((overheatTemp - minTemp) / netHeatPerShot);
}

function overheatCooldown(weapon) {
  const hp = weapon.HeatParameters || {};
  const firing = weapon.Firing?.[0] || {};
  const fixTime = hp.OverheatFixTime || 0;
  const ohTemp = hp.OverheatTemp;
  const heatPS = firing.HeatPerShot || 0;
  return (fixTime && ohTemp && heatPS > 0) ? fixTime : 0;
}

function effectiveAmmo(weapon, consumption, powerFrac = 1, ammoMult = 1) {
  const capacity = weapon.Ammunition?.Capacity || 0;

  if (consumption?.MaxAmmo) {
    return Math.round(consumption.MaxAmmo * ammoMult * powerFrac);
  }

  if (capacity) {
    const hp = weapon.HeatParameters || {};
    const firing = weapon.Firing?.[0] || {};
    if (hp.OverheatTemp != null && (firing.HeatPerShot || 0) > 0) {
      return roundsBeforeOverheat(weapon);
    }
    return Math.floor(capacity);
  }

  return 0;
}

function regenTime(weapon, consumption, effAmmo, powerFrac = 1, regenMult = 1) {
  if (!consumption?.MaxAmmo) return 0;
  if (effAmmo === 0) return 0;

  const cooldown = consumption.Cooldown || 0;
  const regenPerSec = (consumption.MaxRegenPerSec || 0) * regenMult * powerFrac;
  if (regenPerSec <= 0) return cooldown;

  return effAmmo / regenPerSec + cooldown;
}

export { effectiveAmmo };

/**
 * Single source of truth for a weapon's FIRING ECONOMY - what limits how long
 * it can fire and how it recovers. Every consumer (cadence, TTK sim, weapon
 * column fire-time / ammo readouts) must classify through here so the rule can
 * never diverge again (a divergent `HeatPerShot > 0` check once collapsed
 * stray-heat energy repeaters to a 1-shot burst).
 *
 *   'energy'     - draws from a regenerating ammo pool (Consumption.MaxAmmo).
 *   'heat'       - heat-limited: a REAL overheat threshold (OverheatTemp > 0)
 *                  AND HeatPerShot > 0. A stray HeatPerShot with no OverheatTemp
 *                  is NOT heat-limited (some energy repeaters carry one).
 *   'continuous' - neither: fires until the target dies (box mag / beam).
 *
 * `heatParams` is the merged shape used across the codebase:
 *   { ...Weapon.HeatParameters, HeatPerShot: Firing[0].HeatPerShot }
 * Energy takes priority - a pool-fed gun is governed by its pool, not stray heat.
 */
export function classifyFiringMode(consumption, heatParams) {
  if ((consumption?.MaxAmmo || 0) > 0) return 'energy';
  if ((heatParams?.OverheatTemp || 0) > 0 && (heatParams?.HeatPerShot || 0) > 0) return 'heat';
  return 'continuous';
}

/**
 * Time (seconds) for a weapon to return to 100% readiness - the pause that
 * fully recovers it. Companion to classifyFiringMode; same `heatParams` shape.
 *
 *   energy - refill the ammo pool from regen, plus the post-empty Cooldown.
 *   heat   - the NATURAL cooldown: cool from the overheat threshold back to
 *            MinTemp at CoolingPerSecond (+ the pre-cool delay). NOT
 *            OverheatFixTime - that lockout only applies if the gun actually
 *            overheats, which the synced-fire model avoids by stopping the
 *            burst before overheat.
 *   continuous - never depletes -> 0.
 */
export function fullRecoveryTime(consumption, heatParams, powerFrac = 1, ammoMult = 1, regenMult = 1) {
  const mode = classifyFiringMode(consumption, heatParams);
  if (mode === 'energy') {
    const effAmmo = Math.round((consumption.MaxAmmo || 0) * ammoMult * powerFrac);
    return regenTime(null, consumption, effAmmo, powerFrac, regenMult);
  }
  if (mode === 'heat') {
    const cps = heatParams.CoolingPerSecond || 0;
    if (cps <= 0) return 0;
    return (heatParams.OverheatTemp - (heatParams.MinTemp || 0)) / cps + (heatParams.TimeTillCoolingStarts || 0);
  }
  return 0;
}

/** Build the merged heatParams shape classifyFiringMode/fullRecoveryTime expect. */
export function mergeHeatParams(weapon) {
  const hp = weapon?.HeatParameters;
  if (!hp) return null;
  return { ...hp, HeatPerShot: weapon?.Firing?.[0]?.HeatPerShot || 0 };
}

/**
 * Per-shot firing cadence for the discrete-event TTK simulator.
 *
 * Returns the timing primitives needed to place a weapon's shots on a clock,
 * derived from the SAME helpers `calcSustainedDPS` uses so the two never drift:
 *
 *   { rpm, shotInterval, magazine, reloadTime }
 *
 * - `shotInterval` = 60 / rpm (seconds between shots within a magazine).
 * - `magazine`     = shots before the weapon must pause:
 *                      energy  → effective ammo pool (MaxAmmo)
 *                      ballistic w/ heat → rounds before overheat
 *                      ballistic w/ box magazine, no heat → Infinity
 *                        (modeled as continuous - mirrors calcSustainedDPS,
 *                         which treats downtime 0 as burst == sustained;
 *                         box-magazine reload time isn't in the data)
 * - `reloadTime`   = overheat cooldown + energy regen time (the pause after a
 *                     magazine empties). 0 → fires continuously (no magazine
 *                     limit applied by the sim).
 *
 * Returns `null` for weapons with no per-shot rate (beams, RPM = 0) - these
 * carry no `DamagePerShot` alpha and are already excluded from the chain.
 */
export function getWeaponCadence(weapon, consumption, powerFrac = 1, ammoMult = 1, regenMult = 1) {
  const firing = weapon?.Firing?.[0] || {};
  const rpm = firing.RoundsPerMinute || 0;
  if (rpm <= 0) return null;

  const shotInterval = 60 / rpm;
  const effAmmo = effectiveAmmo(weapon, consumption, powerFrac, ammoMult);

  // A heat-limited gun whose cooling outpaces its per-shot heat never reaches
  // OverheatTemp, so effectiveAmmo hands back the NEVER_OVERHEATS sentinel.
  // Such a gun never stops to cool - that IS the continuous-fire case - so
  // report it as one instead of letting the sentinel pose as a real magazine.
  // Unguarded it yields absurd cooldowns downstream: the C-788's full cycle
  // came out as 999999 x 1.5 s + 4.32 s = ~1.5e6 s, which then became the TTK
  // pause slider's upper bound (the S10 Mass Driver reached ~3e7 s).
  // Energy weapons are exempt: their pool is Consumption.MaxAmmo, never heat.
  const neverOverheating = !consumption?.MaxAmmo && effAmmo >= NEVER_OVERHEATS;

  const reloadTime = neverOverheating
    ? 0
    : overheatCooldown(weapon) + regenTime(weapon, consumption, effAmmo, powerFrac, regenMult);

  // Magazine only constrains the sim when there's a reload pause to apply.
  // With reloadTime 0 the weapon fires continuously (consistent with the
  // sustained-DPS path), so report an unbounded magazine.
  let magazine = Infinity;
  if (reloadTime > 0) {
    magazine = effAmmo > 0 ? effAmmo : Infinity;
  }

  // Canonical firing-economy fields, derived once here so every consumer reads
  // the same classification (see classifyFiringMode).
  const heatParams = mergeHeatParams(weapon);
  const mode = classifyFiringMode(consumption, heatParams);
  const continuousFireTime = Number.isFinite(magazine) ? magazine * shotInterval : Infinity;
  const recovery = fullRecoveryTime(consumption, heatParams, powerFrac, ammoMult, regenMult);

  return { rpm, shotInterval, magazine, reloadTime, mode, continuousFireTime, fullRecoveryTime: recovery };
}

/**
 * Within-burst peak DPS for a weapon's primary firing mode.
 *
 * Burst-fire weapons (e.g. Echion Repeater, 3-shot burst) fire their
 * shots quickly inside a burst, then pause briefly before the next
 * trigger pull. The extractor encodes both rates:
 *   - `RoundsPerMinute`        - average sustained, INCLUDING burst pause
 *   - `BurstRoundsPerMinute`   - the inner rate WITHIN a burst (Erkul's
 *                                 "Burst DPS" uses this)
 *
 * The latter is only emitted when burst > sustained with margin. For
 * non-burst weapons (Cannon, plain Repeater) the field is absent and
 * `DamagePerSecond = alpha × RoundsPerMinute / 60` is the correct
 * burst-DPS number - beams also fall through here (RPM = 0, DPS comes
 * from the beam block directly).
 *
 * Use this in any "Burst DPS" display so the number matches
 * Erkul/SPViewer regardless of fire pattern. Pure helper - does not
 * read state, safe to call on raw extractor data or crafted clones.
 */
export function computeBurstDPS(firing) {
  if (!firing) return 0;
  const burstRPM = firing.BurstRoundsPerMinute;
  const perShot = firing.DamagePerShot;
  if (burstRPM && perShot) {
    let alpha = 0;
    for (const v of Object.values(perShot)) {
      if (typeof v === 'number') alpha += v;
    }
    if (alpha > 0) return alpha * burstRPM / 60;
  }
  const dps = firing.DamagePerSecond;
  if (!dps) return 0;
  let sum = 0;
  for (const v of Object.values(dps)) {
    if (typeof v === 'number') sum += v;
  }
  return sum;
}

export function calcSustainedDPS(weapon, consumption, powerFrac = 1, ammoMult = 1, regenMult = 1) {
  const firing = weapon.Firing?.[0] || {};
  const firingName = firing.Name || '';

  let dmgPerUnit, rate;
  if (firingName === 'Beam') {
    dmgPerUnit = sumShipDamage(firing.DamagePerSecond);
    rate = firing.Beam?.MaxEnergyDraw || 0;
  } else {
    dmgPerUnit = sumShipDamage(firing.DamagePerShot);
    rate = (firing.RoundsPerMinute || 0) / 60;
  }

  const A = effectiveAmmo(weapon, consumption, powerFrac, ammoMult);
  const ohCD = overheatCooldown(weapon);
  const regen = regenTime(weapon, consumption, A, powerFrac, regenMult);

  if (A === 0 || rate === 0) return 0;

  const fireTime = A / rate;
  const downtime = regen + ohCD;

  // No downtime = burst DPS equals sustained DPS
  if (downtime === 0) return dmgPerUnit * rate;

  // Infinite-time average: total damage per cycle / cycle duration
  const cycleTime = fireTime + downtime;
  return (dmgPerUnit * A) / cycleTime;
}
