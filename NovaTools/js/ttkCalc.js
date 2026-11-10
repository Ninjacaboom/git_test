/**
 * Time to Kill (TTK) calculator - pure discrete-event engine.
 *
 * Takes the player's full equipped weapon set and fires every group on its own
 * cadence against a shared, MONOTONIC enemy state, reporting the wall-clock
 * time to reach each outcome:
 *
 *   - breakShields      shield face HP -> 0
 *   - killVital         smallest vital part HP -> 0 (ship destroyed)
 *   - disablePowerplant power-plant component physical HP -> 0
 *   - disableDistortion power-plant distortion pool -> MaximumDamage
 *
 * The enemy recovers between bursts, both pools on the same shape: nothing
 * happens for a delay measured from the last hit, then the pool moves at a
 * fixed rate.
 *   - shield HP regenerates after DamagedDelay / DownedDelay (see
 *     integrateShieldRegen); ANY damage restarts that clock
 *   - the distortion pool bleeds after the generator's DecayDelay at its
 *     DecayRate (see integrateDistortionDecay); a single distortion hit
 *     restarts that clock, so an unbroken burst never decays
 * An outcome is therefore Infinity either when no weapon can make progress on
 * it (all shots deflected / no distortion) or when recovery outruns the
 * incoming fire - the `reasons` map names which.
 *
 * Per-shot damage routing is delegated entirely to deflectionCalc.simulateShot
 * (which already returns shieldDmg / armorDmg / hullDmg / componentDmg /
 * distortionDmg per shot) - this engine only advances a clock and accumulates.
 *
 * v1 simplifications (shared with the Deflection calc):
 *   - Bubble-equivalent shield face; resistance at Maximum (full enemy pips).
 *   - Player weapons at full power; crafted alpha respected.
 *   - Beam weapons (no per-shot DamagePerShot) are excluded, same as Deflection.
 *   - "Reaching" the power plant is modeled purely via the penetration chain
 *     (no positional/facing mechanics). Distortion is exempt from that chain:
 *     since PTU 4.9 every distortion weapon has BasePenetrationDistance 0, and
 *     in-game testing shows distortion still disables when the shot lands on
 *     the component section - reach is aim-based, and ideal aim is assumed.
 */

import { getCraftedItemStats } from './loadoutManager.js';
import { getWeaponCadence, classifyFiringMode, fullRecoveryTime, mergeHeatParams } from './sustained.js';
import {
  enumerateLoadoutWeapons,
  buildOpponentProfile,
  simulateShot,
  cloneProfile,
} from './deflectionCalc.js';

/** Safety bound on simulated fire events (mirrors computeAmmoToBreak's cap). */
const HARD_CAP = 200000;

/** Max per-shot log entries captured (bounds memory/DOM on long fights). */
const SHOT_LOG_CAP = 4000;

/**
 * Enumerate the active loadout's weapons WITH firing cadence attached.
 *
 * Reuses enumerateLoadoutWeapons for the slot walk + className/stats grouping,
 * then augments each group with `cadence` ({ rpm, shotInterval, magazine,
 * reloadTime }) derived from the same `sustained.js` helpers the DPS readouts
 * use. Groups whose weapon has no per-shot cadence (beams) get cadence: null
 * and are dropped - they carry no per-shot alpha to simulate.
 *
 * @returns {Array<weaponGroup & { cadence: {rpm,shotInterval,magazine,reloadTime} }>}
 */
/**
 * Sub-classify a turret-mounted weapon by whether it ever engages a ship hull.
 * Lets ship-to-ship calcs drop turrets that don't, even with "Include turrets" on:
 *   - 'pdc'           Point Defense Cannon turrets pick their own targets
 *                     (incoming missiles / small craft), not the opponent hull.
 *   - 'antipersonnel' bespoke, fixed Size-1 ballistic gatlings (e.g. the
 *                     YellowJacket) are door guns for boarding - useless ship-to-ship.
 *   - 'combat'        real gunner turrets (everything else).
 *
 * @param {string} turretCategory  the crew turret's category (extractSlots tag)
 * @param {number} weaponSize      the mounted weapon's Size
 * @param {{phys?:number,energy?:number,dist?:number}} dmgByType per-shot damage
 * @returns {'pdc'|'antipersonnel'|'combat'}
 */
export function classifyTurretWeapon(turretCategory, weaponSize, dmgByType) {
  if (turretCategory === 'PDC Turret') return 'pdc';
  const phys = dmgByType?.phys || 0;
  const energy = dmgByType?.energy || 0;
  const dist = dmgByType?.dist || 0;
  if (weaponSize === 1 && phys > 0 && energy === 0 && dist === 0) return 'antipersonnel';
  return 'combat';
}

export function enumerateLoadoutWeaponsForTtk(loadout, slots, disabledPorts) {
  const groups = enumerateLoadoutWeapons(loadout, slots, disabledPorts);
  // Map every port under the turret group to the crew turret it belongs to (and
  // that turret's category) so each weapon group can be tagged pilot vs turret -
  // the dialog lets the user include or exclude turrets (a solo pilot can't fire
  // crewed turrets). A group whose ports are all turret ports is a turret weapon;
  // anything with a pilot port stays pilot.
  const turretPorts = new Set();
  const portCategory = new Map();
  const collectPorts = (slot, cat) => {
    if (!slot) return;
    if (slot.portName) { turretPorts.add(slot.portName); portCategory.set(slot.portName, cat); }
    for (const sub of slot.ports || []) collectPorts(sub, cat);
  };
  for (const s of (slots?.turrets || [])) collectPorts(s, s.category);
  const out = [];
  for (const g of groups) {
    const port = g.ports?.[0];
    let cadence = null;
    let heatParams = null;
    let consumption = null;
    let weaponSize = 0;
    try {
      const si = getCraftedItemStats(g.className, port);
      weaponSize = si?.Size || 0;
      cadence = getWeaponCadence(si?.Weapon, si?.Weapon?.Consumption);
      // Physical-state fields the simulator integrates over inter-event gaps:
      // heat drives ballistic cooling, consumption drives energy-pool regen. Both
      // may be absent (beams, mining lasers, etc.). We attach the merged heat
      // shape verbatim; whether the weapon is actually heat-LIMITED is decided
      // by classifyFiringMode (a stray HeatPerShot with no OverheatTemp stays
      // 'energy' / 'continuous'), so no special guard is needed here.
      heatParams = mergeHeatParams(si?.Weapon);
      consumption = si?.Weapon?.Consumption || null;
    } catch { /* leave null */ }
    if (!cadence) continue; // beams / no per-shot rate
    const isTurret = (g.ports?.length || 0) > 0 && g.ports.every(p => turretPorts.has(p));
    // turretExcluded weapons are never fired by the sim in either toggle state.
    const turretRole = isTurret
      ? classifyTurretWeapon(portCategory.get(g.ports[0]), weaponSize, g.dmgByType)
      : null;
    const turretExcluded = turretRole === 'pdc' || turretRole === 'antipersonnel';
    out.push({ ...g, cadence, heatParams, consumption, isTurret, turretRole, turretExcluded });
  }
  return out;
}

/**
 * Build the opponent profile for TTK: the standard deflection profile plus the
 * enemy power plant's HP pools. The deflection profile is returned unchanged
 * (so simulateShot behaves identically); `powerplant` is additive.
 *
 * @param {object} shipConfig  vehicle stats record (Armor/Hull + Hardpoints)
 * @param {object} shieldItem  stdItem of the selected shield (or null)
 * @param {object} ppItem      stdItem of the selected power plant (or null)
 * @param {number} shieldCount number of installed shield generators
 * @param {number} shieldPct   0-1 starting shield fraction (default 1)
 * @param {number} armorPct    0-1 starting armor fraction (default 1)
 * @param {number} ppCount     number of installed power plants (default 1).
 *   All of them must be down to take the ship offline, but the two pools
 *   aggregate differently:
 *
 *   - HP sums. A round hits one component, so every generator has to be shot
 *     down in turn.
 *   - Distortion does NOT sum. Distortion damage is explosive, so one shot
 *     saturates every generator inside the blast at full value - the damage
 *     is not divided between them. Two generators therefore fill in the same
 *     time as one, and the pool is a single generator's MaximumDamage.
 *     Known exception: the Perseus mounts its two generators far enough apart
 *     that one blast can't cover both. Not modelled - see TODOS.md.
 */
export function buildTtkOpponentProfile(
  shipConfig, shieldItem, ppItem, shieldCount = 1, shieldPct = 1, armorPct = 1, ppCount = 1,
) {
  const base = buildOpponentProfile(shipConfig, shieldItem, shieldCount, shieldPct, armorPct);
  const ppN = Math.max(1, ppCount);
  const ppHp = (ppItem?.Durability?.Health || 0) * ppN;
  // Per generator, NOT × ppN: the blast saturates them in parallel.
  const ppDistortion = ppItem?.Durability?.Distortion || {};
  const ppDist = ppDistortion.MaximumDamage || 0;

  // Kill target HP. The base profile (shared with the Deflection calc) uses the
  // SMALLEST StructureHealthPoints.VitalParts entry - the extractor marks a
  // part vital when its destruction triggers the game's Destroy damage group,
  // so any one of them kills and the smallest is the fastest structural kill.
  // Defensive fallback for a ship without VitalParts: .Parts is dominated by
  // cosmetic pieces (fin tips, flaps), so take the LARGEST entry as the
  // main-body kill proxy, NOT the smallest. Different aggregation by design:
  // vital parts → smallest (any one kills), generic parts → largest (only the
  // main body kills).
  let smallestVitalHp = base.hull.smallestVitalHp;
  if (!(smallestVitalHp > 0)) {
    smallestVitalHp = mainBodyPart(shipConfig?.Hull?.StructureHealthPoints?.Parts);
  }

  return {
    ...base,
    hull: { ...base.hull, smallestVitalHp },
    powerplant: {
      hp: ppHp,
      maxHp: ppHp,
      distortionMax: ppDist,
      // Distortion bleeds back off once the target stops taking distortion
      // hits: nothing happens for DecayDelay seconds, then the pool drains at
      // DecayRate per second (rate × 15 s = MaximumDamage across the whole
      // catalogue, so a full pool empties in 15 s). DecayDelay is 1.5 / 3 / 4.5
      // / 6 s depending on the generator, which is the same order as the
      // calculator's cooling pause - that's what makes it worth simulating.
      distortionDecayDelay: ppDistortion.DecayDelay || 0,
      distortionDecayRate: ppDistortion.DecayRate || 0,
    },
  };
}

/**
 * Largest positive HP among a StructureHealthPoints.Parts map/array - used as
 * the "main body" kill proxy for ships with no designated VitalParts. Picking
 * the largest avoids treating a cosmetic fin tip as a kill.
 */
function mainBodyPart(parts) {
  if (!parts) return 0;
  const vals = Array.isArray(parts) ? parts : Object.values(parts);
  let max = 0;
  for (const v of vals) {
    const hp = typeof v === 'number' ? v : (v && typeof v.Health === 'number' ? v.Health : null);
    if (hp != null && hp > max) max = hp;
  }
  return max;
}

/** Shallow-clone the mutable parts of an opponent profile for a sim run.
 *  Delegates to deflectionCalc.cloneProfile for the shared shield/armor/hull
 *  fields, then appends the powerplant field that TTK tracks additionally. */
function cloneOpponent(op) {
  return {
    ...cloneProfile(op),
    powerplant: { ...(op.powerplant || { hp: 0, maxHp: 0, distortionMax: 0 }) },
  };
}

/**
 * Default pause length when the caller doesn't specify one. Roughly matches the
 * `DamagedDelay` of a small civilian shield - long enough that real pilots can
 * approximate it by feel, short enough to prevent regen on most opponents.
 */
export const DEFAULT_PAUSE_LEN = 3;

/**
 * Lowest pause length at which AT LEAST ONE weapon recovers enough state for
 * one more shot. Below this, every weapon is still "locked" by cooldown /
 * overheat-fix from the previous burst, so the pause delivers no benefit.
 *
 * - Energy: worst-case recovery = Cooldown + (1 / MaxRegenPerSec). Cooldown
 *   applies after a fully-depleted burst; with residual pool no cooldown,
 *   but we plan for the depletion case so the slider floor is safe.
 * - Ballistic: cooling enough heat for one shot's worth of headroom =
 *   TimeTillCoolingStarts + (HeatPerShot / CoolingPerSecond).
 * - Continuous-fire weapons don't constrain (skip).
 *
 * Floors at 0.5 s so the slider remains usable in pathological cases.
 */
export function computeMinUsefulPause(weaponGroups) {
  if (!weaponGroups || weaponGroups.length === 0) return 1;
  let min = Infinity;
  for (const g of weaponGroups) {
    let weaponMin = Infinity;
    const co = g.consumption;
    if (co?.MaxAmmo > 0 && co?.MaxRegenPerSec > 0) {
      weaponMin = (co.Cooldown || 0) + 1 / co.MaxRegenPerSec;
    } else {
      const hp = g.heatParams;
      if (hp?.HeatPerShot > 0 && hp?.CoolingPerSecond > 0) {
        weaponMin = (hp.TimeTillCoolingStarts || 0) + hp.HeatPerShot / hp.CoolingPerSecond;
      }
    }
    if (weaponMin < min) min = weaponMin;
  }
  return Number.isFinite(min) ? Math.max(0.5, min) : 1;
}

/**
 * Search for the pause length that reaches the most DECISIVE outcome fastest
 * against this specific opponent. Pilot tradeoff: too short a pause overheats
 * ballistics / starves energy regen (slower); too long lets enemy shield regen
 * undo progress (slower or impossible). There's a sweet spot, and it shifts
 * with weapon mix and opponent durability.
 *
 * The target outcome is the most decisive one the loadout can actually reach:
 *   killVital  >  (earliest of disablePowerplant / disableDistortion)  >  breakShields
 * We minimize the TIME to that target. A ballistic loadout that kills via
 * penetration should optimize the kill, not an incidental early shield chip -
 * which is why naively maximizing first-outcome DPS picked too short a pause.
 *
 * `options.optimizeFor: 'distortion'` overrides that ladder and tunes the pause
 * for the distortion soft-disable instead. Those two goals genuinely disagree:
 * the kill wants the pause that maximizes sustained damage, while distortion
 * wants a pause under the generator's decay delay so the pool never bleeds.
 * Falls back to the normal ladder when the loadout can't reach the distortion
 * outcome at all.
 *
 * Cheap search: ~step-spaced sims across [min, max].
 *
 * Returns the pauseLen (seconds) reaching the target soonest, or null when no
 * pause value produced any progress (degenerate loadout).
 */
export function computeOptimalPauseLen(weaponGroups, opponent, options = {}) {
  const minPause = options.minPause ?? 2;
  let maxPause = options.maxPause ?? 10;
  const step = options.step ?? 0.5;
  if (!weaponGroups || weaponGroups.length === 0 || !opponent) return null;

  // Comfort caps on the suggested pause. Neither trades away TTK - both keep the
  // sustained-pressure cadence sound:
  //  1. Stay strictly BELOW the shield's regen onset (DamagedDelay). A pause
  //     that reaches the onset lets the shield start recovering the moment the
  //     pilot is a hair late, undoing progress - never worth it.
  //  2. Never wait longer than the FASTEST gun needs to return to 100%. Past
  //     that point that gun sits ready and idle - wasted uptime - so the synced
  //     pause should end as soon as the quickest gun can re-open fire.
  if ((opponent.shield?.regenRate || 0) > 0 && (opponent.shield?.damagedDelay || 0) > 0) {
    maxPause = Math.min(maxPause, opponent.shield.damagedDelay - 1e-3);
  }
  // "Return to 100%" is the energy pool refill or the ballistic natural cooldown
  // (NOT OverheatFixTime) - both live in sustained.js's fullRecoveryTime.
  let minReload = Infinity;
  for (const g of weaponGroups) {
    const rt = fullRecoveryTime(g.consumption, g.heatParams);
    if (rt > 0) minReload = Math.min(minReload, rt);
  }
  if (Number.isFinite(minReload)) maxPause = Math.min(maxPause, minReload);
  // Don't invert the range if the caps fell below the floor - the floor wins.
  if (maxPause < minPause) maxPause = minPause;

  // First decide which outcome to optimize - the most decisive one that's
  // reachable at ANY pause in the range. Probe once at the midpoint to classify
  // reachability (a finite result at one pause means the loadout can reach it).
  const probe = simulateTtk(weaponGroups, opponent, { ...options, pauseLen: minPause });
  let targetKey = null;
  if (options.optimizeFor === 'distortion' && Number.isFinite(probe.disableDistortion)) {
    targetKey = 'disableDistortion';
  } else if (Number.isFinite(probe.killVital)) targetKey = 'killVital';
  else if (Number.isFinite(probe.disablePowerplant) || Number.isFinite(probe.disableDistortion)) targetKey = 'disable';
  else if (Number.isFinite(probe.breakShields)) targetKey = 'breakShields';
  if (!targetKey) return null;

  // Time to the chosen target for a result (earliest of the two disable paths
  // when optimizing "disable").
  const targetTime = (r) => {
    if (targetKey === 'disable') {
      return Math.min(
        Number.isFinite(r.disablePowerplant) ? r.disablePowerplant : Infinity,
        Number.isFinite(r.disableDistortion) ? r.disableDistortion : Infinity,
      );
    }
    return r[targetKey];
  };

  // Among pauses that reach the decisive outcome, prefer the FASTEST time - but
  // when several pauses tie (the cooldown doesn't change the kill, e.g. the kill
  // lands inside the first burst before any pause fires), prefer the LARGEST
  // pause. A relaxed cadence is far easier for a human to execute than a tight
  // 0.5s rhythm, at zero cost to TTK. The loop steps p upward, so a tie always
  // upgrades to the larger pause.
  const TIE = 1e-6;
  let best = { time: Infinity, pauseLen: null };
  for (let p = minPause; p <= maxPause + 1e-6; p += step) {
    const r = simulateTtk(weaponGroups, opponent, { ...options, pauseLen: p });
    const t = targetTime(r);
    if (!Number.isFinite(t)) continue;
    if (t < best.time - TIE) {
      best = { time: t, pauseLen: p };          // strictly faster -> new optimum
    } else if (t <= best.time + TIE) {
      best = { time: Math.min(best.time, t), pauseLen: p }; // tie -> take the larger pause
    }
  }
  return best.pauseLen;
}

/**
 * Compute the "ideal" sustained burst duration (in seconds) for a given pause
 * length, based on each weapon's recovery rate during the pause.
 *
 * Pilot model: after the initial burst (where pool is full / heat is cold and
 * the weapon's natural CF dictates), subsequent bursts should fire for exactly
 * as long as the pause's regeneration / cooling allows - any longer and the
 * weapon enters trickle-fire (energy) or overheat (ballistic), any shorter and
 * the pilot wastes the recovery. The most-constrained weapon's recovery sets
 * the safe ceiling for the whole loadout.
 *
 * Returns:
 *   - seconds (positive) for the ideal burst length, or
 *   - null when no weapon constrains (all continuous-fire / no consumption / no heat).
 *
 * Energy weapon: shots regenerated during pause = pauseLen * MaxRegenPerSec.
 * In steady state the pool oscillates between (residual+regen) and residual,
 * never hitting 0, so no Cooldown is engaged in the post-initial-burst cycles.
 *
 * Ballistic weapon: heat dissipated during pause = max(0, pauseLen -
 * TimeTillCoolingStarts) * CoolingPerSecond. Each shot adds HeatPerShot, so
 * the burst can fire that many shots before reaching prior heat plus what
 * dissipated.
 */
export function computeIdealBurstDuration(weaponGroups, pauseLen) {
  if (!weaponGroups || weaponGroups.length === 0) return null;
  let minDuration = Infinity;
  for (const g of weaponGroups) {
    const cad = g.cadence || {};
    if (!Number.isFinite(cad.magazine)) continue; // continuous-fire: no constraint
    const shotInterval = cad.shotInterval || 0;
    if (shotInterval <= 0) continue;
    let weaponShots = Infinity;
    const mode = classifyFiringMode(g.consumption, g.heatParams);
    const co = g.consumption;
    const hp = g.heatParams;
    if (mode === 'energy' && (co.MaxRegenPerSec || 0) > 0) {
      weaponShots = Math.min(cad.magazine, pauseLen * co.MaxRegenPerSec);
    } else if (mode === 'heat' && (hp.CoolingPerSecond || 0) > 0) {
      const coolingWindow = Math.max(0, pauseLen - (hp.TimeTillCoolingStarts || 0));
      const heatDissipated = coolingWindow * hp.CoolingPerSecond;
      weaponShots = Math.min(cad.magazine, heatDissipated / hp.HeatPerShot);
    }
    const weaponDuration = weaponShots * shotInterval;
    if (weaponDuration < minDuration) minDuration = weaponDuration;
  }
  return Number.isFinite(minDuration) ? minDuration : null;
}

/**
 * Run the discrete-event simulation with synchronized-fire pilot behavior.
 *
 * Model summary (full design in PLAN_TTK_PILOT_FIRE.md):
 *
 * 1. **Dictator detection.** The weapon group with the shortest continuous-fire
 *    time (`magazine * shotInterval`) among groups that actually empty drives
 *    the synced-pause cycle. Continuous-fire weapons (magazine = Infinity)
 *    never become dictator - they fire forever and never trigger a pause.
 *    If every group is continuous-fire, no dictator, no synced pause; the sim
 *    reduces to the previous independent-clock behavior (which keeps existing
 *    test fixtures stable).
 *
 * 2. **Synced pause.** When the dictator's `magLeft` reaches 0, every group's
 *    next-fire clock jumps to `t + pauseLen`. Slower-cycling weapons cut their
 *    current burst short; their per-weapon physical state (heat / pool) carries
 *    forward, integrated by the inter-event update path.
 *
 * 3. **Per-weapon physical state.** Each event applies inter-event integration
 *    for all groups: ballistic heat dissipates by `CoolingPerSecond * cooling
 *    window` (the window past `TimeTillCoolingStarts` since last shot), energy
 *    pools regen by `MaxRegenPerSec * dt` after the `Cooldown` silent window.
 *    State persists across pauses - a ballistic that fired 60% through its
 *    overheat window in cycle N starts cycle N+1 with partially cooled heat.
 *
 * 4. **Enemy shield regen.** If the opponent shield exposes `damagedDelay` +
 *    `regenRate`, the sim integrates regen over each inter-event interval that
 *    falls past `lastShieldDmgT + damagedDelay`. Short pauses (slider < delay)
 *    keep shields drained; long pauses let them recover. `downedDelay` re-
 *    enables regen after the shield has been at 0.
 *
 * @param {Array} weaponGroups  enumerateLoadoutWeaponsForTtk output
 * @param {object} opponent     buildTtkOpponentProfile output
 * @param {object} [options]
 * @param {number} [options.pauseLen=DEFAULT_PAUSE_LEN]  Synced-pause duration.
 * @param {boolean} [options.applyArmorDurability]       Forwarded to simulateShot.
 * @param {number} [options.ppReach=0]  Required penetration distance (metres) to
 *   reach the power plant. A weapon whose BasePenetrationDistance is below this
 *   can't crack the plant's casing (Disable power plant). PHYSICAL component
 *   damage only - distortion is exempt: PTU 4.9 zeroed BasePenetrationDistance
 *   on every distortion weapon and distortion still disables when the shot
 *   lands on the component section, so its reach is aim-based (ideal aim
 *   assumed). Vital kill, shield and armor are also unaffected. 0 disables
 *   the gate.
 */
export function simulateTtk(weaponGroups, opponent, options = {}) {
  const pauseLen = Math.max(0, options.pauseLen ?? DEFAULT_PAUSE_LEN);
  const captureLog = !!options.captureLog;
  // Minimum weapon penetration distance to reach the power plant. Gates only
  // the Disable-power-plant outcome (see option doc above). 0 = off.
  const ppReach = Math.max(0, options.ppReach || 0);
  // Distortion fire policy: 'hold' (default, optimal play) = distortion stays
  // holstered while the shield is up, then fires once it drops. 'always' =
  // distortion fires from the opening salvo (wasted on a live shield, but no
  // held trigger). Either way distortion anchors the cycle once shields drop.
  const holdDistortion = options.distortionMode !== 'always';
  const result = {
    breakShields: Infinity,
    breakArmor: Infinity,
    killVital: Infinity,
    disablePowerplant: Infinity,
    disableDistortion: Infinity,
    reasons: { breakShields: null, breakArmor: null, killVital: null, disablePowerplant: null, disableDistortion: null },
    // Defensive state at the instant each outcome is reached. Lets the UI show
    // "shields at X%, armor at Y%" when the ship dies / is disabled - which
    // varies sharply by damage type (distortion can disable with shields still
    // up; ballistic only reaches the power plant after armor is stripped).
    snapshot: { breakShields: null, breakArmor: null, killVital: null, disablePowerplant: null, disableDistortion: null },
    // Cumulative damage delivered at each outcome timestamp. Sum of shield +
    // armor + hull + component + distortion damage applied up to that moment.
    // Lets the UI report effective DPS = damageAt[outcome] / outcome_time.
    damageAt: { breakShields: 0, breakArmor: 0, killVital: 0, disablePowerplant: 0, disableDistortion: 0 },
    // Number of completed sync pauses BEFORE the outcome is reached (== how
    // many full pause-cycles the pilot ran). 0 means resolved in the initial
    // burst.
    cyclesAt: { breakShields: 0, breakArmor: 0, killVital: 0, disablePowerplant: 0, disableDistortion: 0 },
    // Total sync pauses that fired during the sim run (useful for the log).
    totalCycles: 0,
    // Per-cycle log entries (start/end state of each burst + pause). Empty
    // unless options.captureLog is set - generation has measurable cost when
    // the search calls simulateTtk in a tight loop.
    log: [],
    // Per-shot detail (one entry per weapon volley), grouped by cycle for the
    // expandable log view. Only captured when options.captureLog is set, and
    // capped to keep the array bounded on long capital-ship fights.
    shotLog: [],
  };
  if (!weaponGroups || weaponGroups.length === 0 || !opponent) {
    if (!weaponGroups || weaponGroups.length === 0) {
      for (const k of Object.keys(result.reasons)) result.reasons[k] = 'no weapons';
    }
    return result;
  }

  const op = cloneOpponent(opponent);

  // External accumulators (not read by simulateShot).
  let vitalHp = op.hull.smallestVitalHp || 0;
  let ppHp = op.powerplant.hp || 0;
  let distortionPool = 0;
  const distortionMax = op.powerplant.distortionMax || 0;
  // Distortion decay telemetry, mirroring the shield-regen trio below: the pool
  // sits untouched for `distortionDecayDelay` seconds after the last distortion
  // hit, then bleeds at `distortionDecayRate` per second. Keeping the pause
  // shorter than the delay therefore costs nothing, which is exactly how the
  // mechanic is played.
  const distortionDecayDelay = op.powerplant.distortionDecayDelay || 0;
  const distortionDecayRate = op.powerplant.distortionDecayRate || 0;
  let lastDistortionHitT = 0;
  // Highest pool level this burst reached, and the previous burst's high-water
  // mark. Compared at every sync pause: when a full burst cannot beat the peak
  // of the burst before it, decay is winning and the fight is a treadmill.
  // Distortion then stops counting as progress so the no-progress guard can end
  // the run - otherwise the same slice would be refilled until HARD_CAP.
  // Measured per burst rather than per shot because climbing back to the old
  // peak legitimately takes many events.
  let distortionCyclePeak = 0;
  let distortionPrevCyclePeak = -Infinity;
  let distortionCycleHadHit = false;
  let distortionStalled = false;
  let distortionPeak = 0;
  // Cumulative damage applied to ALL layers (shield + armor + hull + component
  // + distortion). Drives effective-DPS computation from the UI.
  let totalDamage = 0;

  // Shield-regen telemetry. `lastShieldDmgT` updates on every event where the
  // ship takes ANY damage; both the damaged-shield and downed-shield recovery
  // windows are measured from it (see integrateShieldRegen).
  const shieldDamagedDelay = op.shield.damagedDelay || 0;
  const shieldRegenRate = op.shield.regenRate || 0;
  const shieldDownedDelay = op.shield.downedDelay || 0;
  let lastShieldDmgT = 0;
  // A shield only reaches 0 HP under UNTAPERED drain. Energy (all-or-nothing
  // absorption) and distortion (flat resistance bleed) each remove a fixed
  // slice of shield HP per shot, so they converge to 0. BALLISTIC drain scales
  // with the live shield fraction (effAbs = baseAbs x shieldFrac): it decays
  // exponentially and ASYMPTOTES above 0, so ballistic fire alone can never
  // fully deplete a shield. A loadout with no energy and no distortion therefore
  // can't break a shield at all - its shield "progress" is futile, must not
  // count toward the breakShields outcome, and must not keep the sim alive.
  const canDepleteShield = weaponGroups.some(g => {
    const d = g.dmgByType || {};
    return (d.energy || 0) > 0 || (d.dist || 0) > 0;
  });
  // Per-event ballistic shield drain below this is treated as "the taper has
  // bottomed out": the shield has reached its practical floor, the pass-through
  // has essentially hit its ceiling, and if nothing has penetrated the armor by
  // now nothing will. Used to stop crediting a futile ballistic grind as
  // progress (so the no-progress guard ends it) WITHOUT cutting off a loadout
  // that only penetrates once the shield is low (its drain is still large then).
  const shieldDrainFloor = Math.max(op.shield.maxHp * 1e-5, 1e-3);

  const snap = () => ({
    shieldHp: op.shield.hp,
    shieldPct: op.shield.maxHp > 0 ? op.shield.hp / op.shield.maxHp : null,
    armorHp: op.armor.hp,
    armorPct: op.armor.maxHp > 0 ? op.armor.hp / op.armor.maxHp : null,
    powerplantHp: ppHp,
    powerplantPct: op.powerplant.maxHp > 0 ? ppHp / op.powerplant.maxHp : null,
    distortionPct: distortionMax > 0 ? Math.min(1, distortionPool / distortionMax) : null,
  });

  // Has this stage ever taken damage? Drives the Infinity "reason" strings.
  const ever = { shield: false, armor: false, hull: false, pp: false, dist: false };
  // Set when a weapon produced physical component damage but its penetration
  // distance was below ppReach, so the hit never reached the power plant. Lets
  // the Disable Infinity reason distinguish "too shallow" from
  // "chain deflected" / "shields absorb" / "killed first".
  let ppReachBlocked = false;

  // Per-group state. heat / pool default to "fresh" (cool + full pool). The
  // flags route burst-end detection: energyPool means consumption.MaxAmmo tracks
  // ammo, heatGated means heatParams.HeatPerShot tracks overheat, virtualMag
  // is the test/fallback path for groups that declare a finite magazine but no
  // consumption or heat (existing fixtures rely on this).
  const groups = weaponGroups.map(g => {
    const isContinuous = !Number.isFinite(g.cadence.magazine);
    const magazine = isContinuous ? Infinity : g.cadence.magazine;
    // Single source of truth for the firing economy (see classifyFiringMode):
    // energy = pool-fed, heat = real-overheat-limited (a stray HeatPerShot with
    // no OverheatTemp stays energy/continuous - the bug that once collapsed
    // bursts to one shot). virtualMag is the test/fallback path for a finite
    // magazine with neither pool nor heat (existing fixtures rely on it).
    const mode = classifyFiringMode(g.consumption, g.heatParams);
    const energyPool = mode === 'energy';
    const heatGated = mode === 'heat';
    const virtualMag = !isContinuous && !energyPool && !heatGated;
    return {
      g,
      nextFire: 0,
      isContinuous,
      energyPool,
      heatGated,
      virtualMag,
      heat: 0,
      // Pool is per-weapon shots remaining. For energy weapons that's MaxAmmo;
      // for virtual-mag tests it's the abstract magazine count; for ballistic
      // with heat the field exists but is unused (heat drives the cycle).
      pool: magazine,
      cooldownUntil: -Infinity,
      lastFireT: -Infinity,
      // SC mechanic: energy regen pauses while the trigger is held. Without
      // tracking this, regen would refill the pool during shotInterval gaps
      // INSIDE a burst (15 shots/s of regen > 12.5 shots/s of fire would
      // keep the CF Badger's pool full forever). `inBurst` flips false on
      // every sync pause - that's "trigger released", regen resumes.
      inBurst: false,
    };
  });

  /** A weapon is distortion-only when ALL of its alpha is distortion. */
  function isDistortionOnly(g) {
    const d = g.dmgByType || {};
    return (d.dist || 0) > 0 && (d.phys || 0) === 0 && (d.energy || 0) === 0;
  }

  // Phase 2: hold distortion until shield breaks. Optimal-play pilot mental
  // model - distortion has 100% shield absorption in 4.x data, so firing it
  // through a live shield wastes ammo. Track mode: 'A' = shield up, distortion
  // held; 'B' = shield broken, everything fires. Skip Mode A if the loadout
  // can't actually break the shield without distortion (degenerate but real
  // edge case: distortion-only loadouts).
  // Start in Mode B if the shield is already down, OR if distortion is held
  // and nothing else can break the shield (distortion-only loadout would
  // otherwise stall forever in Mode A). With holdDistortion=false the
  // distortion weapons fire in Mode A, so even a distortion-only loadout can
  // chip the shield down - no shortcut needed.
  // A weapon that can drive the shield to ZERO on its own, letting distortion
  // stay holstered (Mode A) until it does. Only ENERGY qualifies: ballistic
  // shield drain tapers with shield fraction and asymptotes above 0 (see
  // canDepleteShield), so a ballistic+distortion loadout must RELEASE its
  // distortion (Mode B) to bring the shield down, or it would hold forever.
  const hasEnergyShieldBreaker = weaponGroups.some(g => (g.dmgByType?.energy || 0) > 0);
  // Whether the loadout carries any distortion. The Mode-B "distortion anchors,
  // everything else trickles" model only makes sense when distortion is
  // actually firing. WITHOUT distortion there's no anchor, so Mode B must keep
  // the same synchronized burst-pause discipline as Mode A (otherwise the
  // weapons free-fire with no synced pauses and the pause slider / cycle count
  // become meaningless once the shield drops).
  const hasDistortionWeapon = weaponGroups.some(g => (g.dmgByType?.dist || 0) > 0);
  let mode = (op.shield.maxHp <= 0 || op.shield.hp <= 0 || (holdDistortion && !hasEnergyShieldBreaker)) ? 'B' : 'A';

  // Burst-end detection. Drives synchronized pauses. A non-continuous group
  // ends its burst when its pool empties (energy / virtual mag) or its heat
  // crosses the overheat threshold (ballistic). Distinct from "can fire next" -
  // a partial-pool group from a short prior pause may stop firing mid-burst
  // (canFireNext below) without ever reaching pool === 0.
  function isBurstEnded(cur) {
    if (cur.isContinuous) return false;
    if (cur.energyPool && cur.pool === 0) return true;
    if (cur.heatGated && cur.heat >= (cur.g.heatParams.OverheatTemp || 100)) return true;
    if (cur.virtualMag && cur.pool === 0) return true;
    return false;
  }

  // Whether this group has enough state (ammo / heat headroom) to fire ONE
  // more shot right now. Energy weapons need pool >= 1. Ballistic must not be
  // already at overheat. Virtual-mag tests need pool >= 1.
  function canFireNext(cur) {
    if (cur.isContinuous) return true;
    if (cur.energyPool && cur.pool < 1) return false;
    if (cur.heatGated && cur.heat >= (cur.g.heatParams.OverheatTemp || 100)) return false;
    if (cur.virtualMag && cur.pool < 1) return false;
    return true;
  }

  // Mode B non-distortion recovery: schedule next-fire to when the group can
  // fire again WITHOUT pulling the whole loadout into a sync pause. Energy
  // pools regen back over (1 / MaxRegenPerSec) seconds after cooldown clears.
  // Ballistic weapons reset heat via OverheatFixTime worth of cooling. Used
  // only in Mode B where distortion is the loadout's anchor.
  function scheduleRecovery(cur, tNow) {
    if (cur.energyPool && cur.g.consumption?.MaxRegenPerSec > 0) {
      const needed = Math.max(0, 1 - cur.pool);
      const regenStart = Math.max(tNow, cur.cooldownUntil);
      const waitT = regenStart + needed / cur.g.consumption.MaxRegenPerSec;
      cur.inBurst = false;
      return Math.max(waitT, tNow + cur.g.cadence.shotInterval);
    }
    if (cur.heatGated && cur.g.heatParams?.CoolingPerSecond > 0) {
      const minT = cur.g.heatParams.MinTemp || 0;
      const cps = cur.g.heatParams.CoolingPerSecond;
      const tslc = cur.g.heatParams.TimeTillCoolingStarts || 0;
      const overheat = cur.g.heatParams.OverheatTemp || 100;
      // Wait until heat drops far enough to fire one shot without overheating.
      const targetHeat = Math.max(minT, overheat - cur.g.heatParams.HeatPerShot);
      const excess = cur.heat - targetHeat;
      const coolNeeded = excess > 0 ? excess / cps : 0;
      cur.inBurst = false;
      return tNow + tslc + coolNeeded + cur.g.cadence.shotInterval;
    }
    return tNow + cur.g.cadence.shotInterval;
  }

  // Trigger a synchronized pause: every group's next-fire clock jumps forward
  // by pauseLen (or stays put if already past). All groups exit "burst" state,
  // releasing the trigger so regen can flow during the pause. Virtual-mag
  // groups have no state path to refill via integration, so we explicitly
  // refill them here (matches the existing test fixture expectation).
  // Project shield HP forward over [tNow, tTo] WITHOUT mutating state - used so
  // the pause-end log row shows the regen that will have happened by the time
  // the next burst starts (the sim itself applies it lazily on the next event).
  // Mirrors integrateShieldRegen's window math exactly.
  function projectedShield(tNow, tTo) {
    if (shieldRegenRate <= 0 || op.shield.maxHp <= 0 || op.shield.hp >= op.shield.maxHp) return op.shield.hp;
    let regenStart;
    if (op.shield.hp > 0) regenStart = lastShieldDmgT + shieldDamagedDelay;
    else if (shieldDownedDelay > 0) regenStart = lastShieldDmgT + shieldDownedDelay;
    else return op.shield.hp;
    const win = Math.max(0, tTo - Math.max(tNow, regenStart));
    return Math.min(op.shield.maxHp, op.shield.hp + shieldRegenRate * win);
  }

  // Same idea for the distortion pool, so the pause-end row shows the bleed the
  // pause will have caused rather than the pre-pause level (the sim applies it
  // lazily on the next event). Mirrors integrateDistortionDecay's window math.
  function projectedDistortion(tNow, tTo) {
    if (distortionDecayRate <= 0 || distortionPool <= 0) return distortionPool;
    const win = Math.max(0, tTo - Math.max(tNow, lastDistortionHitT + distortionDecayDelay));
    return Math.max(0, distortionPool - distortionDecayRate * win);
  }

  // Signature of the defender's pools - used to detect a stable cycle (one that
  // returns to the exact same state, e.g. a pause long enough to fully regen
  // the shield so each burst is identical). Such a loop never converges, so we
  // stop. Rounded to hundredths to dodge float noise.
  function stateSignature() {
    const r = (n) => Math.round(n * 100);
    return `${r(op.shield.hp)}|${r(op.armor.hp)}|${r(vitalHp)}|${r(ppHp)}|${r(distortionPool)}`;
  }
  let lastBurstSignature = null;
  let stableCycle = false;

  function syncPause(triggerer, tNow) {
    const resumeAt = tNow + pauseLen;
    // Stable-cycle detection: if this burst ended at the EXACT same defender
    // state as the immediately-previous one, no net progress was made this
    // cycle (e.g. the pause fully regenerates the shield each time) - flag it so
    // the loop can stop instead of grinding to HARD_CAP. Re-evaluated every
    // pause (NOT latched): a single transient match - e.g. a 0-duration recovery
    // pause - must not poison a later cycle that does make progress, which once
    // truncated long ballistic-vs-hull kills under distortion-hold.
    const sig = stateSignature();
    stableCycle = (sig === lastBurstSignature);
    lastBurstSignature = sig;

    // Distortion treadmill check, once per burst. A burst that landed
    // distortion but could not push the pool past the previous burst's peak
    // means the decay between bursts is eating at least as much as the burst
    // adds. Bursts that fired no distortion at all (Mode A holding) are skipped
    // so the hold phase can't be mistaken for a stall.
    if (distortionCycleHadHit && distortionDecayRate > 0) {
      const epsilon = Math.max(distortionMax * 1e-6, 1e-9);
      if (distortionCyclePeak <= distortionPrevCyclePeak + epsilon) distortionStalled = true;
      distortionPrevCyclePeak = distortionCyclePeak;
    }
    distortionCyclePeak = 0;
    distortionCycleHadHit = false;

    for (const gr of groups) {
      if (gr.nextFire < resumeAt) gr.nextFire = resumeAt;
      gr.inBurst = false;
    }
    if (triggerer.virtualMag) {
      triggerer.pool = triggerer.g.cadence.magazine;
    }
    result.totalCycles += 1;
    if (captureLog) {
      // Record burst-end / pause-start snapshot. The next event fires at
      // resumeAt; the pause-end row reflects projected shield regen over the
      // pause so it isn't misleadingly identical to burst-end.
      result.log.push(logEntry('burst-end', tNow, result.totalCycles));
      result.log.push(logEntry(
        'pause-end', resumeAt, result.totalCycles,
        projectedShield(tNow, resumeAt), projectedDistortion(tNow, resumeAt),
      ));
    }
  }

  function logEntry(phase, t, cycle, shieldHpOverride, distortionOverride) {
    const shieldHp = shieldHpOverride != null ? shieldHpOverride : op.shield.hp;
    const distPool = distortionOverride != null ? distortionOverride : distortionPool;
    return {
      cycle, phase, t,
      shieldHp,
      shieldPct: op.shield.maxHp > 0 ? shieldHp / op.shield.maxHp : null,
      armorHp: op.armor.hp,
      armorPct: op.armor.maxHp > 0 ? op.armor.hp / op.armor.maxHp : null,
      vitalHp,
      vitalMaxHp: opponent.hull.smallestVitalHp || 0,
      ppHp,
      ppMaxHp: op.powerplant.maxHp || 0,
      distortionPool: distPool,
      distortionMax,
      // Dynamic mitigation snapshot (armor deflection threshold scales with
      // armorFrac; resistances are static but included so the log is
      // self-contained).
      armorThreshold: {
        phys: (op.armor.threshold.phys || 0) * (op.armor.maxHp > 0 ? op.armor.hp / op.armor.maxHp : 0),
        energy: (op.armor.threshold.energy || 0) * (op.armor.maxHp > 0 ? op.armor.hp / op.armor.maxHp : 0),
        dist: (op.armor.threshold.dist || 0) * (op.armor.maxHp > 0 ? op.armor.hp / op.armor.maxHp : 0),
      },
      shieldResistance: shieldHp > 0 ? { ...op.shield.resistance } : { phys: 0, energy: op.shield.resistance.energy, dist: 0 },
      totalDamage,
    };
  }

  // Apply inter-event physical-state integration to every group between
  // [tPrev, tNow]. Idempotent for groups with no heat or no consumption.
  function integrateWeaponStates(tPrev, tNow) {
    if (tNow <= tPrev) return;
    const dt = tNow - tPrev;
    for (const gr of groups) {
      const hp = gr.g.heatParams;
      if (hp) {
        // Cooling only starts TimeTillCoolingStarts seconds after last shot.
        // If the gap fully covers that delay, the cooling window is the
        // remaining portion. Cap at the full dt.
        const tslc = hp.TimeTillCoolingStarts || 0;
        const cps = hp.CoolingPerSecond || 0;
        const minT = hp.MinTemp || 0;
        if (cps > 0 && gr.heat > minT) {
          const sinceLastShot = tNow - gr.lastFireT;
          const coolingWindow = sinceLastShot > tslc
            ? Math.min(dt, sinceLastShot - tslc)
            : 0;
          if (coolingWindow > 0) {
            gr.heat = Math.max(minT, gr.heat - cps * coolingWindow);
          }
        }
      }
      const co = gr.g.consumption;
      if (co?.MaxRegenPerSec > 0 && gr.pool < gr.g.cadence.magazine && !gr.inBurst) {
        // Regen only flows when the trigger is released (inBurst=false) and
        // the post-empty Cooldown window has expired. During a burst the
        // shotInterval gaps don't refill the pool - that's the SC mechanic
        // the inBurst flag captures.
        const regenStart = Math.max(tPrev, gr.cooldownUntil);
        const regenWindow = Math.max(0, tNow - regenStart);
        if (regenWindow > 0) {
          gr.pool = Math.min(gr.g.cadence.magazine, gr.pool + co.MaxRegenPerSec * regenWindow);
        }
      }
    }
  }

  // Apply enemy shield regen over [tPrev, tNow]. BOTH the damaged-shield and
  // downed-shield recovery windows key off `lastShieldDmgT` - the last moment
  // the ship took ANY damage. For the shield to recover, the ship must take no
  // damage for the full delay window:
  //   - shield > 0  → recovers after lastShieldDmgT + DamagedDelay
  //   - shield == 0 → recovers after lastShieldDmgT + DownedDelay (longer)
  // Keying the downed window off lastShieldDmgT (not the moment the shield
  // first hit zero) means sustained distortion / armor / hull pressure keeps a
  // broken shield down indefinitely - exactly the pilot intent. A shield only
  // climbs back once the attacker stops landing hits.
  function integrateShieldRegen(tPrev, tNow) {
    if (tNow <= tPrev || shieldRegenRate <= 0 || op.shield.maxHp <= 0) return;
    if (op.shield.hp >= op.shield.maxHp) return;
    let regenStart;
    if (op.shield.hp > 0) {
      regenStart = lastShieldDmgT + shieldDamagedDelay;
    } else if (shieldDownedDelay > 0) {
      regenStart = lastShieldDmgT + shieldDownedDelay;
    } else {
      return;
    }
    const regenWindow = Math.max(0, tNow - Math.max(tPrev, regenStart));
    if (regenWindow > 0) {
      op.shield.hp = Math.min(op.shield.maxHp, op.shield.hp + shieldRegenRate * regenWindow);
    }
  }

  /**
   * Bleed the distortion pool over [tPrev, tNow]. Same window shape as
   * integrateShieldRegen: nothing happens until `distortionDecayDelay` seconds
   * after the last distortion hit, then the pool drains at the generator's
   * DecayRate. Any distortion hit resets `lastDistortionHitT`, so continuous
   * fire keeps decay switched off entirely - only the gaps cost pool.
   */
  function integrateDistortionDecay(tPrev, tNow) {
    if (tNow <= tPrev || distortionDecayRate <= 0 || distortionPool <= 0) return;
    const decayStart = lastDistortionHitT + distortionDecayDelay;
    const decayWindow = Math.max(0, tNow - Math.max(tPrev, decayStart));
    if (decayWindow > 0) {
      distortionPool = Math.max(0, distortionPool - distortionDecayRate * decayWindow);
    }
  }

  let t = 0;
  let tPrev = 0;
  let eventsSinceProgress = 0;

  if (captureLog) {
    result.log.push(logEntry('init', 0, 0));
  }

  for (let ev = 0; ev < HARD_CAP; ev++) {
    // Earliest-scheduled group fires next.
    let cur = groups[0];
    for (const gr of groups) if (gr.nextFire < cur.nextFire) cur = gr;
    tPrev = t;
    t = cur.nextFire;

    // Inter-event integration: cool / regen per-weapon state, then advance
    // shield regen. Order doesn't matter (they don't read each other), but
    // both must run before this event's shots land.
    integrateShieldRegen(tPrev, t);
    integrateDistortionDecay(tPrev, t);
    integrateWeaponStates(tPrev, t);

    // Phase 2: in Mode A (shield up), held distortion-only weapons stay
    // holstered. We skip their event slot and re-schedule for shotInterval
    // later; the mode flips to B the moment shield reaches 0 (handled below
    // when the shot lands). Skipped entirely when holdDistortion=false.
    if (mode === 'A' && holdDistortion && isDistortionOnly(cur.g)) {
      cur.nextFire = t + cur.g.cadence.shotInterval;
      continue;
    }

    // Soft-empty check: the group's pool / heat state may have left it unable
    // to fire. In Mode A (or for distortion-only in Mode B), trigger a sync
    // pause so the whole loadout holds together. In Mode B for non-distortion
    // weapons, just wait for ITS recovery without holding everyone - the
    // distortion-anchor model: distortion runs the cycle, energy/ballistic
    // follow at their own pace.
    if (!canFireNext(cur)) {
      if (mode === 'B' && hasDistortionWeapon && !isDistortionOnly(cur.g)) {
        cur.nextFire = scheduleRecovery(cur, t);
        continue;
      }
      syncPause(cur, t);
      continue;
    }

    const g = cur.g;
    let progressed = false;

    // The whole stack of `count` identical weapons fires this tick; apply each
    // shot against the live (draining) pools so absorption/threshold scaling
    // tracks current HP exactly as the chain intends.
    for (let s = 0; s < g.count; s++) {
      const shot = simulateShot(g, op, options);

      // Any damage of any kind resets the shield's regen timer: for the
      // shield to start regenerating, the ship must take NO damage of any
      // form during the DamagedDelay window. Armor / hull / component /
      // distortion hits all keep the shield suppressed, not just shield HP
      // loss. This is what holds a broken shield down through the Mode B
      // distortion grind (and through any sustained armor/hull pressure).
      const anyDamage = shot.shieldDmg > 0 || shot.armorDmg > 0
        || shot.hullDmg > 0 || shot.componentDmg > 0 || shot.distortionDmg > 0;
      if (anyDamage) lastShieldDmgT = t;

      // `progressed` counts damage ONLY toward UNRESOLVED outcomes. Once an
      // outcome resolves, further damage to that pool is no longer progress -
      // otherwise distortion fired past a full pool (or shield chipped after
      // break) would keep the sim alive forever against an opponent whose
      // armor/hull/PP are unreachable (every energy shot deflected). This is
      // what bounds the run: when no unresolved outcome can advance, we stop.
      if (shot.shieldDmg > 0) {
        op.shield.hp = Math.max(0, op.shield.hp - shot.shieldDmg);
        ever.shield = true;
        totalDamage += shot.shieldDmg;
        // Shield drain is progress while it still MATTERS. Energy/distortion can
        // fully deplete the shield, so any drain counts. Ballistic can't (the
        // absorption taper asymptotes above 0) - but draining the shield lowers
        // absorption and RAISES the pass-through that eventually penetrates the
        // armor, so it is real progress toward the KILL until the per-shot drain
        // falls below shieldDrainFloor (the shield has bottomed out; if nothing
        // has penetrated by then, nothing will). breakShields itself stays
        // Infinity for ballistic - the record is gated separately - so this only
        // governs whether the sim keeps grinding the shield down.
        if (result.breakShields === Infinity && (canDepleteShield || shot.shieldDmg >= shieldDrainFloor)) {
          progressed = true;
        }
      }
      if (shot.armorDmg > 0)  {
        op.armor.hp = Math.max(0, op.armor.hp - shot.armorDmg);
        ever.armor = true; totalDamage += shot.armorDmg;
        if (result.breakArmor === Infinity) progressed = true;
      }
      if (shot.hullDmg > 0)   {
        vitalHp = Math.max(0, vitalHp - shot.hullDmg);
        ever.hull = true; totalDamage += shot.hullDmg;
        if (result.killVital === Infinity) progressed = true;
      }
      if (shot.componentDmg > 0 && !shot.distortionDmg) {
        // Penetration-distance reach gate: a weapon whose BasePenetrationDistance
        // is below the opponent's ppReach can't physically reach the power plant,
        // so its component damage is discarded (the round stops short in the
        // hull). Raw basePen vs reach - matches the "Pen dist" stat shown to the
        // user. 0 = off. Distortion (below) is exempt - its reach is aim-based.
        if (ppReach > 0 && (g.basePen || 0) < ppReach) {
          ppReachBlocked = true;
        } else {
          ppHp = Math.max(0, ppHp - shot.componentDmg);
          ever.pp = true; totalDamage += shot.componentDmg;
          if (result.disablePowerplant === Infinity) progressed = true;
        }
      }
      if (shot.distortionDmg > 0) {
        ever.dist = true;
        // NO reach gate here, unlike physical component damage: distortion
        // reach is aim-based, not penetration-based. PTU 4.9 zeroed
        // BasePenetrationDistance on every distortion weapon, yet distortion
        // still disables when the shot lands on the component section - and
        // this sim assumes ideal aim.
        if (distortionMax <= 0 || distortionPool < distortionMax) {
          // Cap the pool at max - distortion past a filled pool is wasted, and
          // counting it would falsely register progress. Only the portion that
          // actually fills the pool is real damage.
          const applied = distortionMax > 0
            ? Math.min(shot.distortionDmg, distortionMax - distortionPool)
            : shot.distortionDmg;
          distortionPool += applied;
          totalDamage += applied;
          // Landing a hit restarts the decay delay, so a burst holds the pool.
          lastDistortionHitT = t;
          distortionCycleHadHit = true;
          if (distortionPool > distortionCyclePeak) distortionCyclePeak = distortionPool;
          if (distortionPool > distortionPeak) distortionPeak = distortionPool;
          // Filling counts as progress until the burst-over-burst comparison in
          // syncPause has shown that decay is winning.
          if (result.disableDistortion === Infinity && !distortionStalled) progressed = true;
        }
      }

      // Per-shot detail for the expandable log. One entry per volley (the
      // `count` identical weapons firing this tick are summed). Captures the
      // damage split + post-shot pool state so a tester can audit the chain
      // shot by shot. Capped at SHOT_LOG_CAP to bound long fights.
      if (captureLog && result.shotLog.length < SHOT_LOG_CAP) {
        result.shotLog.push({
          cycle: result.totalCycles + 1,
          t,
          weapon: g.name,
          shieldDmg: shot.shieldDmg, armorDmg: shot.armorDmg, hullDmg: shot.hullDmg,
          componentDmg: shot.componentDmg, distortionDmg: shot.distortionDmg,
          shieldHp: op.shield.hp, armorHp: op.armor.hp, vitalHp, ppHp, distortionPool,
        });
      }

      // Record first-crossing times (and the defensive state) at the current
      // clock t. Total damage at the outcome moment lets the UI compute
      // effective DPS = totalDamage / outcomeTime. `burstNo` is the 1-indexed
      // burst the outcome lands in (= completed pauses + 1) - matches the
      // shotLog / burst-end cycle numbering so the expandable log lines up.
      const burstNo = result.totalCycles + 1;
      if (canDepleteShield && result.breakShields === Infinity && op.shield.maxHp > 0 && op.shield.hp === 0) {
        result.breakShields = t; result.snapshot.breakShields = snap();
        result.damageAt.breakShields = totalDamage;
        result.cyclesAt.breakShields = burstNo;
        if (captureLog) result.log.push(logEntry('outcome: shield broke', t, burstNo));
        // Phase 2 mode switch: unleash any held distortion weapons. Pull
        // their nextFire back to NOW so they can fire on the same tick that
        // shields drop (matches the "switch to all-fire" pilot mental model).
        if (mode === 'A') {
          mode = 'B';
          for (const gr of groups) {
            if (isDistortionOnly(gr.g) && gr.nextFire > t) gr.nextFire = t;
          }
        }
      }
      if (result.breakArmor === Infinity && op.armor.maxHp > 0 && op.armor.hp === 0) {
        result.breakArmor = t; result.snapshot.breakArmor = snap();
        result.damageAt.breakArmor = totalDamage;
        result.cyclesAt.breakArmor = burstNo;
        if (captureLog) result.log.push(logEntry('outcome: armor broke', t, burstNo));
      }
      if (result.killVital === Infinity && (opponent.hull.smallestVitalHp || 0) > 0 && vitalHp === 0) {
        result.killVital = t; result.snapshot.killVital = snap();
        result.damageAt.killVital = totalDamage;
        result.cyclesAt.killVital = burstNo;
        if (captureLog) result.log.push(logEntry('outcome: vital killed', t, burstNo));
      }
      if (result.disablePowerplant === Infinity && op.powerplant.maxHp > 0 && ppHp === 0) {
        result.disablePowerplant = t; result.snapshot.disablePowerplant = snap();
        result.damageAt.disablePowerplant = totalDamage;
        result.cyclesAt.disablePowerplant = burstNo;
        if (captureLog) result.log.push(logEntry('outcome: PP disabled', t, burstNo));
      }
      if (result.disableDistortion === Infinity && distortionMax > 0 && distortionPool >= distortionMax) {
        result.disableDistortion = t; result.snapshot.disableDistortion = snap();
        result.cyclesAt.disableDistortion = burstNo;
        result.damageAt.disableDistortion = totalDamage;
        if (captureLog) result.log.push(logEntry('outcome: distortion disabled', t, burstNo));
      }
    }

    // Per-shot physical state update for the FIRING group only (others just
    // integrated above). Each shot heats the ballistic / drains the energy
    // pool. Cooldown ONLY arms when the pool reaches exactly 0 here - that is
    // the SC mechanic for "fully depleted, weapon locks out briefly". If the
    // burst ends with pool > 0 (sync pause from another weapon), no cooldown.
    const hp = g.heatParams;
    if (hp && (hp.HeatPerShot || 0) > 0) {
      cur.heat = Math.min((hp.OverheatTemp || 100), cur.heat + hp.HeatPerShot);
    }
    if (cur.energyPool) {
      cur.pool = Math.max(0, cur.pool - 1);
      if (cur.pool === 0 && cur.cooldownUntil < t) {
        cur.cooldownUntil = t + (g.consumption.Cooldown || 0);
      }
    } else if (cur.virtualMag) {
      cur.pool = Math.max(0, cur.pool - 1);
    }
    cur.lastFireT = t;
    // Trigger held - the group is actively firing, regen is gated off until
    // the next sync pause releases it (see integrateWeaponStates).
    cur.inBurst = true;

    const allResolved =
      result.breakShields !== Infinity &&
      result.breakArmor !== Infinity &&
      result.killVital !== Infinity &&
      result.disablePowerplant !== Infinity &&
      result.disableDistortion !== Infinity;
    if (allResolved) break;

    // We deliberately do NOT stop when the vital part dies. Every outcome is
    // reported on its own merits, independent of which one lands first - so a
    // distortion soft-disable of the power plant gets its real time even when
    // the energy weapons would hard-kill the hull a few seconds sooner.
    // Rationale: every other damage type has to actually HIT the component
    // (hard during a dogfight), whereas distortion damages the plant by reach
    // alone, so its time is meaningful regardless of the kill. Genuinely
    // unreachable outcomes (reach gate, deflection, can't deplete a shield,
    // shields absorb all distortion) still resolve to Infinity via the
    // no-progress / stable-cycle guards below.

    // Generous threshold for the no-progress early-out. The check is meant
    // to catch fully degenerate loadouts (everything deflected, nothing
    // hitting any pool), not asymmetric scheduling where a fast-firing energy
    // weapon takes multiple deflected shots between each distortion shot.
    // groups.length * 20 lets sparse-progress patterns survive while still
    // catching truly stuck sims long before HARD_CAP.
    if (progressed) eventsSinceProgress = 0;
    else if (++eventsSinceProgress >= groups.length * 20) break;

    // Burst-end check. Mode A or distortion-only in Mode B: hold ALL groups
    // for pauseLen (full sync pause). Mode B non-distortion: own recovery
    // path, distortion stays as the loadout's anchor.
    if (isBurstEnded(cur)) {
      if (mode === 'B' && hasDistortionWeapon && !isDistortionOnly(cur.g)) {
        cur.nextFire = scheduleRecovery(cur, t);
        continue;
      }
      syncPause(cur, t);
      // syncPause sets stableCycle when this burst ended at the same defender
      // state as the previous one. A stable loop can't resolve any further
      // outcome (the pause undoes each burst), so stop here.
      if (stableCycle) break;
      continue;
    }
    cur.nextFire = t + g.cadence.shotInterval;
  }

  // Terminal log row. The sim usually stops MID-burst (kill / all-resolved /
  // no-progress) without a closing sync pause, so the final burst has no
  // burst-end row - and that's the burst where the decisive outcomes land.
  // Emit an 'end' row for it (cycle = current burst number) so the UI can
  // expand its per-shot detail. Skip if the last row already closed this
  // burst (sim ended right on a sync pause).
  if (captureLog) {
    const finalBurst = result.totalCycles + 1;
    const lastRow = result.log[result.log.length - 1];
    const alreadyClosed = lastRow && lastRow.phase === 'pause-end' && lastRow.cycle === result.totalCycles;
    const hasShots = result.shotLog.some(s => s.cycle === finalBurst);
    if (hasShots && !alreadyClosed) {
      result.log.push(logEntry('end', t, finalBurst));
    }
  }

  // Infinity reasons. Outcomes are computed independently (the sim does not stop
  // at the hull kill), so an Infinity here means the outcome is genuinely
  // unreachable for this loadout/target - never just "the kill came first".
  if (result.breakShields === Infinity) {
    if (op.shield.maxHp <= 0) {
      result.reasons.breakShields = 'no shield';
    } else if (!canDepleteShield) {
      // Ballistic shield drain tapers with shield fraction and asymptotes above
      // 0 (see canDepleteShield), so a loadout with no energy / distortion can
      // never fully deplete a shield no matter how long it fires.
      result.reasons.breakShields = 'ballistic fire can\'t fully deplete a shield';
    } else {
      // Energy / distortion CAN reach 0, so an Infinity here means regen out-
      // paced the drain (or the sim stalled at a stable cycle).
      result.reasons.breakShields = 'shield regen outpaces damage';
    }
  }
  if (result.breakArmor === Infinity) {
    if (op.armor.maxHp <= 0) {
      result.reasons.breakArmor = 'no armor';
    } else if (!ever.armor) {
      result.reasons.breakArmor = 'all damage is deflected';
    } else {
      result.reasons.breakArmor = null;
    }
  }
  if (result.killVital === Infinity) {
    result.reasons.killVital = !ever.hull ? 'cannot penetrate to hull' : null;
  }
  if (result.disablePowerplant === Infinity) {
    result.reasons.disablePowerplant = op.powerplant.maxHp <= 0
      ? 'no power-plant data'
      : (!ever.pp && ppReachBlocked)
        ? `penetration below ${ppReach} m reach`
        : 'cannot penetrate to power plant';
  }
  if (result.disableDistortion === Infinity) {
    // Distinguish the two real causes. Shields have 100% distortion absorption
    // in 4.x data, so distortion does ZERO through a live shield - a loadout
    // that carries distortion weapons but can't break shields never lands any.
    // (hasDistortionWeapon is hoisted to the top of the sim.)
    if (distortionMax <= 0) {
      result.reasons.disableDistortion = 'no distortion pool';
    } else if (!hasDistortionWeapon) {
      result.reasons.disableDistortion = 'no distortion weapons';
    } else if (op.shield.maxHp > 0 && result.breakShields === Infinity) {
      result.reasons.disableDistortion = 'shields absorb all distortion';
    } else if (ever.dist && distortionDecayRate > 0 && distortionPeak < distortionMax) {
      // Distortion landed but the pool never topped out: between bursts the
      // generator bled back more than the next burst could add. Shortening the
      // cooling pause below the generator's decay delay is the fix, so name the
      // cause rather than reporting a flat "insufficient".
      result.reasons.disableDistortion = 'distortion decays faster than it lands';
    } else {
      result.reasons.disableDistortion = 'insufficient distortion';
    }
  }

  return result;
}

/**
 * Convenience: combined sustained DPS of a weapon-group set (count-weighted),
 * for an at-a-glance header readout. Pure sum of per-group sustainedDPS x count.
 */
export function totalSustainedDPS(weaponGroups) {
  let sum = 0;
  for (const g of (weaponGroups || [])) sum += (g.sustainedDPS || 0) * (g.count || 1);
  return sum;
}
