/**
 * Crafting summary - pure logic. Aggregates blueprint material costs across
 * the currently-equipped loadout so the user can see "what would it cost to
 * craft my custom components?"
 *
 * Filter rule: list every equipped component that HAS a blueprint (= craftable).
 * Non-craftable components (e.g. Dominator II) are skipped entirely. Each row
 * carries a `defaultIncluded` flag - true when the user customized the slot
 * (swapped from default OR set non-default quality), false when the slot is
 * still the stock default. The UI uses that flag as the initial checkbox
 * state; users can toggle individual rows to refine the shopping list.
 */

import { getBlueprint, getItemStats } from './loadoutManager.js';

/**
 * Item.Type prefixes the summary treats as structural / passthrough - these
 * are containers that hold other consumable components rather than items the
 * user crafts directly. Skipping them keeps the modal focused on the loadout
 * entries the user actually sees in the main slot view (weapons, missiles,
 * shields, PPs, coolers, etc.) instead of inflating the list with every
 * gimbal mount + turret base + missile rack frame.
 */
const STRUCTURAL_TYPE_RE = /^(Turret|TurretBase|WeaponAttachment|ToolArm|MissileLauncher)\b/;

/** Returns false for gimbal mounts, turret bases, missile racks, etc. */
function isConsumableItem(stdItem) {
  const type = stdItem?.Type || '';
  if (!type) return true; // unknown - keep, better visible than silently dropped
  return !STRUCTURAL_TYPE_RE.test(type);
}

/**
 * Sum every Resource cost across a blueprint's Tier[0] slots, grouped by GUID.
 * Item-typed costs are skipped (current game data has none, and user feature
 * spec calls only for raw materials).
 */
export function aggregateBlueprintCosts(bp) {
  const costs = new Map();
  const tier = bp?.Tiers?.[0];
  if (!tier) return costs;
  for (const slot of (tier.Slots || [])) {
    for (const cost of (slot.Costs || [])) {
      if (cost.Type !== 'Resource') continue;
      if (!cost.GUID) continue;
      const qty = cost.Quantity || 0;
      costs.set(cost.GUID, (costs.get(cost.GUID) || 0) + qty);
    }
  }
  return costs;
}

/**
 * Walk the slot tree and return port → { defaultClassName, category, sortOrder }.
 * Sort order is the appearance order across categories - keeps the summary
 * list in the same visual order as the main loadout view.
 */
function buildPortIndex(slots) {
  const index = new Map();
  let order = 0;
  function visit(slot, category) {
    if (slot.portName) {
      index.set(slot.portName, {
        defaultClassName: slot.baseLoadout?.ClassName || null,
        category,
        sortOrder: order++,
      });
    }
    for (const sub of slot.ports || []) visit(sub, category);
  }
  for (const [category, items] of Object.entries(slots || {})) {
    if (!Array.isArray(items)) continue;
    for (const item of items) visit(item, category);
  }
  return index;
}

/**
 * @param {object} loadout - port → className
 * @param {object} slots - extractSlots() output
 * @param {object} crafting - port → { slotName: quality } map (state.currentCrafting)
 * @returns {Array<{
 *   className: string,
 *   name: string,
 *   count: number,
 *   defaultIncluded: boolean,
 *   category: string,
 *   costs: Map<string, number>,
 *   sortOrder: number
 * }>}
 *
 * Includes only equipped components that BOTH have a blueprint (= craftable)
 * AND are consumable (not gimbal mounts / turret bases / missile rack frames /
 * tool arms). Items without a blueprint - missiles, ship-bespoke weapons,
 * and similar - are dropped entirely so the list stays actionable.
 */
export function buildSummary(loadout, slots, crafting) {
  if (!loadout || !slots) return [];
  const portIndex = buildPortIndex(slots);
  const crafts = crafting || {};

  // Group port entries by className. For each group: count instances, decide
  // defaultIncluded (true = user customized this somewhere → checkbox checked
  // by default; false = entirely stock → unchecked).
  const groups = new Map();

  for (const [port, cn] of Object.entries(loadout)) {
    if (!cn) continue;
    const stdItem = getItemStats(cn);
    if (!isConsumableItem(stdItem)) continue; // skip mounts/gimbals/racks
    const bp = getBlueprint(cn);
    if (!bp) continue; // skip non-craftable (no blueprint in data)

    const idx = portIndex.get(port);
    const defaultCn = idx?.defaultClassName ?? null;
    const portCustom = crafts[port] && Object.keys(crafts[port]).length > 0;
    // "Customized" = swapped from stock OR has non-default crafting quality.
    const isCustomized = (cn !== defaultCn) || portCustom;

    if (!groups.has(cn)) {
      groups.set(cn, {
        className: cn,
        name: stdItem?.Name || cn,
        count: 0,
        anyCustomized: false,
        category: idx?.category || 'other',
        sortOrder: idx?.sortOrder ?? Infinity,
        unitCosts: aggregateBlueprintCosts(bp),
      });
    }
    const g = groups.get(cn);
    g.count += 1;
    if (isCustomized) g.anyCustomized = true;
    // Pick the lowest sortOrder across all ports holding this className so the
    // group lands in roughly the right place even if some ports come later.
    if (idx && idx.sortOrder < g.sortOrder) {
      g.sortOrder = idx.sortOrder;
      g.category = idx.category;
    }
  }

  const result = [];
  for (const g of groups.values()) {
    const costs = new Map();
    for (const [guid, qty] of g.unitCosts) {
      costs.set(guid, qty * g.count);
    }
    result.push({
      className: g.className,
      name: g.name,
      count: g.count,
      defaultIncluded: g.anyCustomized, // checkbox initial state
      category: g.category,
      costs,
      sortOrder: g.sortOrder,
    });
  }

  result.sort((a, b) => a.sortOrder - b.sortOrder);
  return result;
}

/**
 * Sum included rows' costs into a single resource → quantity map.
 * @param {Array} items result from buildSummary
 * @param {Set<string>} includedClassNames classNames whose checkbox is checked
 */
export function aggregateTotals(items, includedClassNames) {
  const totals = new Map();
  for (const item of items) {
    if (!includedClassNames.has(item.className)) continue;
    for (const [guid, qty] of item.costs) {
      totals.set(guid, (totals.get(guid) || 0) + qty);
    }
  }
  return totals;
}
