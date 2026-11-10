/**
 * Tests for weaponParser.js - focused on the runtime orphan-weapon filter
 * that uses Loadout Manager's isCompatible as ground truth.
 *
 * Coverage:
 *  1. Weapon with a matching port on at least one ship - keep
 *  2. Weapon whose size exceeds every port - orphan, hide
 *  3. Weapon whose requiredTags aren't satisfied by any ship - orphan, hide
 *  4. Weapon whose required port tags ARE satisfied via ship-level tags
 *     (e.g. Meteor's `RSI_Meteor` ship tag fulfilling Echion's requiredTags) - keep
 *  5. parseWeapons called WITHOUT hardpoints - fail-open, no filtering
 *  6. EXCLUDED_WEAPON_NAMES + placeholder-name (name === className) still
 *     filtered independently of the orphan check
 */

import { describe, it, expect } from 'vitest';
import { parseWeapons } from '../js/weaponParser.js';

// Minimal weapon stub - only the fields parseWeapons + isCompatible read.
// `consumption` defaults to an energy pool; pass null for ballistic guns.
// `heatParams`/`heatPerShot` opt into the heat model (both default off).
function weaponItem({ className, name, size = 1, type = 'WeaponGun', subType = 'Gun', requiredTags = '', tags = '', alpha = 100, rpm = 60, capacity = 100, consumption = { MaxAmmo: 100, MaxRegenPerSec: 10, Cooldown: 1 }, heatParams = null, heatPerShot = 0 }) {
  return {
    className,
    type, subType,
    size,
    tags, requiredTags,
    stdItem: {
      Name: name,
      Classification: `Ship.Weapon.Gun`,
      Weapon: {
        Ammunition: { Speed: 1000, Range: 2000, Capacity: capacity },
        Firing: [{
          RoundsPerMinute: rpm,
          DamagePerShot: { Energy: alpha },
          DamagePerSecond: { Energy: alpha * rpm / 60 },
          PelletsPerShot: 1,
          HeatPerShot: heatPerShot,
        }],
        Consumption: consumption,
        ...(heatParams ? { HeatParameters: heatParams } : {}),
      },
    },
  };
}

// Minimal ship hardpoint stub.
function ship({ className = 'TEST_Ship', portTags = [], weaponPorts = [] }) {
  return {
    ClassName: className,
    Name: className,
    PortTags: portTags,
    Hardpoints: {
      Weapons: {
        PilotWeapons: {
          InstalledItems: weaponPorts.map((p, i) => ({
            PortName: `port_${i}`,
            MinSize: p.size,
            MaxSize: p.size,
            Types: ['WeaponGun.Gun'],
            RequiredTags: p.requiredTags || [],
            PortTags: p.portTags || [],
          })),
        },
      },
    },
  };
}

describe('parseWeapons orphan filter', () => {
  it('keeps weapons that fit at least one ship port', () => {
    const items = [weaponItem({ className: 'TEST_Gun_S2', name: 'Test Gun', size: 2 })];
    const hardpoints = [ship({ weaponPorts: [{ size: 2 }] })];
    const out = parseWeapons(items, hardpoints);
    expect(out).toHaveLength(1);
    expect(out[0].Name).toBe('Test Gun');
  });

  it('filters out weapons whose size matches no port', () => {
    const items = [weaponItem({ className: 'TEST_Gun_S12', name: 'Capital Gun', size: 12 })];
    const hardpoints = [ship({ weaponPorts: [{ size: 4 }, { size: 5 }] })];
    const out = parseWeapons(items, hardpoints);
    expect(out).toHaveLength(0);
  });

  it('filters out weapons whose requiredTags no port can satisfy', () => {
    const items = [weaponItem({
      className: 'TEST_Bespoke',
      name: 'Bespoke Gun',
      size: 4,
      requiredTags: 'OnlyOnUnknownShip',
    })];
    const hardpoints = [ship({ weaponPorts: [{ size: 4 }] })];  // no matching tag
    const out = parseWeapons(items, hardpoints);
    expect(out).toHaveLength(0);
  });

  it('keeps bespoke weapons when ship-level PortTags satisfy their requiredTags', () => {
    // Meteor-pattern: ship's PortTags include `RSI_Meteor`, weapon requires it.
    // collectWeaponPorts must merge ship tags into per-port PortTags.
    const items = [weaponItem({
      className: 'TEST_Meteor_Gun',
      name: 'Meteor Bespoke',
      size: 5,
      requiredTags: 'TEST_Meteor',
    })];
    const hardpoints = [ship({
      className: 'TEST_Meteor',
      portTags: ['TEST_Meteor'],
      weaponPorts: [{ size: 5 }],
    })];
    const out = parseWeapons(items, hardpoints);
    expect(out).toHaveLength(1);
    expect(out[0].Name).toBe('Meteor Bespoke');
  });

  it('fail-open: no filtering when hardpoints array is empty/missing', () => {
    const items = [
      weaponItem({ className: 'TEST_A', name: 'Weapon A', size: 1 }),
      weaponItem({ className: 'TEST_B', name: 'Weapon B', size: 99 }),
    ];
    expect(parseWeapons(items)).toHaveLength(2);
    expect(parseWeapons(items, [])).toHaveLength(2);
  });

  it('placeholder-named items (name === className) are still filtered independently', () => {
    const items = [
      weaponItem({ className: 'TEST_LegitGun', name: 'Legit Gun', size: 1 }),
      weaponItem({ className: 'TEST_Placeholder', name: 'TEST_Placeholder', size: 1 }),
    ];
    const hardpoints = [ship({ weaponPorts: [{ size: 1 }] })];
    const out = parseWeapons(items, hardpoints);
    expect(out.map(w => w.Name)).toEqual(['Legit Gun']);
  });
});

describe('AmmoEffective magazine clamp', () => {
  it('clamps the never-overheats sentinel to the magazine (C-788 pattern)', () => {
    // Real C-788 numbers: 40 RPM, 12 heat/shot, 25.4 cooling/s with a 0.84s
    // delay - cooling between shots (25.4 x 0.66 = 16.8) beats HeatPerShot,
    // so roundsBeforeOverheat returns its 999999 sentinel. The picker used
    // to render "999 999/270"; the display value must cap at the magazine.
    const items = [weaponItem({
      className: 'TEST_C788', name: 'C-788ish', rpm: 40,
      capacity: 270, consumption: null, heatPerShot: 12,
      heatParams: { MinTemp: 0, OverheatTemp: 100, CoolingPerSecond: 25.4, TimeTillCoolingStarts: 0.84, OverheatFixTime: 4.32 },
    })];
    const [w] = parseWeapons(items);
    expect(w.AmmoEffective).toBe(270);
    expect(w.AmmoCapacity).toBe(270);
    expect(w.IsEnergy).toBe(false);
  });

  it('keeps the heat-limited round count when it is below the magazine (Deadbolt pattern)', () => {
    // No cooling between shots: ceil(100 / 6) = 17 rounds before overheat,
    // well under the 381-round magazine - must NOT be clamped upward.
    const items = [weaponItem({
      className: 'TEST_Deadbolt', name: 'Deadboltish', rpm: 300,
      capacity: 381, consumption: null, heatPerShot: 6,
      heatParams: { MinTemp: 0, OverheatTemp: 100, CoolingPerSecond: 0, TimeTillCoolingStarts: 0, OverheatFixTime: 4 },
    })];
    const [w] = parseWeapons(items);
    expect(w.AmmoEffective).toBe(17);
    expect(w.AmmoCapacity).toBe(381);
  });

  it('leaves energy weapons alone - Capacity is unrelated to the regen pool', () => {
    // Energy guns draw from Consumption.MaxAmmo; a small Ammunition.Capacity
    // must never clamp the pool readout.
    const items = [weaponItem({
      className: 'TEST_Laser', name: 'Laserish',
      capacity: 1, consumption: { MaxAmmo: 25, MaxRegenPerSec: 5, Cooldown: 1 },
    })];
    const [w] = parseWeapons(items);
    expect(w.AmmoEffective).toBe(25);
    expect(w.IsEnergy).toBe(true);
  });
});
