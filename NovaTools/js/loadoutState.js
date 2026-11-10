/**
 * loadoutState.js - shared mutable state for the loadout UI modules.
 * Each variable is exported directly (for in-place mutation) plus a setter
 * (for full reassignment from outside the module).
 */

export let allShips = [];
export let allHardpoints = [];
export let allVehicles = [];
export let allItems = [];
export let currentShipName = null;
export let currentSlots = null;
export let currentLoadout = {};
export let currentQFuelCapacity = 0;
export let defaultLoadout = {};
export let currentPipAllocation = null;
// Test-safe localStorage read - vitest's Node env has no `localStorage`.
export let dpsMode = (typeof localStorage !== 'undefined' && localStorage.getItem('sc-dps-mode')) || 'burst';
export let currentSignatures = { em: 0, ir: 0, cs: null };
export let currentShipConfig = null;
export let currentShieldOverrides = null;
// Set of portNames the user has explicitly powered off (weapons, turret weapons,
// power plants). A disabled port is treated as "not equipped" for stats/pip math
// without losing the user's component selection.
export let currentDisabledPorts = new Set();
// Per-port component crafting state: { portName: { slotName: qualityValue } }.
// Missing port = component runs at default quality (500 across all slots, identity
// modifier). Cleared on item swap so each component starts fresh.
// See: js/craftingModifiers.js for the math, PLAN_COMPONENT_CRAFTING.md §4.
export let currentCrafting = {};

// Tab state (session-only, not persisted by default - persisted explicitly via saveTabs)
export let tabs = [{ shipName: null, loadout: {}, pips: null, shields: null, disabled: null, loadoutName: '' }];
export let activeTabIdx = 0;

// Weapon stat maps initialised in initLoadoutUI
export let weaponTierMap = new Map();
export let weaponImmuneMap = new Map(); // stores array of immune ship names per weapon
export let weaponSustMap = new Map();
export let weaponAmmoMap = new Map(); // stores {effective, total, isEnergy}
// Base (uncrafted) weapon record keyed by Name||Size - used to re-derive the
// deflection tier for a port after Impact Force crafting scales alpha.
// Holds the original record produced by weaponParser so we can synthesize a
// crafted variant and re-run the immune-ship check without recomputing tiers
// for all weapons.
export let weaponByKey = new Map();

// Section order (persisted) - unified across both columns
// Each entry: { key, col } where col is 'left' or 'right'
export const DEFAULT_SECTION_ORDER = [
  { key: 'weapons', col: 'left' },
  { key: 'turrets', col: 'left' },
  { key: 'missiles', col: 'left' },
  { key: 'emp', col: 'left' },
  { key: 'qed', col: 'left' },
  { key: 'mining', col: 'left' },
  { key: 'salvage', col: 'left' },
  { key: 'Shields', col: 'right' },
  { key: 'Power Plants', col: 'right' },
  { key: 'Coolers', col: 'right' },
  { key: 'Quantum Drive', col: 'right' },
  { key: 'Radar', col: 'right' },
  { key: 'Life Support', col: 'right' },
  { key: 'Flight Blade', col: 'right' },
  { key: 'Thrusters', col: 'right' },
  { key: 'Modules', col: 'right' }
];
export let sectionOrder = DEFAULT_SECTION_ORDER.map(s => ({ ...s }));

// Categories locked from editing (not yet changeable in-game)
export const LOCKED_CATEGORIES = new Set(['Life Support']);

// Icon font classes for pip panel (spv-icons font)
export const PIP_ICONS = {
  weapons: '<i class="spvi-weapon"></i>',
  engine: '<i class="spvi-Engineering_Icon_ItemThrusters"></i>',
  shields: '<i class="spvi-icon_common_generator_shield"></i>',
  quantumDrive: '<i class="spvi-icon_common_quantum"></i>',
  utility: '<i class="spvi-icon_common_tractor-beam"></i>',
  radar: '<i class="spvi-icon_common_radar"></i>',
  lifeSupport: '<i class="spvi-icon_common_life_support"></i>',
  cooler: '<i class="spvi-icon_common_coolant"></i>',
  interdiction: '<i class="spvi-icon_common_EMP"></i>',
  mining: '<i class="spvi-icon_common_mining"></i>',
  salvage: '<i class="spvi-salvage"></i>'
};

// ── Setters ────────────────────────────────────────────────────────────────────
// ES module bindings are live but cannot be reassigned from outside the module,
// so sub-modules that need to replace a variable wholesale use these setters.

export function setAllShips(v) { allShips = v; }
export function setAllHardpoints(v) { allHardpoints = v; }
export function setAllVehicles(v) { allVehicles = v; }
export function setAllItems(v) { allItems = v; }
export function setCurrentShipName(v) { currentShipName = v; }
export function setCurrentSlots(v) { currentSlots = v; }
export function setCurrentLoadout(v) { currentLoadout = v; }
export function setCurrentQFuelCapacity(v) { currentQFuelCapacity = v; }
export function setDefaultLoadout(v) { defaultLoadout = v; }
export function setCurrentPipAllocation(v) { currentPipAllocation = v; }
export function setDpsMode(v) { dpsMode = v; }
export function setCurrentSignatures(v) { currentSignatures = v; }
export function setCurrentShipConfig(v) { currentShipConfig = v; }
export function setCurrentShieldOverrides(v) { currentShieldOverrides = v; }
export function setCurrentDisabledPorts(v) { currentDisabledPorts = v instanceof Set ? v : new Set(v || []); }
export function setCurrentCrafting(v) { currentCrafting = v && typeof v === 'object' ? v : {}; }
export function setPortCrafting(port, slotMap) {
  if (!port) return;
  if (!slotMap || Object.keys(slotMap).length === 0) {
    delete currentCrafting[port];
  } else {
    currentCrafting[port] = slotMap;
  }
}
export function clearPortCrafting(port) {
  if (port && port in currentCrafting) delete currentCrafting[port];
}
export function setTabs(v) { tabs = v; }
export function setActiveTabIdx(v) { activeTabIdx = v; }
export function setSectionOrder(v) { sectionOrder = v; }
export function setWeaponTierMap(v) { weaponTierMap = v; }
export function setWeaponImmuneMap(v) { weaponImmuneMap = v; }
export function setWeaponSustMap(v) { weaponSustMap = v; }
export function setWeaponAmmoMap(v) { weaponAmmoMap = v; }
export function setWeaponByKey(v) { weaponByKey = v; }
