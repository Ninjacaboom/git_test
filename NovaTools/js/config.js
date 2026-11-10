export const ZIP_FILES = {
  ptu: 'data/PTU.zip',
  live: 'data/Live.zip'
};

export const VERSIONS_URL = 'data/versions.json';

// Ship-role taxonomy. No longer used by tierEngine (deflection tiers are
// value-based now, see DEFLECTION_BANDS) but kept for the loadout advisor
// work described in PLAN_LOADOUT_ADVISOR.md.
export const FIGHTER_ROLES = new Set([
  'Heavy Fighter', 'Medium Fighter', 'Light Fighter',
  'Interdiction', 'Stealth Fighter', 'Stealth Bomber', 'Interceptor'
]);

// ─── Deflection tier ladder ──────────────────────────────────────────────────
//
// Deflection tiers answer "how far up the ship roster does this weapon still
// do damage?". A weapon clears a band only when it out-damages every ship in
// that band AND every band below it, so the effective threshold per band is
// the running max down this list.
//
// Bands are defined by ANCHOR SHIPS, not by ship Role. Role does not track
// deflection (no Interceptor out-deflects the toughest Heavy Fighter, and the
// 315-420 band is mostly freighters and multicrew ships rather than gunships),
// and the ladder differs per damage type: Aegis Hammerhead out-deflects RSI
// Polaris on physical (531 vs 495) while Polaris wins on energy (418 vs 380).
// Each band therefore names the ship that tops it for physical and the ship
// that tops it for energy; the actual numbers are read from live game data at
// startup, so a rebalance patch follows through automatically.
//
// MAINTENANCE: anchors are the argmax of their band, so a patch that reorders
// ships within a band silently makes the ladder wrong. Re-verify this list
// whenever data/Live.zip is refreshed. Physical/energy as of Live 4.9.0:
//   Anvil Arrow 12/6            Esperia Talon 8/10
//   Anvil F7C Hornet Mk II 24/13    MISC Hull A 18/19
//   Anvil F8A Lightning 54/29   MISC Freelancer 41/43
//   Aegis Redeemer 116/110      (tops the Gunship band on both types)
//   Anvil Carrack 420/240       MISC Starlancer TAC 347/396
//   Aegis Hammerhead 531/380    Aegis Reclaimer 495/418
//
// The top band has no anchors: "Capital" means every ship in the data, so its
// ceiling is the global max and stays correct even if CIG adds a tougher hull.
export const DEFLECTION_BANDS = [
  { key: 'lf', label: 'Light Fighter', badge: 'LF', anchors: ['Anvil Arrow', 'Esperia Talon'] },
  { key: 'mf', label: 'Medium Fighter', badge: 'MF', anchors: ['Anvil F7C Hornet Mk II', 'MISC Hull A'] },
  { key: 'hf', label: 'Heavy Fighter', badge: 'HF', anchors: ['Anvil F8A Lightning', 'MISC Freelancer'] },
  // The Gunship band stops at the Redeemer, which tops it on BOTH damage
  // types. Widening it to the next physical cluster (Asgard / Paladin /
  // Valkyrie at 139, MSR at 127, Apollo Medivac at 121) would stretch the
  // Heavy Fighter band below from 22 to 40 immune ships and put a medical
  // ship on the gunship line, so those four sit in Heavy Gunship instead.
  { key: 'gs', label: 'Gunship', badge: 'GS', anchors: ['Aegis Redeemer'] },
  { key: 'hg', label: 'Heavy Gunship', badge: 'HG', anchors: ['Anvil Carrack', 'MISC Starlancer TAC'] },
  { key: 'sc', label: 'Sub Capital', badge: 'SC', anchors: ['Aegis Hammerhead', 'Aegis Reclaimer'] },
  { key: 'cp', label: 'Capital', badge: 'CP', anchors: [] }
];

// Weapons that cannot even out-damage the lightest fighter's deflection.
export const DEFLECTION_NO_TIER = { key: 'none', label: 'None', badge: '–' };

export const UNRELEASED_SHIPS = new Set([
  'Aegis Javelin', 'Aegis Nautilus', 'Aegis Vulcan',
  'Anvil Crucible', 'Anvil Legionnaire', 'Anvil Liberator',
  'Argo CSV-FM', 'Banu Merchantman', 'C.O. Pionneer',
  'Crusader E1 Spirit', 'Crusader Genesis Starliner',
  'Drake Ironclad', 'Drake Ironclad Assault',
  'Drake Kraken', 'Drake Kraken Privateer',
  'Gatac Railen', 'MISC Endeavor', 'MISC Expanse',
  'MISC Hull B', 'MISC Hull D', 'MISC Hull E', 'MISC Odyssey',
  'Origin G12', 'Origin G12a', 'Origin G12r',
  'RSI Arrastra', 'RSI Bengal', 'RSI Galaxy', 'RSI Orion',
  'RSI Zeus Mk II MR',
  'Tumbril Ranger CV', 'Tumbril Ranger RC', 'Tumbril Ranger TR'
]);

// Weapons to exclude by className prefix
export const EXCLUDED_CLASS_PATTERNS = [
  /Tractor/i,
  /^Bengal_/i,
  /^ANVL_BallisticGatling_Bespoke$/
];

// Weapon names to exclude. Two categories:
//
//   • Ground-vehicle weapons that pass our WeaponGun type filter but aren't
//     ship-mountable (NV57 lives on the Nova tank).
//
//   • Vanduul Mauler line - NPC-boss-ship-only weapons. The Glaive / Scythe /
//     Blade / Stinger Vanduul fighters are flyable by players (and their
//     legacy 'WASP'/'WEAK'/'WAR'/'WHIP'/'WARLORD'/'WRATH' guns are real
//     player loadouts), but the new "Mauler" boss isn't player-pilotable, so
//     its bespoke S6-S10 Gen2 line should not appear in the deflection
//     picker. They're listed by displayName rather than className regex
//     because picking by className would either over-match Gen2 player guns
//     ('WRATH' is `VNCL_Gen2_PlasmaCannon_S5`) or require an enumeration
//     just as long as this one.
//
// Items shipped with `displayName === className` (no LOC string) are filtered
// further upstream in weaponParser.js - that catches APAR_BallisticScatterGun_S6,
// BRRA_LaserCannon_AP_AutomatedTurret, and three VNCL Gen2 placeholders
// (VNCL_Gen2_LaserCannon_S1, VNCL_Gen2_PlasmaCannon_S2, VNCL_Gen2_PlasmaCannon_S4)
// without needing per-item entries here.
export const EXCLUDED_WEAPON_NAMES = new Set([
  'NV57 Ballistic Gatling',
  "Vanduul Mauler 'STRIKER' Repeater",
  "Vanduul Mauler 'ERADICATOR' Cannon",
  "Vanduul Mauler 'RAGE' Cannon",
  "Vanduul Mauler 'IGNITER' Beam",
  "Vanduul Mauler 'ANNIHILATOR' Cannon",
]);

// SubTypes to exclude
export const EXCLUDED_SUBTYPES = new Set(['Rocket', 'UNDEFINED']);

// Weapon type mapping from className/tags to display type
export const WEAPON_TYPE_MAP = {
  'BallisticCannon': 'Ballistic Cannon',
  'BallisticGatling': 'Ballistic Gatling',
  'BallisticRepeater': 'Ballistic Repeater',
  'BallisticScatterGun': 'Ballistic Scattergun',
  'DistortionCannon': 'Distortion Cannon',
  'DistortionRepeater': 'Distortion Repeater',
  'DistortionScatterGun': 'Distortion Scattergun',
  'LaserCannon': 'Laser Cannon',
  'LaserScatterGun': 'Laser Scattergun',
  'LaserRepeater': 'Laser Repeater',
  'LaserGatling': 'Laser Gatling',
  'LaserBeam': 'Laser Beam',
  'MassDriver': 'Ballistic Cannon',
  'NeutronCannon': 'Neutron Cannon',
  'NeutronRepeater': 'Neutron Repeater',
  'PlasmaCannon': 'Plasma Cannon',
  'TachyonCannon': 'Tachyon Cannon'
};
