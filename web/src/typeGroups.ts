import type { TypeCount } from './api';

export type TypeGroup = {
  id: string;
  title: string;
  /** The recipe types in this group, with the name shown for each. */
  items: { type: string; label: string }[];
};

/** How the filter groups the recipe types. A type that is in no group ends up under "Other". */
const GROUPS: { id: string; title: string; items: [string, string][] }[] = [
  {
    id: 'armour',
    title: 'Armour',
    items: [
      ['Char_Armor_Helmet', 'Helmets'],
      ['Char_Armor_Torso', 'Cores'],
      ['Char_Armor_Arms', 'Arms'],
      ['Char_Armor_Legs', 'Legs'],
      ['Char_Armor_Undersuit', 'Undersuits'],
      ['Char_Armor_Backpack', 'Backpacks'],
    ],
  },
  {
    id: 'fps',
    title: 'FPS weapons',
    // "WeaponPersonal:pistol" means the pistol category of the WeaponPersonal type.
    items: [
      ['WeaponPersonal:pistol', 'Pistol'],
      ['WeaponPersonal:smg', 'SMG'],
      ['WeaponPersonal:rifle', 'Rifles'],
      ['WeaponPersonal:sniper', 'Sniper'],
      ['WeaponPersonal:shotgun', 'Shotgun'],
      ['WeaponPersonal:lmg', 'LMG'],
      ['WeaponPersonal:special', 'Special'],
    ],
  },
  {
    id: 'ship',
    title: 'Ship components',
    items: [
      ['WeaponGun', 'Ship weapons'],
      ['WeaponMining', 'Mining lasers'],
      ['MiningModifier', 'Mining modules'],
      ['SalvageModifier', 'Salvage modifiers'],
      ['Shield', 'Shields'],
      ['PowerPlant', 'Power plants'],
      ['Cooler', 'Coolers'],
      ['QuantumDrive', 'Quantum drives'],
      ['Radar', 'Radars'],
      ['DockingCollar', 'Docking collars'],
    ],
  },
];

/** The groups for the types that really exist in the data, in a fixed order. */
export function buildGroups(types: TypeCount[], prettyType: (t: string) => string): TypeGroup[] {
  const present = new Set(types.map((t) => t.type));
  const used = new Set<string>();
  const groups: TypeGroup[] = [];
  for (const g of GROUPS) {
    const items = g.items.filter(([type]) => present.has(type.split(':')[0])).map(([type, label]) => ({ type, label }));
    items.forEach((i) => used.add(i.type.split(':')[0]));
    if (items.length > 0) groups.push({ id: g.id, title: g.title, items });
  }
  const other = types.filter((t) => !used.has(t.type)).map((t) => ({ type: t.type, label: prettyType(t.type) }));
  if (other.length > 0) groups.push({ id: 'other', title: 'Other', items: other });
  return groups;
}
