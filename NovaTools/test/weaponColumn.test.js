/**
 * Tests for weaponColumn display helpers - guards the firing-economy
 * classification (classifyFiringMode) used by the ammo / fire-time readouts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getAmmoInfo, getWeaponMeta, renderMissileSlot, renderWeaponSlot, BESPOKE_PATTERNS } from '../js/weaponColumn.js';
import { initLoadoutData, extractSlots } from '../js/loadoutManager.js';
import { setCurrentLoadout, setCurrentCrafting, setCurrentDisabledPorts } from '../js/loadoutState.js';
describe('weaponColumn consolidation smoke', () => {
  it('stray-heat energy repeater classifies as energy (ammo readout), no throw', () => {
    const si = { Size: 3, Weapon: {
      Firing: [{ RoundsPerMinute: 350, HeatPerShot: 1800, DamagePerShot: { Energy: 86 } }],
      Consumption: { MaxAmmo: 75, MaxRegenPerSec: 15, Cooldown: 0.75 },
      HeatParameters: { LockOnOverheat: false } } };
    const ammo = getAmmoInfo(si, 1);
    expect(ammo.isEnergy).toBe(true);
    expect(ammo.text).toContain('load');
    const meta = getWeaponMeta(si, 1);          // must not throw
    expect(typeof meta.right).toBe('string');
    expect(meta.right).toContain('12.9');        // 75 / (350/60) continuous fire time
  });
  it('ballistic gatling classifies as heat (overheat cooldown shown)', () => {
    const si = { Size: 5, Weapon: {
      Firing: [{ RoundsPerMinute: 600, HeatPerShot: 0.5, DamagePerShot: { Physical: 125 } }],
      Ammunition: { Capacity: 9999 },
      HeatParameters: { OverheatTemp: 100, MinTemp: 0, CoolingPerSecond: 30, OverheatFixTime: 2.2, TimeTillCoolingStarts: 0.5 } } };
    const ammo = getAmmoInfo(si, 1);
    expect(ammo.isEnergy).toBe(false);
    const meta = getWeaponMeta(si, 1);
    expect(meta.right).toContain('2.2');         // OverheatFixTime cooldown still displayed
  });
});

// ─── Missile-rack swap header ───
// The rack header is the click target for the rack-swap picker, which reads
// data-required-tags to enforce the port's RequiredTags. Without it, a
// ship-specific rack port listed every rack in its size range.
describe('renderMissileSlot rack header', () => {
  it('emits the port RequiredTags so the swap picker can enforce them', () => {
    const slot = {
      portName: 'hardpoint_test_rack', minSize: 3, maxSize: 9,
      types: ['MissileLauncher.MissileRack', 'BombLauncher.BombRack'],
      portTags: ['Test_BombRack'], requiredTags: ['$Test_BombRack'],
      baseLoadout: null, ports: [], uneditable: false,
    };
    const html = renderMissileSlot(slot);
    expect(html).toContain('data-rack-swap="1"');
    expect(html).toContain(`data-required-tags='["$Test_BombRack"]'`);
  });
});

// ─── Turret with untyped gimbal ports vs. storage module ───
// The storage-module short-circuit collapses a mount whose sub-ports are all
// Cargo into one SCU row. Gimbal ports that carry Tags but no Types must
// not count as cargo - `[].every()`
// is true, which used to hide every gun in the turret.
describe('renderWeaponSlot: untyped sub-ports are not cargo', () => {
  const item = (className, type, subType, size, extra = {}) => ({
    className, type, subType, size, tags: '', requiredTags: '',
    stdItem: { ClassName: className, Name: className, Size: size, Type: `${type}.${subType}`, ...extra },
  });
  const turret = item('TEST_Remote_Turret_S3', 'Turret', 'TopTurret', 3);
  const gimbal = item('Mount_Gimbal_S3', 'Turret', 'GunTurret', 3);
  const gun = item('TEST_Repeater_S3', 'WeaponGun', 'Gun', 3);
  const module = item('TEST_Storage_Module', 'Module', 'Module', 1, { CargoGrid: { Capacity: 8 } });

  beforeEach(() => {
    initLoadoutData([turret, gimbal, gun, module]);
    setCurrentCrafting({});
    setCurrentDisabledPorts([]);
  });

  const renderFirst = (installedItem) => {
    const ship = { Hardpoints: { Weapons: { PilotWeapons: { InstalledItems: [installedItem] } } } };
    const [slot] = extractSlots(ship).weapons;
    const loadout = {};
    const walk = (s) => { loadout[s.portName] = s.baseLoadout?.ClassName ?? null; (s.ports || []).forEach(walk); };
    walk(slot);
    setCurrentLoadout(loadout);
    return renderWeaponSlot(slot);
  };

  it('renders the guns of a turret whose gimbal ports have no Types', () => {
    const gimbalPort = (side) => ({
      PortName: `hardpoint_gun_${side}`, Tags: ['TEST_Turret'], MinSize: 3, MaxSize: 3,
      BaseLoadout: { ClassName: 'Mount_Gimbal_S3', Type: 'Turret.GunTurret', Size: 3 },
      Ports: [{
        PortName: 'hardpoint_class_2', MinSize: 3, MaxSize: 3, Types: ['WeaponGun.Gun'],
        BaseLoadout: { ClassName: 'TEST_Repeater_S3', Type: 'WeaponGun.Gun', Size: 3 },
      }],
    });
    const html = renderFirst({
      PortName: 'hardpoint_turret_upper', MinSize: 3, MaxSize: 3, Types: ['Turret.TopTurret'],
      Uneditable: true, Turret: true,
      BaseLoadout: { ClassName: 'TEST_Remote_Turret_S3', Type: 'Turret.TopTurret', Size: 3 },
      Ports: [gimbalPort('left'), gimbalPort('right')],
    });
    expect(html).toContain('lo-turret-group');
    expect(html).toContain('hardpoint_turret_upper/hardpoint_gun_left/hardpoint_class_2');
  });

  it('still collapses a module whose sub-ports are all Cargo into one SCU row', () => {
    const html = renderFirst({
      PortName: 'hardpoint_module', MinSize: 1, MaxSize: 1, Types: ['Module'],
      BaseLoadout: { ClassName: 'TEST_Storage_Module', Type: 'Module.Module', Size: 1 },
      Ports: [{ PortName: 'cargo_grid', MinSize: 1, MaxSize: 1, Types: ['Cargo'] }],
    });
    expect(html).not.toContain('lo-turret-group');
    expect(html).toContain('SCU');
  });
});

// ─── Picker blocklist vs. a ship's own flight blades ───
// BESPOKE_PATTERNS is matched against the whole className. A fragment that
// names a ship (the old `_RSI_Meteor`, meant for that ship's missile rack)
// also matched `Controller_Flight_RSI_Meteor*` and emptied the Meteor's
// flight-blade picker.
describe('BESPOKE_PATTERNS', () => {
  it('does not hide the flight blades of a ship', () => {
    for (const cn of ['Controller_Flight_RSI_Meteor', 'Controller_Flight_RSI_Meteor_Blade_HND',
      'Controller_Flight_RSI_Meteor_Blade_SPD', 'Controller_Flight_RSI_Mantis_Blade_HND']) {
      expect(BESPOKE_PATTERNS.test(cn)).toBe(false);
    }
  });

  it('still hides alien and dev-only hardware', () => {
    for (const cn of ['MRCK_S03_VNCL_Quad_S01', 'MRCK_S03_TEMP_BOMB', 'MRCK_S03_TMBL_Dual_S02_Cyclone_MT_Left']) {
      expect(BESPOKE_PATTERNS.test(cn)).toBe(true);
    }
  });
});
