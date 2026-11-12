import type { StatEffect } from './api';

/** "Char_Armor_Torso" -> "Armor Torso", "WeaponGun" -> "Weapon Gun". */
export function prettyType(type: string): string {
  if (!type) return 'Other';
  return type
    .replace(/^Char_/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

const trim = (n: number) => Number(n.toFixed(2)).toString();

/**
 * Ore amounts are stored in SCU but shown in cSCU (1 SCU = 100 cSCU), e.g. 0.05 SCU -> "5 cSCU".
 * Harvested items are counted in Units and shown as they are.
 */
export function formatAmount(quantity: number, unitType: string): string {
  if (unitType === 'SCU') return `${trim(quantity * 100)} cSCU`;
  return `${trim(quantity)} ${unitType}`;
}

/** Multipliers show as a percentage change (1.1 -> +10%), additive values as a signed number. */
export function formatEffect(effect: StatEffect): { text: string; direction: 'up' | 'down' | 'none' } {
  if (effect.kind === 'additive') {
    const v = effect.value;
    if (v === 0) return { text: '0', direction: 'none' };
    return { text: `${v > 0 ? '+' : ''}${Number(v.toFixed(2))}`, direction: v > 0 ? 'up' : 'down' };
  }
  const pct = (effect.value - 1) * 100;
  if (Math.abs(pct) < 0.05) return { text: '0%', direction: 'none' };
  return { text: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`, direction: pct > 0 ? 'up' : 'down' };
}

/**
 * The item's own stats, taken from the top of its description ("Item Type: Cooler", "Size: 2", ...).
 * The story text underneath is left out.
 */
export function parseItemStats(description: string | null | undefined): { label: string; value: string }[] {
  if (!description) return [];
  const out: { label: string; value: string }[] = [];
  for (const raw of description.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      if (out.length > 0) break; // end of the stats block
      continue;
    }
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    if (!m) break;
    out.push({ label: m[1].trim(), value: m[2].trim() });
  }
  return out;
}
