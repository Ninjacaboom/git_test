/**
 * combatCalc.js - pure combat-stat computation extracted from statsPanel.js.
 *
 * Computes weapon-group DPS (burst or sustained), shield absorption summary,
 * missile/bomb payload totals. No DOM access - pure logic over loadout state.
 */
import * as state from './loadoutState.js';
import { getItemStats, getCraftedItemStats } from './loadoutManager.js';
import { calcSustainedDPS, computeBurstDPS } from './sustained.js';
import { classifyTurretWeapon } from './ttkCalc.js';

/**
 * Classify a whole turret slot as 'combat', 'pdc', or 'antipersonnel'.
 *
 * Private helper - behaviorally equivalent to weaponColumn.classifyTurret but
 * kept here to avoid the import cycle combatCalc → weaponColumn → statsPanel
 * → combatCalc (weaponColumn currently imports fmtStat/prettifyName/
 * getSalvageModifierStats from statsPanel).
 */
function turretClassOf(slot) {
  const leaves = [];
  const walk = (s) => {
    const subs = s.ports || [];
    if (subs.length) { for (const sub of subs) walk(sub); }
    else leaves.push(s);
  };
  walk(slot);
  if (!leaves.length) return 'combat';
  let allPdc = true, allAp = true;
  for (const leaf of leaves) {
    const cn = state.currentLoadout[leaf.portName] || leaf.baseLoadout?.ClassName;
    const si = cn ? getItemStats(cn) : null;
    const d = si?.Weapon?.Firing?.[0]?.DamagePerShot;
    const role = classifyTurretWeapon(slot.category, si?.Size || 0,
      d ? { phys: d.Physical || 0, energy: d.Energy || 0, dist: d.Distortion || 0 } : {});
    if (role !== 'pdc') allPdc = false;
    if (role !== 'antipersonnel') allAp = false;
  }
  return allPdc ? 'pdc' : allAp ? 'antipersonnel' : 'combat';
}

/**
 * Calculate combined DPS and missile damage from slot groups.
 * Walks the slot tree, summing burst DPS for guns and total damage for missiles/bombs.
 */
export function calcCombatStats() {
  let pilotDps = 0, turretDps = 0, pdcDps = 0, apDps = 0, totalMissileDmg = 0, totalBombDmg = 0;
  let pilotPhys = 0, pilotEnergy = 0, pilotDist = 0;
  let turretPhys = 0, turretEnergy = 0, turretDist = 0;
  let pdcPhys = 0, pdcEnergy = 0, pdcDist = 0;
  let apPhys = 0, apEnergy = 0, apDist = 0;

  // Weapon power fraction: 0 pips = can't fire at all
  const wpnCh_ = state.currentPipAllocation?.channels?.find(c => c.key === 'weapons');
  const wpnAllocated = wpnCh_?.allocated || 0;
  const wpnNeeded = wpnCh_?.needed || 0;
  const wpnOff = wpnAllocated === 0;
  const wpnFrac = wpnNeeded > 0 ? Math.min(wpnAllocated, wpnNeeded) / wpnNeeded : 1;

  // Raw `DamagePerSecond` sum - the value the per-type breakdown reads from.
  // Mirrors computeBurstDPS's fallback branch exactly (same key order, same
  // numeric filter) so a non-burst weapon divides out to a scale of exactly 1.
  function rawDpsSum(firing) {
    const dps = firing?.DamagePerSecond;
    if (!dps) return 0;
    let sum = 0;
    for (const v of Object.values(dps)) {
      if (typeof v === 'number') sum += v;
    }
    return sum;
  }

  function getWeaponDps(si, cn) {
    if (wpnOff) return 0;
    const firing = si?.Weapon?.Firing?.[0];
    if (!firing) return 0;
    // Same helper the per-slot rows use (weaponColumn.getSlotDps), so a
    // burst-fire weapon reports its inner-burst peak in the banner too rather
    // than the burst-inclusive average sitting in `DamagePerSecond`.
    const burstDps = computeBurstDPS(firing);
    if (!burstDps) return 0;
    if (state.dpsMode === 'sustained') {
      const ammoMult = state.currentShipConfig?.weaponAmmoMult ?? 1;
      const regenMult = state.currentShipConfig?.weaponRegenMult ?? 1;
      if (si?.Weapon && (si._crafted || wpnFrac < 1 || ammoMult !== 1 || regenMult !== 1)) {
        return calcSustainedDPS(si.Weapon, si.Weapon.Consumption, wpnFrac, ammoMult, regenMult) || burstDps;
      }
      const key = `${si.Name || cn}||${si.Size || 0}`;
      return state.weaponSustMap.get(key) ?? burstDps;
    }
    return burstDps;
  }

  // Scale factor from the raw `DamagePerSecond` sum to the DPS actually shown.
  // The per-type breakdown reads DamagePerSecond directly, so it has to carry
  // the SAME factor the headline uses - in burst mode that's the inner-burst
  // uplift (1.0 for every weapon without BurstRoundsPerMinute), in sustained
  // mode the sustained/burst ratio. Without it a burst-fire weapon's per-type
  // rows wouldn't add up to its own total.
  function getDpsScale(si, cn) {
    if (wpnOff) return 0;
    const firing = si?.Weapon?.Firing?.[0];
    if (!firing?.DamagePerSecond) return 1;
    const rawDps = rawDpsSum(firing);
    if (rawDps <= 0) return 1;
    return getWeaponDps(si, cn) / rawDps;
  }

  const isDisabled = (portName) => state.currentDisabledPorts?.has(portName);

  function sumSlotDps(slot) {
    let dps = 0;
    const cn = state.currentLoadout[slot.portName];
    if (cn && !isDisabled(slot.portName)) {
      // Crafted - Impact Force modifier scales Firing[].DamagePerSecond so
      // the displayed DPS reacts to weapon crafting per-port.
      const si = getCraftedItemStats(cn, slot.portName);
      dps += getWeaponDps(si, cn);
    }
    for (const sub of slot.ports || []) dps += sumSlotDps(sub);
    return dps;
  }

  function sumSlotDpsByType(slot) {
    let phys = 0, energy = 0, dist = 0;
    const cn = state.currentLoadout[slot.portName];
    if (cn && !isDisabled(slot.portName)) {
      const si = getCraftedItemStats(cn, slot.portName);
      const firing = si?.Weapon?.Firing?.[0];
      if (firing?.DamagePerSecond) {
        const ratio = getDpsScale(si, cn);
        phys += (firing.DamagePerSecond.Physical || 0) * ratio;
        energy += (firing.DamagePerSecond.Energy || 0) * ratio;
        dist += (firing.DamagePerSecond.Distortion || 0) * ratio;
      }
    }
    for (const sub of slot.ports || []) {
      const s = sumSlotDpsByType(sub);
      phys += s.phys; energy += s.energy; dist += s.dist;
    }
    return { phys, energy, dist };
  }

  // Walk a slot + its sub-ports and sum missile + bomb damage separately.
  // Cluster sub-missiles inherit the parent item's payload type - e.g. a
  // missile rack with sub-missiles contributes to totalMissileDmg; a bomb
  // rack with sub-bombs contributes to totalBombDmg.
  function sumSlotPayloadDmg(slot, into) {
    if (wpnOff) return;
    const cn = state.currentLoadout[slot.portName];
    if (cn) {
      const si = getItemStats(cn);
      const missile = si?.Missile;
      if (missile?.Explosion?.Damage) {
        into.missile += Object.values(missile.Explosion.Damage).reduce((a, b) => a + b, 0);
        // Cluster sub-missiles
        if (si.Ports) {
          for (const port of si.Ports) {
            const subM = port.InstalledItem?.Missile;
            if (subM?.Explosion?.Damage) {
              into.missile += Object.values(subM.Explosion.Damage).reduce((a, b) => a + b, 0);
            }
          }
        }
      }
      const bomb = si?.Bomb;
      if (bomb?.Explosion?.Damage) {
        into.bomb += Object.values(bomb.Explosion.Damage).reduce((a, b) => a + b, 0);
      }
    }
    for (const sub of slot.ports || []) sumSlotPayloadDmg(sub, into);
  }

  const payload = { missile: 0, bomb: 0 };

  // Pilot weapons: DPS + missile/bomb payloads
  for (const slot of state.currentSlots.weapons || []) {
    pilotDps += sumSlotDps(slot);
    const byType = sumSlotDpsByType(slot);
    pilotPhys += byType.phys;
    pilotEnergy += byType.energy;
    pilotDist += byType.dist;
    sumSlotPayloadDmg(slot, payload);
  }

  // Turrets: DPS (with per-type breakdown) + missile/bomb payloads, bucketed by
  // class. Only 'combat' turrets feed the headline Turret DPS.
  // Classify a turret combat / pdc / antipersonnel, mirroring the TTK exclusion
  // (weaponColumn.classifyTurret). Shares the rule via classifyTurretWeapon so
  // the headline Turret DPS, the loadout sub-categories, and the TTK calc can't
  // disagree. PDC + anti-personnel never engage a ship hull, so they're split
  // out of the headline turret DPS (they read as separate rows in the detail
  // view instead).
  for (const slot of state.currentSlots.turrets || []) {
    const byType = sumSlotDpsByType(slot);
    const cls = turretClassOf(slot);
    if (cls === 'pdc') {
      pdcDps += sumSlotDps(slot);
      pdcPhys += byType.phys;
      pdcEnergy += byType.energy;
      pdcDist += byType.dist;
    } else if (cls === 'antipersonnel') {
      apDps += sumSlotDps(slot);
      apPhys += byType.phys;
      apEnergy += byType.energy;
      apDist += byType.dist;
    } else {
      turretDps += sumSlotDps(slot);
      turretPhys += byType.phys;
      turretEnergy += byType.energy;
      turretDist += byType.dist;
    }
    sumSlotPayloadDmg(slot, payload);
  }

  // Missile / bomb racks
  for (const slot of state.currentSlots.missiles || []) {
    sumSlotPayloadDmg(slot, payload);
  }

  totalMissileDmg = payload.missile;
  totalBombDmg = payload.bomb;

  return { pilotDps, pilotPhys, pilotEnergy, pilotDist, turretDps, turretPhys, turretEnergy, turretDist, pdcDps, pdcPhys, pdcEnergy, pdcDist, apDps, apPhys, apEnergy, apDist, totalMissileDmg, totalBombDmg };
}
