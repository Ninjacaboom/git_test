import { UNRELEASED_SHIPS } from './config.js';

export function parseShips(vehicles) {
  return vehicles
    .filter(v => {
      if (!v.Name) return false;
      if (UNRELEASED_SHIPS.has(v.Name)) return false;
      if (v.IsSpaceship === false) return false;
      return true;
    })
    .map(v => {
      const defl = v.Armor?.DamageDeflection || {};
      const armorMult = v.Armor?.Durability?.DamageMultipliers || {};
      return {
        Name: v.Name,
        Size: v.Size,
        Role: v.Role,
        'Deflection physical': defl.Physical ?? null,
        'Deflection energy': defl.Energy ?? null,
        'Resist physical': armorMult.Physical != null ? Math.round((1 - armorMult.Physical) * 100) : null,
        'Resist energy': armorMult.Energy != null ? Math.round((1 - armorMult.Energy) * 100) : null
      };
    });
}
