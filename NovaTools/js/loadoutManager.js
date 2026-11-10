/**
 * Loadout Manager - core data logic.
 * Handles hardpoint parsing, component compatibility, default loadouts, and stats.
 */

import { currentCrafting, allHardpoints } from './loadoutState.js';
import { craftStdItem } from './craftingModifiers.js';

// Build item lookup by className for fast resolution
let itemsByClass = new Map();
let allItems = [];

// Blueprint lookup, populated from blueprints.json. The GUID map is the
// authoritative one - CIG occasionally renames items between patches but
// keeps the GUID stable, so a className-only index would silently lose
// recipes after a rename (e.g. Cry-Star SL → IceBox). The className map is
// kept as a fallback for the (rare) case where an item record lacks a
// `reference` GUID. Empty maps = no blueprint data loaded → feature stays
// dark via the `hasCraftingData()` gate.
let blueprintsByGuid = new Map();
let blueprintsByClass = new Map();

// Patch missing Class fields in game data
const CLASS_PATCHES = {
  'COOL_ACOM_S01_QuickCool_SCItem': 'Competition',
  'COOL_AEGS_S04_Idris_SCItem': 'Military',
  'COOL_AEGS_S04_Javelin_SCItem': 'Military',
  'COOL_RSI_S04_Bengal_SCItem': 'Military',
  'POWR_AEGS_S04_Idris_SCItem': 'Military',
  'POWR_AEGS_S04_Reclaimer_SCItem': 'Industrial',
  'POWR_RSI_S04_Bengal_SCItem': 'Military',
  'SHLD_GODI_S04_Bengal_SCItem': 'Military',
  'SHLD_GODI_S04_Idris_Pirate_SCItem': 'Military',
  'SHLD_GODI_S04_Idris_SCItem': 'Military',
  'SHLD_GODI_S04_Javelin_SCItem': 'Military',
  'QDRV_AEGS_S04_Javelin_SCItem': 'Military',
  'QDRV_WETK_S04_Idris_TEMP': 'Military',
};

// Bespoke salvage / mining arm display names. CIG's source data leaves
// these arms with Name === ClassName, so without this map they'd render
// as 'AEGS_Reclaimer_Salvage_Arm'. Ship-specific labels are clearer than
// the generic "Salvage Arm" fallback when several arms appear in the
// same loadout (Vulture / Salvation each have a Left + Right pair).
const BESPOKE_ARM_NAMES = {
  'AEGS_Reclaimer_Salvage_Arm':       'Reclaimer Salvage Arm',
  'ARGO_MOTH_Salvage_Arm':            'MOTH Salvage Arm',
  'DRAK_Vulture_Salvage_Arm_Left':    'Vulture Salvage Arm (Left)',
  'DRAK_Vulture_Salvage_Arm_Right':   'Vulture Salvage Arm (Right)',
  'MISC_Fortune_Salvage_Arm':         'Fortune Salvage Arm',
  'RSI_Salvation_Salvage_Arm_Left':   'Salvation Salvage Arm (Left)',
  'RSI_Salvation_Salvage_Arm_Right':  'Salvation Salvage Arm (Right)',
};

export function initLoadoutData(items) {
  allItems = items;
  itemsByClass = new Map();
  for (const item of items) {
    const patch = CLASS_PATCHES[item.className];
    if (patch && item.stdItem && !item.stdItem.Class?.trim()) {
      item.stdItem.Class = patch;
    }
    // ToolArm display-name fallback chain. CIG leaves placeholder names on
    // ship-specific salvage / mining / tractor arms; the Extractor surfaces
    // them with Name === ClassName. Two-stage rewrite:
    //   1. BESPOKE_ARM_NAMES gives ship-prefixed labels for the known set,
    //      so a Vulture's two arms can be told apart.
    //   2. Anything still placeholder-shaped falls through to the generic
    //      "Salvage Arm" / "Mining Arm" / "Tractor Arm" / "Tool Arm" labels.
    if (item.type === 'ToolArm' && item.stdItem?.Name) {
      const bespoke = BESPOKE_ARM_NAMES[item.className];
      if (bespoke) {
        item.stdItem.Name = bespoke;
      } else {
        const isPlaceholder = item.stdItem.Name === item.stdItem.ClassName
          || /^[A-Z][A-Z0-9]+_[A-Za-z0-9_]+$/.test(item.stdItem.Name);
        if (isPlaceholder) {
          const cn = item.className || '';
          if (/Salvage/i.test(cn)) item.stdItem.Name = 'Salvage Arm';
          else if (/Mining/i.test(cn)) item.stdItem.Name = 'Mining Arm';
          else if (/Tractor/i.test(cn)) item.stdItem.Name = 'Tractor Arm';
          else item.stdItem.Name = 'Tool Arm';
        }
      }
    }
    // Ship-specific Turret / UtilityTurret items often share generic Names like
    // "Manned Turret" or "Remote Turret". Prepend the ship code parsed from the
    // className (e.g. ARGO_MOTH_Turret_Right → "MOTH Manned Turret") so the user
    // can tell which ship's bespoke turret they're looking at.
    if ((item.type === 'Turret' || item.type === 'UtilityTurret') && item.stdItem?.Name) {
      const cn = item.className || '';
      // Helper: extract the ship code (second underscore-token).
      const parts = cn.split('_');
      const shipCode = parts.length >= 3 ? parts[1] : null;
      const validShipCode = shipCode && /^[A-Za-z][A-Za-z0-9]+$/.test(shipCode);
      // Tractor-turret items: bespoke utility-port mounts that hold a tractor
      // beam. Most are named "Remote Turret" generically, but at least one
      // (MISC_Reliant_Remote_Tractor_Turret → "Reliant Toshima Turret")
      // collides with a real gun-turret name on the same ship. Force-rename
      // any turret item whose className signals tractor use so the slot
      // label clearly reads as a utility mount, not a gun turret.
      const isTractorTurret = /tractor/i.test(cn) && /turret/i.test(cn);
      if (isTractorTurret && validShipCode) {
        item.stdItem.Name = `${shipCode} Tractor Mount`;
      } else {
        const generic = /^(Manned|Remote|Utility)?\s*Turret$/i.test(item.stdItem.Name);
        if (generic && validShipCode) {
          item.stdItem.Name = `${shipCode} ${item.stdItem.Name}`;
        }
      }
    }
    itemsByClass.set(item.className, item);
  }
}

/**
 * Get the full hardpoint config for a ship by name.
 */
export function getShipConfig(hardpoints, shipName) {
  return hardpoints.find(h => h.Name === shipName);
}

/**
 * Get the stdItem stats for a className. Raw - no crafting modifiers
 * applied. Use this for picker previews and any read that doesn't know
 * (or care) which port a component is installed in.
 */
export function getItemStats(className) {
  const item = itemsByClass.get(className);
  return item?.stdItem || null;
}

/**
 * Initialize the blueprint lookup from `data/blueprints.json`. Best-effort:
 * empty input is fine (Live build without crafting data → feature stays dark).
 *
 * Indexes by both TargetGUID (primary - survives item renames) and
 * TargetClassName (fallback for the rare item without a `reference` GUID).
 */
export function initCraftingData(blueprints) {
  blueprintsByGuid = new Map();
  blueprintsByClass = new Map();
  if (!Array.isArray(blueprints)) return;
  for (const bp of blueprints) {
    if (!bp) continue;
    if (bp.TargetGUID) blueprintsByGuid.set(bp.TargetGUID, bp);
    if (bp.TargetClassName) blueprintsByClass.set(bp.TargetClassName, bp);
  }
}

/**
 * Get the blueprint for a className, if any. Resolves via the item's
 * `reference` GUID first (stable across CIG renames), then falls back to
 * className lookup. Returns null when no blueprint exists in the data.
 */
export function getBlueprint(className) {
  const item = itemsByClass.get(className);
  const guid = item?.reference;
  if (guid) {
    const bp = blueprintsByGuid.get(guid);
    if (bp) return bp;
  }
  return blueprintsByClass.get(className) || null;
}

/**
 * True iff any blueprint data is loaded. UI gates feature visibility on this.
 */
export function hasCraftingData() {
  return blueprintsByGuid.size > 0 || blueprintsByClass.size > 0;
}

/**
 * Get stdItem stats with the per-port crafting modifiers baked in. Use
 * this from every read site that operates on an INSTALLED component
 * (calculateStats, stat-panel renders, weapon-column renders). When
 * `portName` is not supplied, or no blueprint exists, or the port has
 * no crafting deviation from defaults, this returns the same reference
 * as `getItemStats` - zero-cost fast path.
 */
export function getCraftedItemStats(className, portName) {
  const stdItem = getItemStats(className);
  if (!stdItem || !portName) return stdItem;
  const bp = getBlueprint(className);
  if (!bp) return stdItem;
  const portCrafting = currentCrafting[portName];
  if (!portCrafting) return stdItem;
  const crafted = craftStdItem(stdItem, bp, portCrafting);
  // Mark the clone so DPS read-sites know to recompute sustained DPS live
  // instead of pulling the base value from `weaponSustMap` (which is keyed
  // by name+size and so can't reflect per-port crafting). craftStdItem
  // returns the input reference unchanged when nothing deviates from
  // default, so this only fires on an actual crafted deviation.
  if (crafted !== stdItem) crafted._crafted = true;
  return crafted;
}

// Strip a leading "$" - port-side tags use "$Foo" while item-side use "Foo".
function stripDollar(t) {
  return typeof t === 'string' && t.length > 0 && t[0] === '$' ? t.slice(1) : t;
}

// Normalize a tag list (array or whitespace-separated string) into an array
// of plain tag tokens with $-prefixes removed.
function tokenizeTags(v) {
  if (Array.isArray(v)) return v.map(stripDollar).filter(Boolean);
  if (typeof v === 'string') return v.split(/\s+/).filter(Boolean).map(stripDollar);
  return [];
}

// Strip `$`-prefixed segments out of a port Type path. The extractor
// occasionally merges port flags into the Types array (e.g. Origin M80's
// right power plant slot, `PowerPlant.$editable`) instead of into Flags;
// without this, picker results for that slot come back empty because the
// dotted "$editable" sub-segment matches no item subType or Classification.
function normalizePortType(t) {
  if (typeof t !== 'string' || !t.includes('.$')) return t;
  return t.split('.').filter(seg => !seg.startsWith('$')).join('.');
}

/**
 * Check if an item is compatible with a hardpoint slot.
 *
 * The hardpoint may carry these fields (populated by flattenPort):
 *   - Types         : ['Type.SubType', ...] taxonomy
 *   - MinSize/MaxSize
 *   - PortTags      : tags the port "provides" (already merged with ship.PortTags)
 *   - RequiredTags  : tags the port demands the item carry (typically "$Foo")
 */
export function isCompatible(item, hardpoint) {
  const size = item.size;
  const min = hardpoint.MinSize;
  const max = hardpoint.MaxSize;
  if (min != null && max != null && (size < min || size > max)) return false;

  // Type matching: respect SubType when the port specifies one. A port that
  // says `Turret.CanardTurret` only accepts items whose type+subType resolve
  // to that exact path (or whose Classification path starts there). A port
  // that says just `Module` accepts any item with type='Module'.
  const types = (hardpoint.Types || []).map(normalizePortType);
  if (types.length > 0) {
    const itemClass = item.stdItem?.Classification || '';
    const itemType = `${item.type}.${item.subType}`;
    const itemBase = item.type;
    const match = types.some(t => {
      if (itemType === t) return true;
      if (itemClass === t) return true;
      if (itemClass.startsWith(t + '.')) return true;
      // Bare-base match: only when the port itself specifies a bare base
      // type (no SubType). Without this guard, a port wanting
      // `Turret.CanardTurret` would also match GunTurret/RemoteTurret items.
      if (!t.includes('.') && itemBase === t) return true;
      // UNDEFINED-subType escape hatch: items in categories that never
      // declare a subType (QuantumDrive, JumpDrive, Cooler, Shield,
      // FlightController, etc. - ~1600 items in total, none of them
      // turrets) match any port whose base type matches theirs, even if
      // the port specifies a more specific subType like
      // `QuantumDrive.QDrive` or `JumpDrive.JumpDrive`.
      if (item.subType === 'UNDEFINED' && t.split('.')[0] === itemBase) return true;
      return false;
    });
    if (!match) return false;
  }

  // Tag matching, two directions (each only enforced when non-empty):
  //   1. port.RequiredTags must all be present in item.tags
  //   2. item.requiredTags must all be present in port.PortTags
  //      (port.PortTags already contains the ship's PortTags via flattenPort)
  const portRequired = tokenizeTags(hardpoint.RequiredTags);
  if (portRequired.length > 0) {
    const itemTagSet = new Set(tokenizeTags(item.tags));
    if (!portRequired.every(t => itemTagSet.has(t))) return false;
  }

  const itemRequired = tokenizeTags(item.requiredTags);
  if (itemRequired.length > 0) {
    const portTagSet = new Set([
      ...tokenizeTags(hardpoint.PortTags),
      ...tokenizeTags(hardpoint.Tags),
    ]);
    if (!itemRequired.every(t => portTagSet.has(t))) return false;
  }

  return true;
}

/**
 * Missile/bomb racks that are built into one ship: no ship installs them in a
 * port the player can change. CIG ties most such racks to their ship with
 * RequiredTags, but some carry none, so by tags alone they fit every rack
 * port of their size. A rack that only ever sits in locked ports cannot be
 * taken off its ship in game, so it is not a swap target anywhere.
 *
 * "Installed" covers both places the data mounts things: a ship's hardpoint
 * tree (`BaseLoadout`) and the ports of another item (`InstalledItem`) - a
 * module or turret that carries its own racks. A rack built into a module is
 * as fixed as one built into a hull.
 *
 * Racks with RequiredTags of their own are left out: tag matching already
 * confines them, and the auto-default for locked sub-ports still needs them.
 *
 * A rack no ship installs at all stays pickable (the generic racks sold in
 * shops are never a stock fit), with one exception: an unfinished copy of an
 * integrated rack. CIG leaves such copies in the data with the original's
 * display-name key and no tags. A real rack's name key is derived from its
 * own ClassName, so a never-installed rack whose name key belongs to another
 * item AND is the name of an integrated rack is one of those copies.
 */
export function findShipIntegratedRacks(hardpoints) {
  const locked = new Set();
  const editable = new Set();
  const isRack = item => item.type === 'MissileLauncher' || item.type === 'BombLauncher';
  // `@item_Name<Key>` -> lowercased <Key>; null for any other name form.
  const nameKey = item => {
    const m = /^@item_Name(.+)$/i.exec(item.name || '');
    return m ? m[1].toLowerCase() : null;
  };
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    const cn = node.BaseLoadout?.ClassName ?? node.InstalledItem?.ClassName;
    const item = cn ? itemsByClass.get(cn) : null;
    if (item && isRack(item) && !item.requiredTags) {
      const flags = node.Flags || [];
      const isLocked = node.Uneditable || flags.includes('$uneditable') || flags.includes('uneditable');
      (isLocked ? locked : editable).add(cn);
    }
    Object.values(node).forEach(visit);
  };
  for (const ship of hardpoints || []) visit(ship?.Hardpoints);
  for (const item of allItems) visit(item.stdItem?.Ports);
  for (const cn of editable) locked.delete(cn);

  const integratedKeys = new Set();
  for (const cn of locked) {
    const key = nameKey(itemsByClass.get(cn));
    if (key) integratedKeys.add(key);
  }
  const integrated = new Set(locked);
  for (const item of allItems) {
    if (!isRack(item) || item.requiredTags || locked.has(item.className) || editable.has(item.className)) continue;
    const key = nameKey(item);
    if (!key || !integratedKeys.has(key)) continue;
    const cn = item.className.toLowerCase();
    const ownsKey = cn === key || cn.startsWith(key + '_');
    if (!ownsKey) integrated.add(item.className);
  }
  return integrated;
}

// Recomputed only when the ship or item data is swapped (build switch).
let integratedRackCache = { hardpoints: null, items: null, racks: new Set() };
function shipIntegratedRacks() {
  if (integratedRackCache.hardpoints !== allHardpoints || integratedRackCache.items !== itemsByClass) {
    integratedRackCache = { hardpoints: allHardpoints, items: itemsByClass, racks: findShipIntegratedRacks(allHardpoints) };
  }
  return integratedRackCache.racks;
}

/**
 * Get all compatible items for a hardpoint slot.
 */
export function getCompatibleItems(hardpoint) {
  if (!hardpoint.Types || hardpoint.Types.length === 0) return [];

  // Determine the broad type category from the Types array
  const typeSet = new Set(hardpoint.Types.map(t => normalizePortType(t).split('.')[0]));
  const integratedRacks = shipIntegratedRacks();

  return allItems.filter(item => {
    if (!typeSet.has(item.type)) return false;
    // Ship-integrated racks are never a swap target (see findShipIntegratedRacks).
    if (integratedRacks.has(item.className)) return false;
    // Hide cosmetic-variant items (paint-only twins of a base item) from
    // picker results. Items themselves stay in `itemsByClass` so installed
    // defaults that happen to reference a cosmetic still resolve via
    // getItemStats - they just can't be picked as a swap target.
    // `cosmeticVariantOf` carries the base item's className (truthy = is cosmetic).
    if (item.cosmeticVariantOf) return false;
    // Ground-vehicle missile racks never belong on a ship (see
    // isGroundVehicleMissileRack) - and one of them is mislabeled with the ship
    // rack type AND shares a display name with a real ship rack, so without
    // this guard a ship missile-rack swap can install it and leave the missile
    // picker empty.
    if (isGroundVehicleMissileRack(item)) return false;
    return isCompatible(item, hardpoint);
  });
}

/**
 * True for a missile rack whose missile sub-ports are typed for
 * GroundVehicleMissile - i.e. a ground-vehicle (Cyclone/Nova/etc.) rack.
 *
 * Some of these are mislabeled in the extractor data with the SHIP rack type
 * `MissileLauncher.MissileRack` and even share a display name with a genuine
 * ship rack: e.g. `GMRCK_S02_BEHR_Single_S02` and `MRCK_S02_BEHR_Single_S02`
 * are both "MSD-212 Missile Rack". Because the ground variant sorts first, a
 * Name+Size dedup in the rack-swap picker would surface it, and installing it
 * leaves the missile picker EMPTY - ship missiles don't match its
 * GroundVehicleMissile sub-port, and the GroundVehicleMissile missiles that do
 * are filtered out of the picker. Nova Tools configures ships, so these racks
 * are excluded from compatibility results entirely.
 */
export function isGroundVehicleMissileRack(item) {
  const ports = item?.stdItem?.Ports;
  if (!Array.isArray(ports)) return false;
  return ports.some(p =>
    Array.isArray(p?.Types) &&
    p.Types.some(t => typeof t === 'string' && t.includes('GroundVehicleMissile'))
  );
}

/**
 * Find a gimbal mount that fits a `WeaponGun.Gun` port. Used when a turret's
 * stdItem declares an Uneditable WeaponGun.Gun port with no InstalledItem
 * (e.g. AEGS_Idris_SCItem_Turret_Large_P / IFR-W57): the SHIP hardpoint data
 * proves a Mount_Gimbal_S<N> belongs there, but the gimbal's Type is
 * `Turret.GunTurret` so it doesn't match the port via isCompatible. This
 * helper looks up a passthrough gimbal by size + child-port compatibility
 * so the auto-default can install the missing layer.
 */
export function findGimbalMount(size, portTags = [], requiredTags = []) {
  const portTagSet = new Set([
    ...tokenizeTags(portTags),
    ...tokenizeTags(requiredTags),
  ]);
  return allItems.find(item => {
    if (item.type !== 'Turret' || item.subType !== 'GunTurret') return false;
    if (!/Gimbal|Mount_Gimbal/i.test(item.className)) return false;
    if (/Default_Fixed/i.test(item.className)) return false;
    const si = item.stdItem;
    if (!si) return false;
    // Match by the gimbal's gun-bearing CHILD port, not its own Size field.
    // CIG's Mount_Gimbal_S7 has Size=6 but its child port accepts an S7 gun
    // and ship hardpoint data installs it in S7 ports - so the gimbal's own
    // Size is unreliable. The child port's MaxSize is the real "this gimbal
    // is appropriate for an S<N> mount" signal.
    const gunChild = (si.Ports || []).find(p =>
      (p.Types || []).some(t => t === 'WeaponGun.Gun' || t.startsWith('WeaponGun.Gun.'))
    );
    if (!gunChild) return false;
    if ((gunChild.MaxSize ?? gunChild.MinSize) !== size) return false;
    // Tag gate - the gimbal's RequiredTags must be present in port tags
    const itemRequired = tokenizeTags(item.requiredTags);
    if (itemRequired.length > 0 && !itemRequired.every(t => portTagSet.has(t))) return false;
    return true;
  }) || null;
}

/**
 * Extract all editable slots from a ship's hardpoint config.
 * Returns a structured object grouped by category.
 */
export function extractSlots(shipConfig) {
  const hp = shipConfig.Hardpoints;
  const weapons = hp?.Weapons || {};
  const components = hp?.Components || {};
  // Ship-level PortTags apply to all weapon hardpoints (e.g. "DRAK_Buccaneer_Base")
  const shipPortTags = shipConfig.PortTags || [];

  const result = {
    weapons: [],
    turrets: [],
    missiles: [],
    systems: [],
    modules: [],
    emp: [],
    qed: [],
    mining: [],
    salvage: [],
    thrusters: []
  };

  // Salvage storage buffer - Hardpoints.Weapons.SalvageHardpoints.SalvageBuffer.InstalledItems[].Capacity
  // Stash on the shipConfig so it survives extractSlots round-trips and is available
  // anywhere the config is in scope. Each entry has just { Name, Capacity } (SCU).
  let salvageBufferSCU = 0;
  for (const buf of (hp?.Weapons?.SalvageHardpoints?.SalvageBuffer?.InstalledItems || [])) {
    salvageBufferSCU += buf.Capacity || 0;
  }
  shipConfig.salvageBufferSCU = salvageBufferSCU;

  // --- Helper: inert turrets ---
  // Locked turret ports that hold nothing equippable: torpedo/missile aiming
  // cameras, sensor and scanner heads, cosmetic scoops. Neither the ship data
  // nor the installed item declares a single sub-port, so they would only
  // render as an empty "Remote Turret" row. An item missing from the index is
  // kept - better an empty row than a hidden weapon.
  function isInertTurret(hp) {
    const base = hp.BaseLoadout;
    if (!base?.ClassName || !/^Turret/.test(base.Type || '')) return false;
    if (!(hp.Uneditable || (hp.Flags || []).includes('$uneditable'))) return false;
    if ((hp.Ports || []).length > 0) return false;
    const item = itemsByClass.get(base.ClassName);
    return !!item && !(item.stdItem?.Ports || []).length;
  }
  const keepHardpoint = hp => !isInertTurret(hp);

  // --- Helper: extract seat labels from RemoteController ---
  // Show label when: multiple seats share a turret, or a seat controls multiple turrets (copilot)
  // Dedicated single-gunner seats (Left, Right) are omitted unless they share control
  function isPilotSeat(s) {
    // "Pilot" as its own `_`/`.`-delimited token: Seat_Pilot, Pilot_Seat,
    // SeatDashboard_Pilot, Pilot_SeatDashboard - but not CoPilot / Co_Pilot.
    // (`\b` can't be used: `_` is a word character, so it missed every
    // `<Ship>_Pilot_Seat*` form.)
    return /(^|[._])Pilot([._]|$)/i.test(s) && !/Co_?Pilot/i.test(s);
  }
  function isCopilotSeat(s) {
    return /CoPilot|Copilot/i.test(s);
  }
  function isGunnerSeat(s) {
    return /Gunner/i.test(s);
  }
  // Slaved: true lets the pilot take a turret over while its own seat is
  // empty (a copilot-seat turret flown solo, a turret shared with the pilot).
  // It does not apply when every controlling seat is a dedicated gunner seat:
  // that turret is crewed, never flown by the pilot, even though the data
  // still flags it Slaved.
  function pilotHasControl(rc) {
    const seats = rc?.Seats || [];
    if (seats.some(isPilotSeat)) return true;
    if (rc?.Slaved !== true) return false;
    return !(seats.length > 0 && seats.every(isGunnerSeat));
  }
  function getSeatLabel(item) {
    const seats = item.RemoteController?.Seats || [];
    if (seats.length === 0) return null;
    const labels = [];
    // Pilot takes over a slaved turret whose own seat is empty
    const hasPilot = seats.some(s => isPilotSeat(s));
    if (!hasPilot && pilotHasControl(item.RemoteController)) labels.push('Pilot');
    for (const s of seats) {
      if (isPilotSeat(s)) labels.push('Pilot');
      else if (isCopilotSeat(s)) labels.push('Copilot');
      else if (/Turret[._]Seat[._](\w+)/i.test(s)) {
        const m = s.match(/Turret[._]Seat[._](\w+)/i);
        labels.push(m[1].replace(/_/g, ' '));
      }
      else {
        const m = s.match(/Seat[._](\w+)/i);
        if (m) labels.push(m[1].replace(/_/g, ' '));
      }
    }
    // Multiple seats share this turret - always show (e.g. "Pilot/Bridge").
    // Pilot leads regardless of the seat order in the data.
    if (labels.length > 1) {
      const pilotFirst = [...labels.filter(l => l === 'Pilot').slice(0, 1), ...labels.filter(l => l !== 'Pilot')];
      return pilotFirst.join('/');
    }
    // Pilot-only is implied in weapons group
    if (labels.length === 1 && labels[0] === 'Pilot') return null;
    // Single non-pilot seat - store for post-processing (may show if seat has multiple turrets)
    return labels.length > 0 ? labels[0] : null;
  }

  // Pilot weapons (all go to weapons - pilot has control)
  const pilotWeapons = (weapons.PilotWeapons?.InstalledItems || []).filter(keepHardpoint);
  for (const pw of pilotWeapons) {
    const flat = { category: 'Pilot Weapon', ...flattenHardpoint(pw, shipPortTags) };
    const label = getSeatLabel(pw);
    if (label) flat.seatLabel = label;
    result.weapons.push(flat);
  }

  // Remote turrets - split by pilot access
  // Pilot-controlled (pilot seat, or slaved to the pilot - see pilotHasControl) → weapons
  // Otherwise it's crew-only (→ turrets)
  const remoteTurrets = (weapons.RemoteTurrets?.InstalledItems || []).filter(keepHardpoint);
  for (const rt of remoteTurrets) {
    const pilotControlled = pilotHasControl(rt.RemoteController);
    const flat = { ...flattenHardpoint(rt, shipPortTags) };
    const label = getSeatLabel(rt);
    if (label) flat.seatLabel = label;
    if (pilotControlled) {
      flat.category = 'Remote Turret';
      result.weapons.push(flat);
    } else {
      flat.category = 'Remote Turret (Crew)';
      result.turrets.push(flat);
    }
  }

  // Manned turrets (gunner-only)
  const mannedTurrets = (weapons.MannedTurrets?.InstalledItems || []).filter(keepHardpoint);
  for (const mt of mannedTurrets) {
    result.turrets.push({
      category: 'Manned Turret',
      ...flattenHardpoint(mt, shipPortTags)
    });
  }

  // PDC turrets
  const pdcTurrets = (weapons.PDCTurrets?.InstalledItems || []).filter(keepHardpoint);
  for (const pdc of pdcTurrets) {
    result.turrets.push({
      category: 'PDC Turret',
      ...flattenHardpoint(pdc, shipPortTags)
    });
  }

  // Post-process turrets: only keep labels involving Pilot or Copilot
  // Shared turrets (e.g. "Pilot/Bridge") always keep their label
  // Copilot labels kept when copilot controls multiple turrets
  // Dedicated gunner seats (Left, Right, etc.) are never labeled
  const NOTABLE_SEATS = new Set(['Pilot', 'Copilot']);
  const seatCounts = {};
  for (const t of result.turrets) {
    if (t.seatLabel && !t.seatLabel.includes('/')) {
      seatCounts[t.seatLabel] = (seatCounts[t.seatLabel] || 0) + 1;
    }
  }
  for (const t of result.turrets) {
    if (!t.seatLabel) continue;
    if (t.seatLabel.includes('/')) continue; // shared turret - always keep
    if (!NOTABLE_SEATS.has(t.seatLabel)) { delete t.seatLabel; continue; } // not pilot/copilot - remove
    if ((seatCounts[t.seatLabel] || 0) <= 1) delete t.seatLabel; // single turret - no need
  }

  // Missile racks
  const missileRacks = weapons.MissileRacks?.InstalledItems || [];
  for (const mr of missileRacks) {
    result.missiles.push({
      category: 'Missile Rack',
      ...flattenHardpoint(mr, shipPortTags)
    });
  }

  // Bomb racks
  const bombRacks = weapons.BombRacks?.InstalledItems || [];
  for (const br of bombRacks) {
    result.missiles.push({
      category: 'Bomb Rack',
      ...flattenHardpoint(br, shipPortTags)
    });
  }

  // Utility hardpoints (tractor beams, etc.) - route to weapons/turrets like regular items
  const utilityHardpoints = (weapons.UtilityHardpoints?.InstalledItems || []).filter(keepHardpoint);
  for (const uh of utilityHardpoints) {
    const pilotControlled = pilotHasControl(uh.RemoteController);
    const flat = { category: 'Utility', isUtility: true, ...flattenHardpoint(uh, shipPortTags) };
    const label = getSeatLabel(uh);
    if (label) flat.seatLabel = label;
    if (pilotControlled || !uh.RemoteController) {
      result.weapons.push(flat);
    } else {
      result.turrets.push(flat);
    }
  }
  const utilityTurrets = (weapons.UtilityTurrets?.InstalledItems || []).filter(keepHardpoint);
  for (const ut of utilityTurrets) {
    const pilotControlled = pilotHasControl(ut.RemoteController);
    const flat = { category: 'Utility Turret', isUtility: true, ...flattenHardpoint(ut, shipPortTags) };
    const label = getSeatLabel(ut);
    if (label) flat.seatLabel = label;
    if (pilotControlled || !ut.RemoteController) {
      result.weapons.push(flat);
    } else {
      result.turrets.push(flat);
    }
  }

  // Interdiction hardpoints (EMP + QED) - Hardpoints.Weapons.InterdictionHardpoints.{EMP,QED}.InstalledItems
  const interdiction = weapons.InterdictionHardpoints || {};
  for (const emp of (interdiction.EMP?.InstalledItems || [])) {
    result.emp.push({ category: 'EMP', ...flattenHardpoint(emp, shipPortTags) });
  }
  for (const qed of (interdiction.QED?.InstalledItems || [])) {
    result.qed.push({ category: 'QED', ...flattenHardpoint(qed, shipPortTags) });
  }

  // Mining + Salvage hardpoints - Hardpoints.Weapons.{Mining,Salvage}Hardpoints.{PilotControlled,CrewControlled}
  // Cosmetic interior ports (Vehicle_Screen_MFD, Room) are stripped, but the tool-arm
  // mount itself is always kept - some ships (Argo MOTH, Aegis Reclaimer) have a
  // ship-specific arm that IS the equipment rather than a modular mount.
  function pruneCosmeticPorts(slot) {
    if (!slot.ports || slot.ports.length === 0) return slot;
    slot.ports = slot.ports
      .filter(p => {
        if ((p.types || []).some(t => t === 'Room')) return false;
        const cn = p.baseLoadout?.ClassName || '';
        if (/Vehicle_Screen|MFD/i.test(cn) || /MFD|Screen/i.test(p.portName || '')) return false;
        return true;
      })
      .map(pruneCosmeticPorts);
    return slot;
  }
  for (const [category, key, target] of [
    ['Mining', 'MiningHardpoints', result.mining],
    ['Salvage', 'SalvageHardpoints', result.salvage]
  ]) {
    const tree = weapons[key] || {};
    for (const group of ['PilotControlled', 'CrewControlled']) {
      for (const item of (tree[group]?.InstalledItems || [])) {
        target.push(pruneCosmeticPorts({ category, ...flattenHardpoint(item, shipPortTags) }));
      }
    }
  }


  // Thrusters - Hardpoints.Components.Propulsion.Thrusters.{MainThrusters,RetroThrusters,ManeuveringThrusters,VtolThrusters}
  // Thrusters in SPViewer data are flat stat blobs (no PortName/Types/BaseLoadout) so they cannot
  // be edited as slots. Aggregate by (kind, name) for a read-only summary row.
  const thrusterKinds = [
    ['MainThrusters', 'Main'],
    ['RetroThrusters', 'Retro'],
    ['ManeuveringThrusters', 'Maneuvering'],
    ['VtolThrusters', 'VTOL']
  ];
  const thrustersTree = components.Propulsion?.Thrusters || {};
  for (const [key, label] of thrusterKinds) {
    const items = thrustersTree[key]?.InstalledItems || [];
    if (items.length === 0) continue;
    // Thruster items in SPViewer don't carry a product name - `Name` is the port path.
    // Group by (Size, Grade) so identical thrusters of the same size collapse into one row.
    const groups = new Map();
    for (const item of items) {
      const groupKey = `${item.Size || 0}|${item.Grade || 0}`;
      const existing = groups.get(groupKey);
      if (existing) {
        existing.count += 1;
        existing.totalThrust += item.ThrustCapacity || 0;
        existing.totalFuelPerSec += item.FuelUsagePerSecond || 0;
      } else {
        groups.set(groupKey, {
          size: item.Size || 0,
          grade: item.Grade || 0,
          count: 1,
          totalThrust: item.ThrustCapacity || 0,
          totalFuelPerSec: item.FuelUsagePerSecond || 0,
          fuelBurnPerMN: item.FuelBurnRatePerMN || 0
        });
      }
    }
    for (const g of groups.values()) {
      result.thrusters.push({
        category: 'Thrusters',
        thrusterKind: key,
        thrusterLabel: label,
        uneditable: true,
        ...g
      });
    }
  }

  // Systems components
  const systemCategories = [
    ['Shields', 'Systems', 'Shields'],
    ['PowerPlants', 'Propulsion', 'Power Plants'],
    ['Coolers', 'Systems', 'Coolers'],
    ['QuantumDrives', 'Propulsion', 'Quantum Drive'],
    ['Radars', 'Avionics', 'Radar'],
    ['LifeSupport', 'Systems', 'Life Support'],
    ['FlightBlade', 'Avionics', 'Flight Blade']
  ];

  for (const [key, section, label] of systemCategories) {
    const slots = components[section]?.[key]?.InstalledItems || [];
    for (const slot of slots) {
      if (slot.MinSize == null && slot.MaxSize == null) continue; // skip empty/undefined slots
      // Surface sub-ports declared on the installed item (e.g. a Quantum
      // Drive's JumpDrive port) when the ship data doesn't pre-declare them.
      const explicitSubs = (slot.Ports || []).filter(isLoadoutPort);
      const installedCls = slot.BaseLoadout?.ClassName;
      const synthSubs = (explicitSubs.length === 0 && installedCls)
        ? syntheticPortsFromItem(installedCls)
        : [];
      const subs = [...explicitSubs, ...synthSubs];
      result.systems.push({
        category: label,
        portName: slot.PortName,
        minSize: slot.MinSize,
        maxSize: slot.MaxSize,
        types: slot.Types || [],
        uneditable: slot.Uneditable || false,
        loadout: slot.Loadout || slot.BaseLoadout?.ClassName,
        baseLoadout: slot.BaseLoadout,
        ports: subs.map(sub => flattenPort(sub, slot.PortName, slot.PortTags || [], slot.RequiredTags || [])),
        portTags: slot.PortTags || [],
        requiredTags: slot.RequiredTags || []
      });
    }
  }

  // Modules
  const moduleSlots = components.Modules?.InstalledItems || [];
  for (const slot of moduleSlots) {
    if (slot.MinSize == null && slot.MaxSize == null) continue;
    result.modules.push({
      category: 'Module',
      portName: slot.PortName,
      minSize: slot.MinSize,
      maxSize: slot.MaxSize,
      types: slot.Types || [],
      uneditable: slot.Uneditable || false,
      loadout: slot.Loadout || slot.BaseLoadout?.ClassName || null,
      baseLoadout: slot.BaseLoadout || null,
      portTags: slot.PortTags || [],
      requiredTags: slot.RequiredTags || [],
      ports: slot.Ports || []
    });
  }

  return result;
}

// Ports with these type prefixes are cosmetic / attachment machinery
// (ventilation, barrels, door panels, decals, monitor screens, seat panels,
// turret backing plates) and should never appear as loadout slots in the tree.
//   - Prefix forms: `WeaponAttachment.Barrel`, `Display.X`, `Door.X`, `Seat.X`
//     plus the bare `Display`, `Door`, `Seat`, `Misc` types used by turret /
//     bay-door / structural-mount port data
//   - Suffix forms: `Button.DoorPart`, `Lightgroup.DoorPart`, etc. - type
//     names where the *part* word lives at the end
const NON_LOADOUT_PORT_RE = /^(WeaponAttachment|Display|Door|Seat|Misc)(\.|$)|\.(DoorPart|SeatPart|DisplayPart|LightPart|DecalPart)$/i;
export function isLoadoutPort(p) {
  const types = p.Types || [];
  if (types.length === 0) return true;
  return !types.every(t => NON_LOADOUT_PORT_RE.test(t));
}

// A pseudo-port shape that mirrors what ship hardpoint data provides,
// built from an item's stdItem.Ports. Used to surface a mining laser's
// MiningModifier sub-ports in the slot tree even when the ship
// hardpoint data doesn't pre-declare them.
//
// Missile/bomb racks: the ship data only lists a rack's ordnance ports when
// the ship's default loadout fills them. A rack the game installs empty would
// otherwise show no ordnance slots until it is re-picked (rebuildSlotPorts
// builds them from the item), so expose the rack's own ordnance ports here.
export function syntheticPortsFromItem(className) {
  const item = itemsByClass.get(className);
  const si = item?.stdItem;
  if (!si?.Ports) return [];
  const isRack = item.type === 'MissileLauncher' || item.type === 'BombLauncher';
  return si.Ports.filter(p => {
    if (!isLoadoutPort(p)) return false;
    // Surface user-editable sub-item ports: mining/salvage modifier slots on
    // heads, the JumpDrive port on a modern Quantum Drive, and the ordnance
    // ports on a missile/bomb rack.
    const types = p.Types || [];
    const isModule = types.some(t => /^(Mining|Salvage)Modifier|^JumpDrive/i.test(t));
    const isOrdnance = isRack && types.some(t => /^(Missile|Bomb)(\.|$)/.test(t));
    if (!isModule && !isOrdnance) return false;
    if (p.Uneditable || (p.Flags || []).includes('uneditable')) return false;
    return true;
  });
}

/**
 * RequiredTags a sub-port inherits from its IMMEDIATE parent.
 *
 * CIG authors a bespoke weapon port by tagging both levels, but sometimes omits
 * RequiredTags on the child: the Stingray / P-52 Merlin S2 nose mounts give the
 * child PortTags ["Merlin_Nose"] with no RequiredTags, while the same ship's S4
 * Wolf_Gun ports carry RequiredTags on both. Without this the S2 child accepts
 * every same-size gun instead of the two Merlin_Nose weapons.
 *
 * Two guards keep this from over-reaching, both measured against Live
 * 4.9.0.12344265 + PTU 4.10.0.12488012:
 *  - Only tags the child ITSELF advertises in PortTags are inherited. A parent
 *    tag the child doesn't repeat is not a constraint on the child.
 *  - Only ONE level. A turret's RequiredTags (e.g. AEGS_Idris_Front_Turret)
 *    describe the turret, not the gun inside it; inheriting transitively
 *    emptied 1260 sub-ports.
 * Net effect: 0 ports change in Live, 9 narrow in PTU (Merlin + Stingray,
 * 29 candidates -> 2), and no port is left empty.
 */
function inheritedBespokeTags(p, parentRequiredTags) {
  const parentReq = tokenizeTags(parentRequiredTags);
  if (parentReq.length === 0) return [];
  const own = new Set(tokenizeTags(p.PortTags));
  return parentReq.filter(t => own.has(t));
}

function flattenPort(p, parentPath, extraTags, parentRequiredTags) {
  const uniqueName = parentPath ? `${parentPath}/${p.PortName}` : p.PortName;
  const portTags = [...(p.PortTags || []), ...(extraTags || [])];
  const explicitSubs = (p.Ports || []).filter(isLoadoutPort);
  // If the port has no explicit sub-ports but carries an installed mining/
  // salvage head, expose that head's module ports as children so the user
  // sees its consumable module slots in the UI.
  const installedCls = p.BaseLoadout?.ClassName;
  const synthSubs = (explicitSubs.length === 0 && installedCls)
    ? syntheticPortsFromItem(installedCls)
    : [];
  const subs = [...explicitSubs, ...synthSubs];
  return {
    portName: uniqueName,
    minSize: p.MinSize,
    maxSize: p.MaxSize,
    types: p.Types || [],
    uneditable: p.Uneditable || false,
    loadout: p.Loadout || p.BaseLoadout?.ClassName,
    baseLoadout: p.BaseLoadout,
    portTags,
    requiredTags: p.RequiredTags || inheritedBespokeTags(p, parentRequiredTags),
    ports: subs.map(sub => flattenPort(sub, uniqueName, extraTags, p.RequiredTags || []))
  };
}

// Extract turret position from PortName or ClassName (e.g. "Front Left", "Rear", "Nose")
function extractPosition(hp) {
  const source = `${hp.PortName || ''}_${hp.BaseLoadout?.ClassName || ''}`.toLowerCase();
  const parts = [];
  if (/nose|bridge/.test(source)) return null; // position obvious from name
  if (/front|forward/.test(source)) parts.push('Front');
  else if (/rear|back|tail/.test(source)) parts.push(/tail/.test(source) ? 'Tail' : 'Rear');
  if (/top|upper/.test(source)) parts.push('Top');
  else if (/bottom|lower/.test(source)) parts.push('Bottom');
  if (/[_.]left(?:[_.]|$)/i.test(source)) parts.push('Left');
  else if (/[_.]right(?:[_.]|$)/i.test(source)) parts.push('Right');
  if (parts.length === 0 && /main/.test(source)) parts.push('Main');
  return parts.length > 0 ? parts.join(' ') : null;
}

function flattenHardpoint(hp, extraTags) {
  const flat = flattenPort(hp, null, extraTags);
  flat.gimballed = hp.Gimballed || false;
  flat.turret = hp.Turret || false;
  flat.position = extractPosition(hp);
  return flat;
}

/**
 * True when a saved loadout was captured on a different hull than `slots`.
 *
 * Saved loadouts (per-ship autosave, tabs, named builds) are keyed by the
 * ship's display Name and hold the FULL port map, stock items included. When
 * the hull behind a Name changes - a Gold Standard build replacing the old
 * one, or CIG reworking a ship - restoring that map lays the old hull's stock
 * shields, turrets and racks over the new one, with nothing to show for it.
 *
 * A locked port is the tell: the user can never change it, so a saved value
 * that differs from the hull's own can only come from another hull. Only
 * ports locked all the way up count - below an editable port the user may
 * have swapped the mount, which legitimately changes what sits underneath.
 */
export function isLoadoutForOtherHull(saved, slots, defaultLoadout) {
  if (!saved || typeof saved !== 'object' || !defaultLoadout) return false;
  let mismatch = false;
  const visit = (port) => {
    if (mismatch || !port?.uneditable) return;
    const name = port.portName;
    if (name && Object.hasOwn(saved, name) && name in defaultLoadout && saved[name] !== defaultLoadout[name]) {
      mismatch = true;
      return;
    }
    (port.ports || []).forEach(visit);
  };
  for (const group of Object.values(slots || {})) {
    if (Array.isArray(group)) group.forEach(visit);
  }
  return mismatch;
}

/**
 * Build a loadout state from a ship's default config.
 * Returns a map of portName -> className for all slots.
 */
export function buildDefaultLoadout(slots) {
  const loadout = {};

  function addSlot(slot) {
    if (slot.loadout) {
      loadout[slot.portName] = slot.baseLoadout?.ClassName || slot.loadout;
    } else if (slot.types?.length > 0) {
      // Ensure all editable ports have an entry (even null) so saved values can be restored
      loadout[slot.portName] = null;
    }
    for (const sub of slot.ports || []) {
      addSlot(sub);
    }
  }

  for (const group of Object.values(slots)) {
    for (const slot of group) {
      addSlot(slot);
    }
  }

  return loadout;
}

/**
 * Build power pip allocation channels for a ship.
 * Each channel represents a system that consumes power pips.
 */
export function buildPipAllocation(loadout, slots, shipConfig, powerOutput, shieldOverrides, disabledPorts) {
  const channels = [];

  const isDisabled = (portName) => !!(disabledPorts && disabledPorts.has(portName));

  // --- Helper: get power draw for a className ---
  function getPowerDraw(className) {
    const si = getItemStats(className);
    if (!si) return { segment: 0, minFraction: 0 };
    const rn = si.ResourceNetwork;
    if (!Array.isArray(rn)) return { segment: 0, minFraction: 0 };
    for (const node of rn) {
      if (node.Conversion) {
        for (const conv of node.Conversion) {
          if (conv.Consumption?.Resource === 'Power') {
            return { segment: conv.Consumption.Segment || 0, minFraction: conv.MinConsumptionFraction || 0 };
          }
        }
      }
      if (node.Consumption) {
        for (const cons of node.Consumption) {
          if (cons.Resource === 'Power') {
            return { segment: cons.UnitPerSec || cons.Segment || 0, minFraction: cons.MinConsumptionFraction || 0 };
          }
        }
      }
    }
    return { segment: 0, minFraction: 0 };
  }

  // Route power based on what's INSTALLED, not the slot's declared category.
  // A utility hardpoint can hold a gun turret variant (e.g. Reliant Kore's
  // right wing tip can be swapped from tractor mount to gun turret), and a
  // gun's power draw should land on the weapons channel, not the utility
  // channel.
  function isUtilityItem(cn) {
    if (!cn) return false;
    const si = getItemStats(cn);
    if (!si) return false;
    if (si.TractorBeam) return true;
    const type = si.Type || '';
    if (/^(TractorBeam|ToolArm)\b/i.test(type)) return true;
    return false;
  }

  // --- Weapons: capped by ship capacitor ---
  const weaponPoolSize = shipConfig?.weaponPoolSize || 0;
  let weaponNeeded = 0, weaponEM = 0;
  function sumWeaponPower(slot) {
    const cn = loadout[slot.portName];
    // Skip utility items - they're counted on the utility channel below.
    if (cn && !isDisabled(slot.portName) && !isUtilityItem(cn)) {
      const { segment } = getPowerDraw(cn);
      if (segment > 0) weaponNeeded += segment;
      weaponEM += getComponentEM(cn);
    }
    for (const sub of slot.ports || []) sumWeaponPower(sub);
  }
  // Walk every weapon-bearing slot tree, including utility hardpoints - the
  // installed-item check above keeps tractor beams off the weapons channel.
  for (const w of [...(slots.weapons || []), ...(slots.turrets || [])]) {
    sumWeaponPower(w);
  }
  channels.push({ key: 'weapons', label: 'WPN', max: weaponPoolSize, needed: weaponNeeded, allocated: Math.min(weaponNeeded, weaponPoolSize), min: 0, powerSegment: weaponPoolSize, powerRanges: null, emNominal: weaponEM });

  // --- Interdiction (EMP + QED), Mining, Salvage - each draws directly from
  // the PP, not the weapon capacitor. Mantis-style ships have weaponPoolSize=0
  // but still need to power their QED, so these can't live on the weapons channel.
  // Channels start UNPOWERED (allocated=0) - user opts in via the pip panel.
  // Inserted between utility and radar (see splice below).
  const auxChannels = [];
  function makeAuxChannel(key, label, slotGroups) {
    let max = 0, min = 0, pr = null, em = 0;
    function sumPower(slot) {
      const cn = loadout[slot.portName];
      if (cn && !isDisabled(slot.portName)) {
        const pd = getPowerDraw(cn);
        if (pd.segment > 0) {
          max += pd.segment;
          min += Math.round(pd.minFraction * pd.segment);
        }
        pr = pr || getComponentPowerRanges(cn);
        em += getComponentEM(cn);
      }
      for (const sub of slot.ports || []) sumPower(sub);
    }
    for (const group of slotGroups) {
      for (const s of (group || [])) sumPower(s);
    }
    if (max > 0) {
      auxChannels.push({ key, label, max: Math.round(max), allocated: 0, min: Math.round(min), powerSegment: Math.round(max), powerRanges: pr, emNominal: em });
    }
  }
  makeAuxChannel('interdiction', 'INT', [slots.emp, slots.qed]);
  makeAuxChannel('mining', 'MIN', [slots.mining]);
  makeAuxChannel('salvage', 'SLV', [slots.salvage]);

  // --- Shields: pip pool from ALL shields, powered 2 selected by lowest min then grade ---
  const shieldSlots = (slots.systems || []).filter(s => s.category === 'Shields');
  const shieldBreakdown = [];
  for (let i = 0; i < shieldSlots.length; i++) {
    const portName = shieldSlots[i].portName;
    const cn = loadout[portName];
    const { segment, minFraction } = cn ? getPowerDraw(cn) : { segment: 0, minFraction: 0 };
    const pr = cn ? getComponentPowerRanges(cn) : null;
    const sMin = Math.round(minFraction * segment);
    const sMax = segment;
    const sEM = cn ? getComponentEM(cn) : 0;
    // Crafted stats - Max. Shield Strength modifier flows into Shield.Health,
    // which drives the auto-power-selection tiebreak below.
    const si = cn ? getCraftedItemStats(cn, portName) : null;
    const grade = si?.Grade ?? 99;
    const hp = si?.Shield?.Health ?? 0;
    shieldBreakdown.push({ min: sMin, max: sMax, powerRanges: pr, emNominal: sEM, grade, hp, slotIdx: i });
  }
  // Select 2 powered shields: use overrides if valid, else auto-select
  const equipped = shieldBreakdown.filter(s => s.max > 0);
  const equippedIdxSet = new Set(equipped.map(s => s.slotIdx));
  let poweredIndices;
  if (Array.isArray(shieldOverrides) && shieldOverrides.length > 0 && shieldOverrides.length <= 2 && shieldOverrides.every(i => equippedIdxSet.has(i))) {
    poweredIndices = new Set(shieldOverrides);
  } else {
    const sorted = [...equipped].sort((a, b) => (a.min - b.min) || (b.hp - a.hp) || (a.grade - b.grade) || (a.slotIdx - b.slotIdx));
    poweredIndices = new Set(sorted.slice(0, 2).map(s => s.slotIdx));
  }
  for (const s of shieldBreakdown) {
    s.powered = poweredIndices.has(s.slotIdx);
  }
  // Pip pool = sum of ALL shield segments; min = sum of ALL shield min pips
  // Powered shields' segments determine effective power draw for PP/EM
  const shieldMax = equipped.reduce((sum, s) => sum + s.max, 0);
  const shieldMin = equipped.reduce((sum, s) => sum + s.min, 0);
  const poweredMax = equipped.filter(s => s.powered).reduce((sum, s) => sum + s.max, 0);
  channels.push({ key: 'shields', label: 'SHD', max: shieldMax, allocated: shieldMax, min: shieldMin, poweredMax, shieldSlots: shieldBreakdown });

  // --- Quantum Drive ---
  const qdSlots = (slots.systems || []).filter(s => s.category === 'Quantum Drive');
  let qdMax = 0, qdMin = 0, qdPR = null, qdEM = 0;
  for (const s of qdSlots) {
    const cn = loadout[s.portName];
    if (cn) {
      const pd = getPowerDraw(cn);
      qdMax += pd.segment;
      qdMin += Math.round(pd.minFraction * pd.segment);
      qdPR = qdPR || getComponentPowerRanges(cn);
      qdEM += getComponentEM(cn);
    }
  }
  // QD is binary in-game: either fully engaged (drawing its full segment) or
  // off. There's no fractional power draw. The pip panel renders the channel
  // as a single toggle and the click handler snaps to 0 or max - no in-between.
  channels.push({ key: 'quantumDrive', label: 'QD', max: Math.round(qdMax), allocated: 0, min: 0, powerSegment: Math.round(qdMax), powerRanges: qdPR, emNominal: qdEM, binary: true });

  // --- Utility (tractor beams, etc.) - only count slots whose INSTALLED item
  // is genuinely a utility item. A utility hardpoint with a gun turret swapped
  // in must not keep an empty utility pip channel alive.
  let utilMax = 0, utilMin = 0, utilPR = null;
  function sumUtilityPower(slot) {
    const cn = loadout[slot.portName];
    if (cn && isUtilityItem(cn)) {
      const pd = getPowerDraw(cn);
      if (pd.segment > 0) { utilMax += pd.segment; utilMin += Math.round(pd.minFraction * pd.segment); }
      utilPR = utilPR || getComponentPowerRanges(cn);
    }
    for (const sub of slot.ports || []) sumUtilityPower(sub);
  }
  for (const group of Object.values(slots)) {
    for (const s of group) {
      // Walk any slot tree - `isUtilityItem(cn)` filters per-installed-item.
      sumUtilityPower(s);
    }
  }
  if (utilMax > 0) {
    channels.push({ key: 'utility', label: 'UTL', max: Math.round(utilMax), allocated: Math.round(utilMax), min: Math.round(utilMin), powerSegment: Math.round(utilMax), powerRanges: utilPR });
  }

  // Insert the aux channels (interdiction/mining/salvage) right after utility,
  // before radar - they're "specialty" channels and stay grouped together.
  for (const ch of auxChannels) channels.push(ch);

  // --- Radar ---
  const radarSlots = (slots.systems || []).filter(s => s.category === 'Radar');
  let radarMax = 0, radarMin = 0, radarPR = null, radarEM = 0;
  for (const s of radarSlots) {
    const cn = loadout[s.portName];
    if (cn) { const pd = getPowerDraw(cn); radarMax += pd.segment; radarMin += Math.round(pd.minFraction * pd.segment); radarPR = radarPR || getComponentPowerRanges(cn); radarEM += getComponentEM(cn); }
  }
  channels.push({ key: 'radar', label: 'RAD', max: Math.round(radarMax), allocated: Math.round(radarMax), min: Math.round(radarMin), powerSegment: Math.round(radarMax), powerRanges: radarPR, emNominal: radarEM });

  // --- Life Support ---
  const lsSlots = (slots.systems || []).filter(s => s.category === 'Life Support');
  let lsMax = 0, lsMin = 0, lsPR = null, lsEM = 0;
  for (const s of lsSlots) {
    const cn = loadout[s.portName];
    if (cn) { const pd = getPowerDraw(cn); lsMax += pd.segment; lsMin += Math.round(pd.minFraction * pd.segment); lsPR = lsPR || getComponentPowerRanges(cn); lsEM += getComponentEM(cn); }
  }
  channels.push({ key: 'lifeSupport', label: 'LS', max: Math.round(lsMax), allocated: Math.round(lsMax), min: Math.round(lsMin), powerSegment: Math.round(lsMax), powerRanges: lsPR, emNominal: lsEM });

  // --- Coolers: separate channel per slot ---
  const coolerSlots = (slots.systems || []).filter(s => s.category === 'Coolers');
  for (let i = 0; i < coolerSlots.length; i++) {
    const cn = loadout[coolerSlots[i].portName];
    const { segment, minFraction } = cn ? getPowerDraw(cn) : { segment: 0, minFraction: 0 };
    const pr = cn ? getComponentPowerRanges(cn) : null;
    const cEM = cn ? getComponentEM(cn) : 0;
    const cMax = Math.round(segment);
    const cMin = Math.round(minFraction * segment);
    channels.push({ key: `cooler_${i}`, label: `C${i + 1}`, max: cMax, allocated: cMax, min: cMin, powerSegment: cMax, powerRanges: pr, emNominal: cEM });
  }

  // --- Engine/Boost: from IFCS (flight controller) segment ---
  // The IFCS has its own power Segment value; reducing to 0 disables thrust entirely.
  const ifcsSeg = Math.round(shipConfig?.ifcsSegment || 0);
  const ifcsMinFrac = shipConfig?.ifcsMinFraction || 0;
  const ifcsMin = Math.round(ifcsMinFrac * ifcsSeg);
  const ifcsPR = shipConfig?.ifcsPowerRanges || null;
  // Insert engine as second column (after weapons)
  channels.splice(1, 0, { key: 'engine', label: 'ENG', max: ifcsSeg, allocated: ifcsSeg, min: ifcsMin, powerSegment: ifcsSeg, powerRanges: ifcsPR });

  // --- Apply default allocation priority ---
  applyDefaultAllocation(channels, powerOutput, loadout, slots);

  return { channels, powerOutput };
}

/**
 * Apply default pip allocation priority.
 * Priority: cooling to <100%, min radar, min LS, full shields, full weapons, full boost, fill rest.
 * For coolers: better to max one cooler than partially power multiple.
 */
function applyDefaultAllocation(channels, budget, loadout, slots) {
  const byKey = {};
  for (const ch of channels) byKey[ch.key] = ch;

  // Reset all non-fixed to 0
  for (const ch of channels) if (!ch.fixed) ch.allocated = 0;

  let remaining = budget;
  // Account for fixed channels
  for (const ch of channels) if (ch.fixed) remaining -= ch.allocated;

  function addPips(key, target, budgetCost) {
    const ch = byKey[key];
    if (!ch || ch.fixed) return;
    const cap = ch.needed != null ? Math.min(Math.ceil(ch.needed), ch.max) : ch.max;
    const want = Math.round(Math.min(target, cap));
    const add = Math.max(0, want - ch.allocated);
    // budgetCost: how much of the budget this actually consumes (for shields: only powered pips)
    const cost = budgetCost != null ? Math.min(budgetCost, Math.floor(remaining)) : Math.min(add, Math.floor(remaining));
    const give = budgetCost != null ? add : cost; // if budgetCost specified, always give full amount
    ch.allocated += give;
    remaining -= cost;
  }

  const coolerKeys = channels.filter(c => c.key.startsWith('cooler_')).map(c => c.key);

  // Priority 0: min engine (must have thrust)
  addPips('engine', byKey['engine']?.min || 0);

  // Priority 1: min essentials first so heat baseline is known.
  // Aux channels (interdiction/mining/salvage) are NOT auto-allocated - they
  // start unpowered and the user opts in via the pip panel.
  addPips('radar', byKey['radar']?.min || 0);
  addPips('lifeSupport', byKey['lifeSupport']?.min || 0);

  // Priority 1b: cooling - add cooler pips one at a time until coolingPercent
  // drops to <= 100% (demand equals supply). Per-pip granularity avoids the
  // overshoot from maxing a whole cooler in one step, which can leave us at
  // e.g. 53% cooling - twice the needed supply - burning pips and EM signature
  // for nothing. The PowerRange curve still rewards filling one cooler before
  // starting the next, since we only move to cooler_N+1 when cooler_N is maxed
  // and demand still exceeds supply.
  // The first step jumps straight to the channel's min: MinConsumptionFraction
  // makes every allocation between 1 and min-1 unreachable, since a running
  // cooler always draws at least its minimum. Stopping below min produced a
  // pip column that renders neither filled nor powered-off (a cooler can even
  // have min == max, drawing its whole segment or nothing).
  // First, temporarily set all other channels to their expected final values to
  // estimate heat.
  const savedAlloc = {};
  for (const ch of channels) savedAlloc[ch.key] = ch.allocated;

  // Simulate expected final allocation for heat estimation
  // Shields use poweredMax (only powered shields contribute heat), not max (all shields)
  // Radar/LS excluded - they get full pips later and the post-allocation check handles it
  for (const [k, prop] of Object.entries({ weapons: 'needed', engine: 'max', utility: 'max' })) {
    const ch = byKey[k];
    if (ch) ch.allocated = prop === 'needed' ? Math.min(Math.ceil(ch.needed || 0), ch.max) : ch.max;
  }
  if (byKey['shields']) byKey['shields'].allocated = byKey['shields'].poweredMax || byKey['shields'].max;

  // Reset coolers from any savedAlloc baseline - we'll fill from zero.
  for (const k of coolerKeys) byKey[k].allocated = 0;

  for (const k of coolerKeys) {
    let cooling = calculateCoolingStats(channels, loadout, slots);
    if (cooling.coolingPercent <= 100) break;
    const floor = Math.min(byKey[k].min || 0, byKey[k].max);
    while (byKey[k].allocated < byKey[k].max) {
      byKey[k].allocated = Math.max(floor, byKey[k].allocated + 1);
      cooling = calculateCoolingStats(channels, loadout, slots);
      if (cooling.coolingPercent <= 100) break;
    }
    if (cooling.coolingPercent <= 100) break;
  }

  // Restore actual allocations (coolers keep what was just set, others reset)
  for (const ch of channels) {
    if (!ch.key.startsWith('cooler_')) ch.allocated = savedAlloc[ch.key];
  }
  // Recalculate remaining budget
  remaining = budget;
  for (const ch of channels) remaining -= ch.allocated;

  // Priority 2: full shields - allocate all pips visually, but only powered shields consume budget
  const shieldCh = byKey['shields'];
  const shieldBudgetCost = shieldCh?.poweredMax || 0;
  addPips('shields', shieldCh?.max || 0, shieldBudgetCost);

  // Priority 3: full weapons
  const wpnNeeded = byKey['weapons']?.needed;
  addPips('weapons', wpnNeeded != null ? Math.ceil(wpnNeeded) : (byKey['weapons']?.max ?? 0));

  // Priority 4: full utility
  addPips('utility', byKey['utility']?.max || 0);

  // Priority 5: full engine (boost)
  addPips('engine', byKey['engine']?.max || 0);

  // Priority 6: fill remaining - full radar, full LS
  addPips('radar', byKey['radar']?.max || 0);
  addPips('lifeSupport', byKey['lifeSupport']?.max || 0);

  // Post-allocation cooling check: radar/LS/other late allocations may have
  // increased heat beyond what the initial cooler estimate accounted for.
  // If cooling > 100%, steal pips from lowest-priority channels and give to coolers.
  const postCooling = calculateCoolingStats(channels, loadout, slots);
  const anyRoomInCoolers = coolerKeys.some(ck => {
    const cch = byKey[ck];
    return cch && cch.allocated < cch.max;
  });
  if (postCooling.coolingPercent >= 100 && anyRoomInCoolers) {
    // Steal from lowest priority first: interdiction/mining/salvage, LS, radar, engine, utility
    const stealOrder = ['interdiction', 'mining', 'salvage', 'lifeSupport', 'radar', 'engine', 'utility'];
    for (const k of stealOrder) {
      const ch = byKey[k];
      if (!ch || ch.allocated <= (ch.min || 0)) continue;
      while (ch.allocated > (ch.min || 0)) {
        ch.allocated--;
        remaining++;
        // Try adding to an unfilled cooler. Same MinConsumptionFraction floor
        // as the initial fill: switching a cooler on costs its whole minimum,
        // so an idle cooler may need two stolen pips before it can take any.
        for (const ck of coolerKeys) {
          const cch = byKey[ck];
          if (!cch || cch.allocated >= cch.max) continue;
          const step = Math.max(Math.min(cch.min || 0, cch.max), cch.allocated + 1) - cch.allocated;
          if (step > remaining) continue;
          cch.allocated += step;
          remaining -= step;
          break;
        }
        const recheck = calculateCoolingStats(channels, loadout, slots);
        if (recheck.coolingPercent < 100) break;
      }
      const recheck2 = calculateCoolingStats(channels, loadout, slots);
      if (recheck2.coolingPercent < 100) break;
    }
  }
}

/**
 * Get the PowerRanges object for a component by className.
 */
function getComponentPowerRanges(className) {
  const si = getItemStats(className);
  if (!si?.ResourceNetwork) return null;
  for (const node of si.ResourceNetwork) {
    if (node.PowerRanges) return node.PowerRanges;
  }
  return null;
}

function getComponentEM(className) {
  const si = getItemStats(className);
  if (!si?.ResourceNetwork) return 0;
  // Quantum drives ship with two ResourceNetwork entries carrying identical
  // EM nominals (one per operational mode - spool / cruise). Only one mode
  // is active at a time, so the displayed/effective EM is a single node's
  // value, not the sum. Max across nodes gives the right answer here AND
  // collapses to the value itself for the single-node case (everything else).
  let em = 0;
  for (const node of si.ResourceNetwork) {
    const v = node.Signatures?.Electromagnetic?.Nominal || 0;
    if (v > em) em = v;
  }
  return em;
}

/**
 * Look up the PowerRanges modifier for a given number of active segments.
 * PowerRanges is a map like { Low: {Start, Modifier}, Medium: {Start, Modifier}, ... }
 * Returns the modifier for the range that the segment count falls into.
 */
function getPowerRangeModifier(powerRanges, activeSegments) {
  if (!powerRanges || !activeSegments) return 0;
  const ranges = Object.values(powerRanges)
    .filter(r => r.RegisterRange)
    .sort((a, b) => a.Start - b.Start);
  let modifier = 0;
  for (const r of ranges) {
    if (activeSegments >= r.Start) modifier = r.Modifier;
  }
  return modifier;
}

/**
 * Like getPowerRangeModifier but uses ALL PowerRanges entries (no RegisterRange filter).
 * Used for cooling output and shield resistance where all ranges affect scaling.
 */
export function getPowerRangeModifierAll(powerRanges, activeSegments) {
  if (!powerRanges || !activeSegments) return 0;
  const ranges = Object.values(powerRanges)
    .sort((a, b) => a.Start - b.Start);
  let modifier = 0;
  for (const r of ranges) {
    if (activeSegments >= r.Start) modifier = r.Modifier;
  }
  return modifier;
}

/**
 * Calculate cooling stats from the current pip allocation and loadout.
 *
 * Supply per cooler = UnitPerSec × PowerRangeModifier(pips) × (pips / maxPips)
 *   - At full pips with modifier 1.0 this equals UnitPerSec.
 *   - Lower pips scale both by the modifier AND linearly by pip fraction.
 *
 * Demand has two components:
 *   1. Power consumption heat = total allocated pips (1 unit per pip for ALL components)
 *   2. Operational heat = Segment × modifier(pips) × (pips/maxPips) for non-cooler
 *      components with PowerRanges. This is the dynamic "cooling value" shown in-game.
 *      Coolers are excluded (they provide cooling, not consume it).
 *
 * For shields: pips are distributed to individual shields one at a time (fill first
 * shield to max before moving to next). Each shield's operational heat uses its own
 * PowerRanges modifier.
 *
 * Cooling% = (demand / supply) × 100
 *   - Below 100% means cooling is sufficient.
 *   - Above 100% means the ship is overheating.
 *
 * Returns { coolingSupply, coolingDemand, coolingPercent }
 */
/**
 * Distribute shield pips to ALL shields: 1 pip each (largest seg first),
 * remaining split evenly, capped at each shield's max seg with overflow redistributed.
 * Used for IR (cooling demand).
 */
export function distributeShieldPipsAll(shieldSlots, totalPips) {
  const indices = shieldSlots.map((s, i) => i).filter(i => shieldSlots[i].max > 0);
  return distributePips(indices, shieldSlots, totalPips);
}

/**
 * Distribute shield pips to powered shields only (2 shields selected by
 * lowest min pips, then best grade, then slot order).
 * Used for EM calculation and PP power draw.
 */
export function distributeShieldPipsTop2(shieldSlots, totalPips) {
  // Use the 'powered' flag set during buildPipAllocation
  const indices = shieldSlots.map((s, i) => i).filter(i => shieldSlots[i].powered && shieldSlots[i].max > 0);
  return distributePips(indices, shieldSlots, totalPips);
}

/**
 * Shared two-phase distribution over the given shield indices:
 *   Phase 1: 1 pip to each shield, largest segment first.
 *   Phase 2: remainder split evenly, capped at each shield's max segment,
 *            overflow redistributed to the still-uncapped shields.
 */
function distributePips(indices, shieldSlots, totalPips) {
  const result = new Array(shieldSlots.length).fill(0);
  if (totalPips <= 0 || indices.length === 0) return result;

  const sorted = [...indices].sort((a, b) => shieldSlots[b].max - shieldSlots[a].max);
  let remaining = totalPips;
  for (const idx of sorted) {
    if (remaining <= 0) break;
    result[idx] = Math.min(1, remaining);
    remaining -= result[idx];
  }
  if (remaining > 0) {
    let activeIndices = sorted.filter(i => result[i] < shieldSlots[i].max);
    while (remaining > 0.001 && activeIndices.length > 0) {
      const share = remaining / activeIndices.length;
      const newActive = [];
      for (const idx of activeIndices) {
        const add = Math.min(share, shieldSlots[idx].max - result[idx]);
        result[idx] += add;
        remaining -= add;
        if (result[idx] < shieldSlots[idx].max) newActive.push(idx);
      }
      activeIndices = newActive;
    }
  }
  return result;
}

export function calculateCoolingStats(channels, loadout, slots) {
  let coolingSupply = 0;

  // --- Supply: sum cooler output with pip-scaled modifier ---
  const coolerSlots = (slots.systems || []).filter(s => s.category === 'Coolers');
  for (let i = 0; i < coolerSlots.length; i++) {
    const portName = coolerSlots[i].portName;
    const cn = loadout[portName];
    if (!cn) continue;
    // Crafted stats so the Coolant Rating modifier flows into UnitPerSec.
    const si = getCraftedItemStats(cn, portName);
    if (!si?.ResourceNetwork) continue;
    const rn = si.ResourceNetwork[0];
    const conv = rn?.Conversion?.find(c => c.Generation?.Resource === 'Coolant');
    if (!conv) continue;
    const baseOutput = conv.Generation.UnitPerSec || 0;
    const ch = channels.find(c => c.key === `cooler_${i}`);
    const allocatedPips = ch?.allocated || 0;
    const maxPips = ch?.max || 1;
    const pr = rn.PowerRanges;
    const modifier = getPowerRangeModifierAll(pr, allocatedPips);
    const pipFraction = maxPips > 0 ? allocatedPips / maxPips : 0;
    coolingSupply += baseOutput * modifier * pipFraction;
  }

  // --- Demand ---
  // Term 1: power consumption heat = sum of allocated pips for NON-cooler
  // channels. Cooler pips are tracked via their PowerRanges curve in
  // operationalHeat below (the heat the unit emits while running) - counting
  // both their pip cost AND that operational output would double-count. For
  // shields, only powered shields actually draw from the PP, so we cap at
  // poweredMax.
  let powerHeat = 0;
  for (const ch of channels) {
    if (ch.key.startsWith('cooler_')) continue;
    if (ch.key === 'shields' && ch.poweredMax != null) {
      powerHeat += Math.min(ch.allocated, ch.poweredMax);
    } else {
      powerHeat += ch.allocated || 0;
    }
  }

  // Term 2: operational heat per component with PowerRanges, INCLUDING coolers.
  // Verified against Erkul + SPViewer on Asgard (Cirrus×2, FullStop×4, IceBox)
  // across 8 pip configurations: each component contributes its own
  // `segment × mod × pipFrac` heat, regardless of whether it generates or
  // consumes coolant.
  let operationalHeat = 0;
  for (const ch of channels) {
    if (!ch.allocated) continue;

    if (ch.key === 'shields' && ch.shieldSlots) {
      // Cooling demand uses the same top-2 powered distribution as EM:
      // unpowered shield generators don't run, so they contribute 0 heat.
      const pipsPerShield = distributeShieldPipsTop2(ch.shieldSlots, ch.allocated);
      for (let si = 0; si < ch.shieldSlots.length; si++) {
        const shield = ch.shieldSlots[si];
        const shieldPips = pipsPerShield[si];
        if (shield.max <= 0 || shieldPips <= 0) continue;
        if (shield.powerRanges) {
          const mod = getPowerRangeModifier(shield.powerRanges, shieldPips);
          operationalHeat += shield.max * mod * (shieldPips / shield.max);
        }
      }
    } else if (ch.powerRanges && ch.powerSegment && ch.max > 0) {
      const mod = getPowerRangeModifier(ch.powerRanges, ch.allocated);
      operationalHeat += ch.powerSegment * mod * (ch.allocated / ch.max);
    }
  }

  const coolingDemand = powerHeat + operationalHeat;

  const coolingPercent = coolingSupply > 0 ? (coolingDemand / coolingSupply) * 100 : (coolingDemand > 0 ? Infinity : 0);
  return {
    coolingSupply,
    coolingDemand,
    coolingPercent
  };
}

/**
 * Calculate pip-scaled EM signature.
 * EM = PP_EM × (totalPips / PP_seg) + Σ(component_EM × modifier × pipFrac)
 * Components with all RegisterRange=false (engine, weapons) have modifier=0.
 * PP scales with total allocated pips / PP segment.
 */
export function calculateEMSignature(channels, ppEM, ppSeg) {
  if (!channels || !ppSeg) return 0;

  // PP total pips: for shields, only powered shields' pips count for PP load
  let totalPips = 0;
  for (const ch of channels) {
    if (ch.key === 'shields' && ch.poweredMax != null) {
      // PP only powers the 2 selected shields - use their max seg as effective pips
      totalPips += Math.min(ch.allocated, ch.poweredMax);
    } else {
      totalPips += ch.allocated || 0;
    }
  }
  // PP contribution: scales linearly with total load
  let em = ppEM * (totalPips / ppSeg);

  // Component contributions
  for (const ch of channels) {
    if (!ch.allocated) continue;
    if (!ch.emNominal && !ch.shieldSlots) continue;

    if (ch.key === 'shields' && ch.shieldSlots) {
      // EM uses top-2 by segment: only the 2 largest shields contribute EM
      const pipsPerShield = distributeShieldPipsTop2(ch.shieldSlots, ch.allocated);
      for (let si = 0; si < ch.shieldSlots.length; si++) {
        const shield = ch.shieldSlots[si];
        const shieldPips = pipsPerShield[si];
        if (shield.max <= 0 || !shield.emNominal || shieldPips <= 0) continue;
        const mod = getPowerRangeModifier(shield.powerRanges, shieldPips);
        em += shield.emNominal * mod * (shieldPips / shield.max);
      }
    } else if (ch.key === 'weapons') {
      // Weapons: no PowerRanges, EM scales with allocated/needed fraction
      const wpnFrac = ch.needed > 0 ? Math.min(ch.allocated, ch.needed) / ch.needed : 0;
      em += ch.emNominal * wpnFrac;
    } else if (ch.key === 'interdiction' || ch.key === 'mining' || ch.key === 'salvage' || ch.key === 'quantumDrive') {
      // Binary on/off devices (EMP, QED, mining, salvage, QD) typically declare
      // PowerRanges with RegisterRange=false on every entry - the standard
      // mod-based formula would zero out their EM. Scale linearly with
      // allocated/max instead, which collapses to 0 (off) or full nominal (on)
      // for the truly binary QD case.
      em += ch.emNominal * (ch.allocated / ch.max);
    } else {
      const mod = getPowerRangeModifier(ch.powerRanges, ch.allocated);
      em += ch.emNominal * mod * (ch.allocated / ch.max);
    }
  }

  return em;
}

/**
 * Apply the ship's CrossSection signal multiplier to its static cross-section
 * values.
 *
 * Cross-section carries a signal multiplier exactly like IR and EM do
 * (`Armor.SignalMultipliers.CrossSection`), and it is a DIRECT factor, not a
 * `1 + x` delta: a 0.55 ship reads 55% of its base numbers. Confirmed in-game
 * 2026-07-31 on the Esperia Prowler, the only ship in the data whose CS
 * multiplier differs from both 1.0 and from its own IR/EM multipliers, so it
 * is the one loadout that discriminates all three candidate models.
 *
 * Unlike IR and EM this does NOT vary with pips - the base values are static
 * per ship, only the constant factor applies.
 *
 * Non-numeric axes pass through untouched: a few ground vehicles (Greycat
 * MDC / MTC) carry an Emissions.CrossSection block with no numbers in it, and
 * turning those into 0 would render as a real zero instead of the panel's
 * "no data" placeholder.
 *
 * @param {object|null} base - `Emissions.CrossSection` ({ Front, Side, Top }).
 * @param {number} [mult=1] - `Armor.SignalMultipliers.CrossSection`.
 * @returns {object|null} scaled copy, or null when the ship has no block.
 */
export function scaleCrossSection(base, mult = 1) {
  if (!base) return null;
  const k = (typeof mult === 'number' && Number.isFinite(mult)) ? mult : 1;
  const scale = (v) => (typeof v === 'number' ? v * k : v);
  return { ...base, Front: scale(base.Front), Side: scale(base.Side), Top: scale(base.Top) };
}

/**
 * Capacitor "usage" curves map an input ratio to an afterburner drain
 * multiplier. The export ships the curve's record GUID as a bare string
 * rather than its points - unlike the sibling `Curves.AngVelocity`, which the
 * extractor already emits inline - so the two curves that flight blades
 * actually reference are mapped here by GUID.
 *
 * Values read from the game records under
 * `Data/Libs/Foundry/Records/capacitorassignment/`:
 *
 *   CapacitorAssignmentInputOutput_Always_1       (0,1) → (1,1)    → 1.0
 *   CapacitorAssignmentInputOutput_Linear_100_75  (0,1) → (1,0.75) → 0.75
 *
 * The multiplier used is the curve's output at full input, which is what
 * reproduces SPViewer (see `calculateBoostTime`). Unknown GUIDs fall back to
 * 1.0, the overwhelming majority case.
 *
 * Delete this map once the extractor resolves `Curves.Usage` to points the
 * way it already does for `Curves.AngVelocity`.
 */
const CAPACITOR_CURVES = new Map([
  // Afterburner drain (Curves.Usage) - lower output = slower drain
  ['822703ac-f458-433e-af38-352232852175', [1.0, 1.0]],   // Always_1      190 blades
  ['6bb5a702-af02-4b5e-b308-5c89d2268379', [1.0, 0.75]],  // Linear_100_75  35 blades
  // Capacitor recharge (Curves.Regen / RegenNavMode) - higher output = faster
  ['f381647d-1e21-4dd2-b63b-567f012deeda', [0.5, 1.0]],   // Linear_50_100 225 blades
  ['5c844120-12c9-49eb-b7dd-93db1fc43d00', [0.1, 0.2]],   // Linear_10_20 (NAV) 8
]);

/**
 * Evaluate a capacitor curve at a given power-assignment fraction.
 *
 * Every curve referenced by a flight blade is a straight line between its
 * two endpoints, so a lerp is exact - no spline evaluation needed. Unknown
 * GUIDs return `fallback` so a future curve degrades to the current
 * behaviour instead of producing nonsense.
 */
function capacitorCurveValue(guid, frac, fallback = 1) {
  const pts = CAPACITOR_CURVES.get(guid);
  if (!pts) return fallback;
  const f = Math.max(0, Math.min(1, frac ?? 1));
  return pts[0] + (pts[1] - pts[0]) * f;
}

/**
 * Boost endurance - seconds of continuous boost a full thruster capacitor
 * sustains.
 *
 *   boostTime = capacitorSize / (idleCost × usageModifier × usageCurveDrain)
 *
 * The curve input is the engine power assignment, so boost length moves with
 * engine pips on the 35 `Linear_100_75` blades and is flat on the other 190.
 * At full pips (`engFrac` 1) the figures below agree with SPViewer, which
 * only ever reports the full-pip case.
 *
 * Verified on Live 4.9.0.12326004. ✓ = agrees with SPViewer at full pips:
 *
 *   Anvil F7C Hornet Mk II    20 / 1.0  × 1.00  →   20.00 s  ✓
 *   Anvil Carrack             20 / 1.0  × 0.75  →   26.67 s  ✓
 *   Drake Buccaneer           25 / 1.0  × 0.75  →   33.33 s  ✓  measured ~33 s
 *   Aegis Sabre Peregrine     25 / 1.0  × 0.75  →   33.33 s  ✓
 *   Aegis Idris-P           1500 / 50   × 1.00  →   30.00 s  ✓
 *   Drake Cutlass Black     2800 / 20   × 1.00  →  140.00 s     measured 2m20s
 *
 * Three in-game stopwatch measurements pin the model down completely:
 *
 * - Buccaneer at FULL engine pips: ~33 s. Discriminates all three candidate
 *   models - rules out reading the `afterburnerNew` block (20 s) and rules
 *   out integrating the curve as the capacitor drains (25 × 4 × ln(4/3) =
 *   28.8 s). Do NOT switch to `afterburnerNew`.
 * - Buccaneer at ONE engine pip: ~25 s, exactly the curve's other endpoint
 *   (drain 1.0). This is what confirms the curve input is the engine power
 *   assignment rather than a constant.
 * - Cutlass Black: 2m20s = 140 s as computed. Confirms the legacy capacitor
 *   scale (2800 / 20) is genuinely live and that SPViewer's 18.48 s for that
 *   ship is wrong. Ours is the correct one.
 *
 * `LinearCost` (translation) and `AngularCost` (rotation) are deliberately
 * NOT applied. They need stick input to evaluate, and both the Idris-P and
 * the Cutlass Black carry them (1.0 / 0.2 and 1.0 / 0.1) yet match without.
 *
 * @param {object|null} cap - { size, idleCost, usageModifier, usageCurve }.
 * @param {number} [engFrac=1] - engine power-assignment fraction, 0-1.
 * @returns {number|null} seconds, or null when the ship declares no capacitor.
 */
export function calculateBoostTime(cap, engFrac = 1) {
  if (!cap || !(cap.size > 0)) return null;
  const drain = (cap.idleCost || 0)
    * (cap.usageModifier ?? 1)
    * capacitorCurveValue(cap.usageCurve, engFrac);
  if (!(drain > 0)) return null;
  return cap.size / drain;
}

/**
 * Capacitor recharge - seconds to refill a fully drained thruster capacitor.
 *
 *   regenTime = capacitorSize / (regenPerSec × regenCurve(engFrac))
 *
 * All 225 flight blades use `Linear_50_100` for SCM-mode regen, so recharge
 * runs at half rate with no engine power and full rate at full power. At
 * full engine pips this collapses to `Size / RegenPerSec`, which is exactly
 * the `RegenerationTime` the extractor emits and matches SPViewer on every
 * ship checked (Buccaneer 33.3 s, F7C Mk II 26.7 s, Cutlass Black 28 s).
 *
 * Both endpoints confirmed in-game on a Buccaneer: 33.3 s at full engine
 * pips, ~66 s at one pip against the computed 66.7 s.
 *
 * `RegenNavMode` is a separate, much slower curve (`Linear_10_20` on 8
 * blades) and is not modelled - the panel reports SCM figures throughout.
 *
 * Note this is the mirror of `calculateBoostTime`: more engine pips make the
 * capacitor both drain slower and refill faster.
 *
 * @param {object|null} cap - { size, regenPerSec, regenCurve }.
 * @param {number} [engFrac=1] - engine power-assignment fraction, 0-1.
 * @returns {number|null} seconds, or null when the ship declares no capacitor.
 */
export function calculateBoostRegenTime(cap, engFrac = 1) {
  if (!cap || !(cap.size > 0)) return null;
  const rate = (cap.regenPerSec || 0) * capacitorCurveValue(cap.regenCurve, engFrac);
  if (!(rate > 0)) return null;
  return cap.size / rate;
}

/**
 * Calculate aggregate ship stats from a loadout.
 *
 * @param {object} loadout - portName → className map.
 * @param {Set<string>} [disabledPorts] - ports the user powered off; treated as
 *   if the component were not equipped (no power output, EM, IR, etc.).
 */
export function calculateStats(loadout, disabledPorts) {
  const stats = {
    powerOutput: 0,
    powerDraw: 0,
    shieldHP: 0,
    shieldRegen: 0,
    cooling: 0,
    qdSpeed: 0,
    qdSpool: 0,
    emSignature: 0,
    irSignature: 0,
    ppEM: 0,
    ppSeg: 0,
    shieldResPhysMin: 0,
    shieldResPhysMax: 0,
    shieldResEnergyMin: 0,
    shieldResEnergyMax: 0,
    shieldResDistMin: 0,
    shieldResDistMax: 0,
    shieldCount: 0
  };

  // Collect power plant data first for non-linear multi-PP calculation
  const powerPlants = [];

  for (const [portName, className] of Object.entries(loadout)) {
    if (disabledPorts && disabledPorts.has(portName)) continue;
    const si = getCraftedItemStats(className, portName);
    if (!si) continue;

    const rn = si.ResourceNetwork;
    if (Array.isArray(rn)) {
      // Per-item EM/IR is the MAX across ResourceNetwork nodes, not the sum.
      // QDs ship with two nodes per item carrying identical EM nominals (one
      // per operational mode); only one mode runs at a time. Single-node
      // items collapse to their own value either way.
      let itemEM = 0, itemIR = 0;
      for (const node of rn) {
        // Collect power plants (processed after the loop)
        if (node.Generation) {
          for (const gen of node.Generation) {
            if (gen.Resource === 'Power') {
              const ppEM = node.Signatures?.Electromagnetic?.Nominal || 0;
              powerPlants.push({ segment: gen.Segment || 0, size: si.Size || 0, em: ppEM });
            }
          }
        }
        // Conversion (shields, coolers)
        if (node.Conversion) {
          for (const conv of node.Conversion) {
            if (conv.Generation?.Resource === 'Shield') {
              stats.shieldRegen += conv.Generation.UnitPerSec || 0;
            }
            if (conv.Generation?.Resource === 'Coolant') {
              stats.cooling += conv.Generation.UnitPerSec || 0;
            }
            if (conv.Consumption?.Resource === 'Power') {
              stats.powerDraw += conv.Consumption.Segment || 0;
            }
          }
        }
        // Consumption
        if (node.Consumption) {
          for (const cons of node.Consumption) {
            if (cons.Resource === 'Power') stats.powerDraw += cons.UnitPerSec || cons.Segment || 0;
          }
        }
        // Track max signature across this item's nodes
        if (node.Signatures) {
          const emN = node.Signatures.Electromagnetic?.Nominal || 0;
          const irN = node.Signatures.Infrared?.Nominal || 0;
          if (emN > itemEM) itemEM = emN;
          if (irN > itemIR) itemIR = irN;
        }
      }
      stats.emSignature += itemEM;
      stats.irSignature += itemIR;
    }

    // Shield HP and resistances
    if (si.Shield) {
      stats.shieldHP += si.Shield.Health || 0;
      const res = si.Shield.Resistance || {};
      stats.shieldResPhysMin += (res.Physical?.Minimum || 0);
      stats.shieldResPhysMax += (res.Physical?.Maximum || 0);
      stats.shieldResEnergyMin += (res.Energy?.Minimum || 0);
      stats.shieldResEnergyMax += (res.Energy?.Maximum || 0);
      stats.shieldResDistMin += (res.Distortion?.Minimum || 0);
      stats.shieldResDistMax += (res.Distortion?.Maximum || 0);
      stats.shieldCount++;
    }

    // Quantum Drive
    if (si.QuantumDrive) {
      const qd = si.QuantumDrive.StandardJump || {};
      stats.qdSpeed = qd.Speed || 0;
      stats.qdSpool = qd.SpoolUpTime || 0;
    }
  }

  // Average shield resistances across all equipped shields (store as fractions)
  if (stats.shieldCount > 0) {
    const n = stats.shieldCount;
    stats.shieldResPhysMin /= n;
    stats.shieldResPhysMax /= n;
    stats.shieldResEnergyMin /= n;
    stats.shieldResEnergyMax /= n;
    stats.shieldResDistMin /= n;
    stats.shieldResDistMax /= n;
  }

  // Non-linear power plant output:
  // totalPips = sum(round(segment_i / numPPs)) + (numPPs - 1) * sum(size_i)
  const numPPs = powerPlants.length;
  if (numPPs > 0) {
    const totalSize = powerPlants.reduce((sum, pp) => sum + pp.size, 0);
    const baseSegments = powerPlants.reduce(
      (sum, pp) => sum + Math.round(pp.segment / numPPs), 0
    );
    stats.powerOutput = baseSegments + (numPPs - 1) * totalSize;
    stats.ppEM = powerPlants.reduce((sum, pp) => sum + pp.em, 0);
    stats.ppSeg = stats.powerOutput; // PP segment = power output (for EM scaling)
  }

  return stats;
}
