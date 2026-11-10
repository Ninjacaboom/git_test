/**
 * Deflection calculator - pure damage-chain logic.
 *
 * Full damage chain (5 stages):
 *
 *     alpha -> Shield -> Armor -> Hull -> Component
 *
 *  ENERGY:    shield blocks `mitigated × absorption.energy` of damage. With
 *             absorption.energy == 1.0 (every shield in 4.x data) nothing
 *             leaks until the shield empties - same behaviour as the previous
 *             "binary" model but routed through the absorption field so a
 *             future <100% shield works correctly. Once shield = 0, alpha
 *             flows into the Armor -> Hull -> Component pipeline below.
 *
 *  BALLISTIC: mitigated alpha = alpha × (1 − resistance.phys). That pool is
 *             SPLIT by shield absorption: effAbs × mitigated drains shield
 *             HP, (1 − effAbs) × mitigated passes through. effAbs scales
 *             linearly with shield HP fraction (baseAbs × shieldHp /
 *             shieldMaxHp) - at full shield ≈ baseAbs, at empty = 0.
 *             Deflection check runs on the pass-through (NOT raw alpha).
 *
 *  DISTORTION: does not damage armor / hull / component at all. Hits the
 *              shield with `× (1 − resistance.dist)` mitigation; the
 *              `× (1 − absorption.dist)` portion targets a separate
 *              powerplant distortion HP pool (simulated by the TTK calc).
 *              With absorption.dist == 1.0 (every shield in 4.x data) NOTHING
 *              reaches that pool until the shield is fully down. Distortion
 *              does not use the penetration mechanic at all - PTU 4.9 zeroed
 *              BasePenetrationDistance on every distortion weapon; reaching
 *              components is aim-based (hit the component section).
 *
 * Once post_shield damage clears the deflection threshold the same chain
 * applies for ballistic and energy:
 *
 *   raw_through = post_shield × hullMult.{type}              [× durMult if on]
 *   if armor.hp > 0 and post_shield > armor.hp -> ARMOR BREAK
 *       armor_dmg = armor.hp                                 (cap)
 *       hull_dmg  = (post_shield − armor.hp) × hullMult.{type}
 *   else
 *       armor_dmg = raw_through                              (no overflow)
 *       hull_dmg  = 0
 *
 *   Component penetration:
 *       pen_ratio   = 1.0                                    when armor broke
 *                     RESIDUAL + (1−RESIDUAL) × (1−armorFrac) otherwise
 *       pen_mult    = hull.penetration.component × pen_ratio
 *       pen_dist    = weapon.basePen × pen_ratio             (display only)
 *       component_dmg = raw_through × pen_mult
 *
 * RESIDUAL_PEN_RATIO (6%) is an empirical approximation; the reference shows a
 * tiny non-zero penetration even at full armor (e.g. M6A vs Guardian at
 * 100% armor: 0.2 m / 23 dmg). 6% gets us within ~10% of the displayed
 * multiplier at full armor and within ~5% across the rest of the curve.
 *
 * Armor.Durability.DamageMultipliers is in flux upstream (STARC-198632) -
 * controlled by simulateShot's options.applyArmorDurability (default true
 * = game-realistic, false = reference-matched).
 * https://issue-council.robertsspaceindustries.com/projects/STAR-CITIZEN/issues/STARC-198632
 *
 * v1 simplifications:
 *  - Bubble-equivalent shield model (total HP across all faces).
 *  - Shield resistance at Maximum (full enemy pips assumed).
 *  - Weapon power fraction not applied (full power assumed).
 *  - Crafted weapon alpha respected via getCraftedItemStats.
 *  - Distortion powerplant damage not simulated.
 *  - Component HP pools not tracked (we just show the damage that reaches
 *    components per shot - the user knows which subsystems are at risk).
 */

import { getCraftedItemStats } from './loadoutManager.js';
import { getMeanQuality } from './craftingUI.js';
import { calcSustainedDPS } from './sustained.js';

/** Damage-type buckets we simulate. Extend if CIG ships more (thermal, etc.). */
const DAMAGE_TYPES = ['phys', 'energy', 'dist'];

/** Map our short keys → CIG field names. */
const TYPE_FIELD = { phys: 'Physical', energy: 'Energy', dist: 'Distortion' };

/**
 * Walk the active ship's slot tree and return every equipped weapon
 * grouped by className. Disabled ports are excluded. Mining/utility/etc.
 * items are filtered out - we only keep things with a Weapon.Firing entry.
 *
 * @returns {Array<{
 *   className: string,
 *   name: string,
 *   type: string,
 *   count: number,
 *   alpha: number,                    // sum across damage types
 *   dmgByType: { phys, energy, dist }, // per damage-type alpha
 *   basePen: number,                  // BasePenetrationDistance in metres
 *   meanQuality: number,              // mean crafting quality across slots
 *   ports: string[]
 * }>}
 *
 * Note: groups by (className, computed-stats fingerprint), NOT by className
 * alone. Two M6A Cannons crafted to different qualities produce different
 * alpha / basePen and need separate rows in the damage table because their
 * chain numbers differ.
 */
export function enumerateLoadoutWeapons(loadout, slots, disabledPorts) {
  if (!loadout || !slots) return [];
  const found = new Map();
  const disabled = disabledPorts instanceof Set ? disabledPorts : new Set();

  function visit(slot) {
    if (!slot) return;
    // Mount-header convention (matches weaponColumn.js): if a slot has
    // visible sub-ports, the parent is treated as a gimbal/turret mount
    // and contributes NO damage of its own - only the sub-weapons fire.
    // CIG ships some hardpoints as stacked mounts (e.g. Sabre Firebird's
    // `hardpoint_weapon_left_wing` holds a Mantis GT-220 default + a
    // `hardpoint_class_2` sub-port that holds the actual CF-337). The
    // parent's own Weapon.Firing data is real but unused in this mount
    // configuration.
    const hasSubWeaponPorts = (slot.ports || []).length > 0;
    const cn = loadout[slot.portName];
    if (cn && !disabled.has(slot.portName) && !hasSubWeaponPorts) {
      const si = getCraftedItemStats(cn, slot.portName);
      const firing = si?.Weapon?.Firing?.[0];
      const dmgPerShot = firing?.DamagePerShot;
      if (dmgPerShot) {
        const phys = dmgPerShot.Physical || 0;
        const energy = dmgPerShot.Energy || 0;
        const dist = dmgPerShot.Distortion || 0;
        const alpha = phys + energy + dist;
        if (alpha > 0) {
          // BasePenetrationDistance is the weapon's max penetration depth
          // (in metres) at zero armor. Lives on the ammunition definition:
          // Weapon.Ammunition.Penetration.BasePenetrationDistance.
          const basePen = si?.Weapon?.Ammunition?.Penetration?.BasePenetrationDistance || 0;
          // Mean crafting quality for the port. Defaults to 500 when there's
          // no blueprint or no deviation; deviating qualities (e.g. a
          // max-rolled 1000 or a min-rolled 0) end up as separate rows.
          let meanQuality = 500;
          try { meanQuality = getMeanQuality(slot.portName, cn); } catch {}
          // Group by className + stats fingerprint so a stack of identical
          // weapons collapses but a mixed-quality pair stays split. The
          // fingerprint is the computed alpha + basePen rather than the
          // raw quality so two ports that happen to roll the same number
          // group as one row.
          const key = `${cn}::${phys}:${energy}:${dist}:${basePen}`;
          if (!found.has(key)) {
            // NOTE: si.Type here is the raw stdItem taxonomy ('WeaponGun.Gun'),
            // NOT deriveType()'s damage-prefixed form - it carries no damage
            // keyword. Damage routing in this calculator uses dmgByType; do not
            // classify rows off this string (a categorize() call here always
            // returned 'Other' and was removed as a dead, misleading field).
            const typeStr = si.Type || si.Classification || '';
            // Sustained DPS (infinite-time avg incl. heat/ammo/reload) at full
            // power - matches the calculator's "full power" assumption. Drives
            // the time-to-break readout: sustainedDPS / alpha = shots/second.
            let sustainedDPS = 0;
            try { sustainedDPS = calcSustainedDPS(si.Weapon, si?.Weapon?.Consumption) || 0; } catch {}
            found.set(key, {
              className: cn,
              name: si.Name || cn,
              type: typeStr,
              count: 0,
              alpha,
              dmgByType: { phys, energy, dist },
              basePen,
              // Impacts per trigger pull. Scatterguns fire a spread whose
              // pellets are each deflected independently, so the armor
              // threshold must see alpha/pellets, not the summed alpha.
              pellets: firing.PelletsPerShot || 1,
              meanQuality,
              sustainedDPS,
              ports: [],
            });
          }
          const e = found.get(key);
          e.count += 1;
          e.ports.push(slot.portName);
        }
      }
    }
    for (const sub of slot.ports || []) visit(sub);
  }

  for (const group of ['weapons', 'turrets']) {
    for (const s of (slots[group] || [])) visit(s);
  }
  return [...found.values()];
}

/**
 * Shield FaceType → number of independently-depleted faces. A shot only drains
 * the facing it hits, so "breaking the shield" means depleting one face's worth
 * of HP, not the summed bubble. Bubble shields present a single face; Quadrant
 * shields split into 4. Unknown / absent types fall back to a single face.
 * Matches SPViewer's "N × hp" shield readout and its shots-to-break count.
 */
export const SHIELD_FACE_COUNTS = { Bubble: 1, Quadrant: 4 };
export function shieldFaceCount(faceType) {
  return SHIELD_FACE_COUNTS[faceType] || 1;
}

/**
 * Build a defensive profile for the opponent. Pulls armor + hull stats
 * straight off the ship config (vehicle_stats.json shape), and shield
 * stats off the chosen shield item's stdItem.
 *
 * @param {object} shipConfig - vehicle stats record (Armor/Hull + Hardpoints)
 * @param {object} shieldItem - stdItem of selected shield (or null)
 * @param {object} shieldCount - number of shield generators equipped (default 1)
 * @param {number} shieldPct - 0-1 fraction of max shield HP currently up
 * @param {number} armorPct - 0-1 fraction of max armor HP currently intact
 */
export function buildOpponentProfile(shipConfig, shieldItem, shieldCount = 1, shieldPct = 1, armorPct = 1) {
  const armor = shipConfig?.Armor || {};
  const hull = shipConfig?.Hull || {};
  const armorDurMult = armor.Durability?.DamageMultipliers || {};
  const hullDmgMult = armor.DamageMultipliers || {};
  const deflection = armor.DamageDeflection || {};
  const penetration = hull.PenetrationDamageMultiplier || {};

  const shieldHpPerGen = shieldItem?.Shield?.Health || 0;
  // Sum across installed generators for the bubble total, then split across
  // shield faces - a shot only drains the face it hits, so the breakable pool
  // is one face's worth (Bubble = 1 face, Quadrant = 4).
  const totalShieldHp = shieldHpPerGen * Math.max(1, shieldCount);
  const faceCount = shieldFaceCount(
    shipConfig?.Hardpoints?.Components?.Systems?.Shields?.FaceType
  );
  const shieldMaxHp = totalShieldHp / faceCount;
  const shieldRes = shieldItem?.Shield?.Resistance || {};
  const shieldAbs = shieldItem?.Shield?.Absorption || {};

  return {
    shield: {
      hp: Math.round(shieldMaxHp * clamp01(shieldPct)),
      maxHp: shieldMaxHp,
      faceCount,
      totalHp: totalShieldHp,
      // Two distinct shield stats:
      //  - resistance: % of incoming damage the shield mitigates (= shield HP
      //    loss reduction)
      //  - absorption: % of incoming alpha the shield blocks from passing
      //    through to armor (separate from resistance, applies only when
      //    shield is up)
      resistance: {
        phys: shieldRes.Physical?.Maximum || 0,
        energy: shieldRes.Energy?.Maximum || 0,
        dist: shieldRes.Distortion?.Maximum || 0,
      },
      absorption: {
        phys: shieldAbs.Physical?.Maximum || 0,
        energy: shieldAbs.Energy?.Maximum || 0,
        dist: shieldAbs.Distortion?.Maximum || 0,
      },
      // Regen telemetry. Additive: the deflection dialog ignores these (its
      // shield is a snapshot, never regens during a shot chain). TTK reads
      // them to model recovery during synced-fire pauses. Per-face regen
      // rate divides the bubble rate by face count - a quadrant generator's
      // 228 hp/s replenishes one face's pool, not the full bubble.
      damagedDelay: shieldItem?.Shield?.DamagedDelay || 0,
      downedDelay: shieldItem?.Shield?.DownedDelay || 0,
      regenRate: (shieldItem?.Shield?.RegenRate || 0) / Math.max(1, faceCount),
    },
    armor: {
      hp: Math.round((armor.Durability?.Health || 0) * clamp01(armorPct)),
      maxHp: armor.Durability?.Health || 0,
      threshold: {
        phys: deflection.Physical || 0,
        energy: deflection.Energy || 0,
        dist: deflection.Distortion || 0,
      },
      durabilityMult: {
        phys: armorDurMult.Physical ?? 1,
        energy: armorDurMult.Energy ?? 1,
        dist: armorDurMult.Distortion ?? 1,
      },
    },
    hull: {
      damageMult: {
        phys: hullDmgMult.Physical ?? 1,
        energy: hullDmgMult.Energy ?? 1,
        dist: hullDmgMult.Distortion ?? 1,
      },
      penetration: {
        fuse: penetration.Fuse ?? 1,
        component: penetration.Component ?? 1,
      },
      vitalParts: hull.StructureHealthPoints?.VitalParts || {},
      // Smallest vital part is the "fastest kill" target for ammo-to-break.
      smallestVitalHp: smallestVital(hull.StructureHealthPoints?.VitalParts || {}),
    },
  };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 1;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function smallestVital(parts) {
  let min = Infinity;
  for (const v of Object.values(parts || {})) {
    if (typeof v === 'number' && v > 0 && v < min) min = v;
  }
  return Number.isFinite(min) ? min : 0;
}

/** Empirical residual penetration ratio at full armor. See module header. */
const RESIDUAL_PEN_RATIO = 0.06;

/**
 * Effective mitigation percentages at the opponent's CURRENT shield/armor
 * state, derived from the SAME formulas simulateShot uses. The mitigation
 * table renders these so its numbers always agree with the per-weapon chain
 * below it (rather than showing the static 100%-shield / 100%-armor values).
 *
 *  - Shield absorption (phys) scales linearly with shield HP fraction
 *    (effAbs = base × shieldFrac, matching the ballistic branch). Energy /
 *    distortion absorption is all-or-nothing: full while the shield is up,
 *    0 once it drops (those branches skip absorption entirely at hp == 0).
 *  - Shield resistance is FLAT while the shield is up (not HP-scaled). Phys
 *    and distortion resistance only apply through a live shield, so they read
 *    0 at 0% shield; the energy branch applies its resistance unconditionally,
 *    so energy resistance stays at its base value even with the shield down.
 *  - Deflection threshold scales linearly with armor integrity
 *    (base × armorFrac), reaching 0 at 0% armor - stripped armor deflects
 *    less. Matches SPViewer's armor-slider behaviour and the scaled threshold
 *    runArmorPipeline now applies in the deflection check.
 *
 * Component penetration, armor durability and hull multipliers are static ship
 * properties (the table renders those unchanged). Note: the per-shot component
 * DAMAGE in runArmorPipeline still grows with penetration depth as armor is
 * stripped - that's a separate quantity from the flat hull Component
 * multiplier shown in the mitigation row.
 */
export function effectiveMitigation(opponent) {
  const shieldUp = opponent.shield.hp > 0;
  const shieldFrac = opponent.shield.maxHp > 0
    ? opponent.shield.hp / opponent.shield.maxHp
    : 0;
  const armorFrac = opponent.armor.maxHp > 0
    ? opponent.armor.hp / opponent.armor.maxHp
    : 0;
  const res = opponent.shield.resistance;
  const abs = opponent.shield.absorption;
  return {
    resistance: {
      phys: shieldUp ? res.phys : 0,
      energy: res.energy,
      dist: shieldUp ? res.dist : 0,
    },
    absorption: {
      phys: shieldUp ? abs.phys * shieldFrac : 0,
      energy: shieldUp ? abs.energy : 0,
      dist: shieldUp ? abs.dist : 0,
    },
    threshold: {
      phys: opponent.armor.threshold.phys * armorFrac,
      energy: opponent.armor.threshold.energy * armorFrac,
      dist: opponent.armor.threshold.dist * armorFrac,
    },
  };
}

/**
 * Run the post-shield armor / hull / component pipeline for one damage type.
 * Pure helper, doesn't mutate. Returned `armorDmg` is what the armor row
 * displays (capped at armor HP if the armor breaks this shot); `hullDmg`
 * is the overflow past the armor cap; `componentDmg` is what reaches
 * subsystems through penetration.
 */
function runArmorPipeline(t, postShield, opponent, basePen, applyArmorDurability, pellets = 1) {
  const armorFrac = opponent.armor.maxHp > 0
    ? opponent.armor.hp / opponent.armor.maxHp
    : 0;
  // Deflection threshold scales with armor integrity: as armor is stripped it
  // deflects less, hitting 0 at 0% armor (SPViewer's armor-slider behaviour).
  // At full armor this is the raw threshold. During computeAmmoToBreak the
  // armor depletes shot-by-shot, so the threshold eases as the volley lands.
  const threshold = (opponent.armor.threshold[t] || 0) * armorFrac;
  // Deflection is decided PER IMPACT, not per trigger pull. A multi-pellet shot
  // (scattergun) lands as `pellets` independent impacts each carrying
  // postShield / pellets, so a spread whose individual pellets fall under the
  // threshold is deflected in full even when the summed alpha clears it easily.
  // Damage application below stays on the FULL postShield: once past the gate
  // the pellets land together and their damage sums back to the same total.
  const perImpact = pellets > 1 ? postShield / pellets : postShield;
  if (perImpact <= threshold) {
    return { armorDmg: 0, hullDmg: 0, componentDmg: 0, penDistance: 0, deflected: true };
  }

  const hullMult = opponent.hull.damageMult[t] ?? 1;
  // Armor durability only applies while there's armor to provide it. Once
  // armor is fully stripped (hp == 0) the multiplier is neutral - there's no
  // armor left to modify the damage (matches the 0% row in the mitigation
  // table). The applyArmorDurability toggle gates it on top of that.
  const hasArmor = opponent.armor.hp > 0;
  const durMult = (applyArmorDurability && hasArmor)
    ? (opponent.armor.durabilityMult[t] ?? 1)
    : 1;
  // Raw damage that would reach armor / hull if armor weren't there.
  const rawThrough = postShield * durMult * hullMult;

  let armorDmg = 0;
  let hullDmg = 0;
  let armorBroke = false;
  if (opponent.armor.hp > 0) {
    // post_shield (raw, not × hullMult) is compared to armor HP because
    // the reference chain shows hull_dmg = (post_shield − armor.hp) × hullMult
    // when the shot punches through (Idris MasDriver vs Anvil Arrow reference:
    // (118932 − 3300) × 0.75 = 86724).
    if (postShield > opponent.armor.hp) {
      armorBroke = true;
      armorDmg = opponent.armor.hp;
      hullDmg = (postShield - opponent.armor.hp) * durMult * hullMult;
    } else {
      armorDmg = rawThrough;
      hullDmg = 0;
    }
  } else {
    // No armor remaining - everything goes to hull.
    hullDmg = rawThrough;
  }

  // Component penetration. Approximation - see RESIDUAL_PEN_RATIO note.
  let componentDmg = 0;
  let penDistance = 0;
  const shipPenMax = opponent.hull.penetration.component;
  if (basePen > 0 && shipPenMax > 0) {
    // armorFrac is the same as computed at the top of this function;
    // opponent.armor.{hp,maxHp} are not mutated between the two points.
    const penRatio = armorBroke
      ? 1.0
      : RESIDUAL_PEN_RATIO + (1 - RESIDUAL_PEN_RATIO) * (1 - armorFrac);
    const penMult = shipPenMax * penRatio;
    penDistance = basePen * penRatio;
    componentDmg = rawThrough * penMult;
  }

  return { armorDmg, hullDmg, componentDmg, penDistance, deflected: false };
}

/**
 * Simulate a SINGLE shot of `weapon` against `opponent`. Pure - does not
 * mutate opponent. Returns per-stage damage and a `deflected` flag.
 *
 * Each damage-type component runs through its own type-specific chain
 * (see module header for the gameplay rules). Contributions sum into
 * the stage totals.
 *
 * @param {object} [options]
 * @param {boolean} [options.applyArmorDurability=true] - When true (default),
 *   ballistic armor / hull / component damage is multiplied by armor
 *   .Durability.DamageMultipliers (matches the in-game behaviour if
 *   STARC-198632 has landed). When false, durability is omitted - matches
 *   the reference mitigation display verbatim (which still flags durability
 *   as ⚠️ unused).
 */
export function simulateShot(weapon, opponent, options = {}) {
  const applyArmorDurability = options.applyArmorDurability !== false;
  const out = {
    shieldDmg: 0,
    armorDmg: 0,
    hullDmg: 0,
    componentDmg: 0,
    penDistance: 0,
    distortionDmg: 0, // distortion goes to a separate powerplant pool, v1+
    deflected: false,
    byType: {},
  };
  if (!weapon || !opponent) return out;

  const basePen = weapon.basePen || 0;
  // Impacts per trigger pull (1 for everything except scatterguns). Only the
  // armor deflection gate is per-impact; see runArmorPipeline.
  const pellets = Math.max(1, weapon.pellets || 1);

  let deflectedTypes = 0;
  let typesWithAlpha = 0;

  for (const t of DAMAGE_TYPES) {
    const alpha = weapon.dmgByType?.[t] || 0;
    if (alpha <= 0) {
      out.byType[t] = {
        alpha: 0, shield: 0, armor: 0, hull: 0,
        component: 0, distortion: 0, penDistance: 0, deflected: false,
      };
      continue;
    }
    typesWithAlpha += 1;

    let shieldDmg = 0;
    let armorDmg = 0;
    let hullDmg = 0;
    let componentDmg = 0;
    let penDistance = 0;
    let distortionDmg = 0;
    let typeDeflected = false;

    if (t === 'dist') {
      // ── DISTORTION ──────────────────────────────────────────────────
      // Targets the powerplant distortion HP pool, which is conceptually a
      // component (separate from armor / hull HP). Damage that leaks past
      // the shield bypasses armor + hull entirely and is reported as
      // component damage with the .distortionDmg flag set so the UI can
      // label it ("X.X dist"). No penetration distance is reported:
      // distortion doesn't use the penetration mechanic (PTU 4.9 zeroed
      // BasePenetrationDistance on every distortion weapon) - it reaches
      // components by being aimed at the component section.
      if (opponent.shield.hp > 0) {
        const res = opponent.shield.resistance.dist || 0;
        const abs = opponent.shield.absorption.dist || 0;
        shieldDmg = Math.min(opponent.shield.hp, alpha * (1 - res));
        distortionDmg = alpha * (1 - abs);
      } else {
        distortionDmg = alpha;
      }
      // Route distortion leak into the component column.
      componentDmg = distortionDmg;
    } else if (t === 'energy') {
      // ── ENERGY ──────────────────────────────────────────────────────
      // Shield blocks `mitigated × absorption.energy` of damage. With
      // absorption.energy == 1.0 (every 4.x shield) nothing leaks until
      // the shield empties. With <1.0 (future-proofing) some always
      // leaks through into the Armor → Hull → Component pipeline.
      const res = opponent.shield.resistance.energy || 0;
      const mitigated = alpha * (1 - res);
      let postShield = mitigated;
      if (opponent.shield.hp > 0) {
        const energyAbs = opponent.shield.absorption.energy ?? 1;
        shieldDmg = Math.min(opponent.shield.hp, mitigated * energyAbs);
        // Overflow: if the shot exceeds remaining shield HP, the leftover
        // (mitigated − shieldDmg) passes through to the armor pipeline.
        // Reduces to mitigated × (1 − absorb) when shield doesn't break.
        postShield = mitigated - shieldDmg;
      }
      if (postShield > 0) {
        const r = runArmorPipeline('energy', postShield, opponent, basePen, applyArmorDurability, pellets);
        armorDmg = r.armorDmg;
        hullDmg = r.hullDmg;
        componentDmg = r.componentDmg;
        penDistance = r.penDistance;
        typeDeflected = r.deflected;
      } else if (opponent.shield.hp === 0) {
        // Shield down + post_shield 0 should never happen for energy unless
        // absorption is set to 1.0 (rare in shield-down state). Defensive.
        typeDeflected = false;
      }
    } else if (t === 'phys') {
      // ── BALLISTIC ───────────────────────────────────────────────────
      // Mitigated alpha SPLIT by absorption: effAbs × mitigated drains
      // shield HP, (1 − effAbs) × mitigated passes through. effAbs scales
      // linearly with shield HP fraction (baseAbs × shieldFrac). Verified
      // against Deadbolt IV vs Polaris reference at multiple shield levels.
      const baseAbs = opponent.shield.absorption.phys || 0;
      let postShield;
      if (opponent.shield.hp > 0) {
        const res = opponent.shield.resistance.phys || 0;
        const mitigated = alpha * (1 - res);
        const shieldFrac = opponent.shield.maxHp > 0
          ? opponent.shield.hp / opponent.shield.maxHp
          : 0;
        const effAbs = baseAbs * shieldFrac;
        shieldDmg = Math.min(opponent.shield.hp, mitigated * effAbs);
        // Overflow: if the shot exceeds what the shield can absorb (capped
        // at remaining HP), the leftover passes through. Reduces to
        // mitigated × (1 − effAbs) when shield doesn't break.
        postShield = mitigated - shieldDmg;
      } else {
        postShield = alpha;
      }
      const r = runArmorPipeline('phys', postShield, opponent, basePen, applyArmorDurability, pellets);
      armorDmg = r.armorDmg;
      hullDmg = r.hullDmg;
      componentDmg = r.componentDmg;
      penDistance = r.penDistance;
      typeDeflected = r.deflected;
    }

    out.byType[t] = {
      alpha,
      shield: shieldDmg,
      armor: armorDmg,
      hull: hullDmg,
      component: componentDmg,
      distortion: distortionDmg,
      penDistance,
      deflected: typeDeflected,
    };
    if (typeDeflected) deflectedTypes += 1;

    out.shieldDmg += shieldDmg;
    out.armorDmg += armorDmg;
    out.hullDmg += hullDmg;
    out.componentDmg += componentDmg;
    out.distortionDmg += distortionDmg;
    // Take the max pen distance across damage types (a single shot can't
    // penetrate "further" than its deepest type, and this matches how
    // reference behaviour reports a single PEN value per row).
    if (penDistance > out.penDistance) out.penDistance = penDistance;
  }

  // "DEFLECTED" overall = every damage type with non-zero alpha was deflected
  // by the armor threshold (i.e. zero progress toward armor for everyone).
  // A shot that puts a tap on the shield but can't make it through to armor
  // still counts as deflected (matches the reference convention).
  out.deflected = typesWithAlpha > 0 && deflectedTypes === typesWithAlpha;

  return out;
}

/**
 * How many shots from a single weapon instance are required to break each
 * stage. Reports per-weapon ammo (reference convention) - the count on the
 * weapon entry is informational, not used to inflate damage. If the user
 * wants combined-stack volleys, the caller can divide by count.
 *
 * Returns `Infinity` for any stage that the weapon cannot progress on
 * (e.g. shield down + alpha below armor threshold).
 *
 * @param {object} weapon  enumerateLoadoutWeapons output entry
 * @param {object} opponent buildOpponentProfile output
 * @param {object} [options] forwarded to simulateShot (e.g. applyArmorDurability)
 */
export function computeAmmoToBreak(weapon, opponent, options = {}) {
  // Result key is `hull` (renamed from `vital`); the ammo column in the UI
  // is labelled "Hull" since v2 of the chain - components have their own
  // HP pools that we don't track, so "shots to break a vital subsystem"
  // is no longer well-defined past hull break.
  const result = { shield: Infinity, armor: Infinity, hull: Infinity };
  if (!weapon || !opponent) return result;

  // Snapshot the opponent so we can mutate locally without polluting caller.
  const op = cloneProfile(opponent);

  let armorShots = null;
  let hullShots = null;

  // Hard cap - never loop forever for vanishingly small per-shot progress.
  const HARD_CAP = 100000;

  for (let i = 0; i < HARD_CAP; i++) {
    const before = { shield: op.shield.hp, armor: op.armor.hp };
    const shot = simulateShot(weapon, op, options);

    op.shield.hp = Math.max(0, op.shield.hp - shot.shieldDmg);
    op.armor.hp = Math.max(0, op.armor.hp - shot.armorDmg);
    const startHull = op.hull.smallestVitalHp;
    op.hull.smallestVitalHp = Math.max(0, op.hull.smallestVitalHp - shot.hullDmg);

    if (op.shield.hp === 0 && result.shield === Infinity && shot.shieldDmg > 0) {
      result.shield = i + 1;
    } else if (op.shield.hp === 0 && before.shield === 0 && result.shield === Infinity) {
      result.shield = 0;
    }

    if (armorShots == null && op.armor.hp === 0 && (shot.armorDmg > 0 || op.armor.maxHp === 0)) {
      armorShots = i + 1;
      result.armor = op.armor.maxHp === 0 ? 0 : armorShots;
    }

    if (hullShots == null && op.hull.smallestVitalHp === 0 && startHull > 0 && shot.hullDmg > 0) {
      hullShots = i + 1;
      result.hull = hullShots;
    }

    const noProgress = shot.shieldDmg === 0 && shot.armorDmg === 0 && shot.hullDmg === 0;
    if (noProgress) break;

    if (result.shield !== Infinity && result.armor !== Infinity && result.hull !== Infinity) break;
  }
  return result;
}

/**
 * Convert a shots-to-break count into seconds at the weapon's SUSTAINED fire
 * rate. sustainedDPS / alpha = sustained shots per second (the infinite-time
 * average already folds in reload / overheat downtime), so
 * seconds = shots / shotsPerSecond.
 *
 * - Infinity shots → Infinity seconds (never breaks) - passed straight through.
 * - 0 shots → 0 seconds.
 * - Returns null when the rate is unknown (sustainedDPS or alpha is 0, e.g. a
 *   weapon with no firing data) so the UI can show "-" instead of a bogus time.
 */
export function shotsToSeconds(shots, sustainedDPS, alpha) {
  if (shots === Infinity) return Infinity;
  if (!Number.isFinite(shots)) return null;
  if (shots === 0) return 0;
  if (!sustainedDPS || !alpha) return null;
  const shotsPerSecond = sustainedDPS / alpha;
  if (shotsPerSecond <= 0) return null;
  return shots / shotsPerSecond;
}

export function cloneProfile(p) {
  return {
    shield: {
      ...p.shield,
      resistance: { ...p.shield.resistance },
      absorption: { ...(p.shield.absorption || { phys: 0, energy: 0, dist: 0 }) },
    },
    armor: {
      ...p.armor,
      threshold: { ...p.armor.threshold },
      durabilityMult: { ...p.armor.durabilityMult },
    },
    hull: {
      ...p.hull,
      damageMult: { ...p.hull.damageMult },
      penetration: { ...p.hull.penetration },
      vitalParts: { ...p.hull.vitalParts },
    },
  };
}
