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
    if (line === '') continue; // stat lines can be split into groups by blank lines
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    if (!m) break;
    out.push({ label: m[1].trim(), value: m[2].trim() });
  }
  return out;
}

/**
 * Which item stat each quality effect changes: the label in the item's stat list, and which number
 * in that value it applies to ("Temp. Rating: -75 / 105 °C" holds two: min first, then max).
 */
const EFFECT_TARGETS: Record<string, { label: string; index: number }[]> = {
  'Damage Mitigation': [{ label: 'Damage Reduction', index: 0 }],
  'Impact Force': [{ label: 'Damage', index: 0 }],
  'Fire Rate': [
    { label: 'Rate Of Fire', index: 0 },
    { label: 'Rate of Fire', index: 0 },
  ],
  'Min Temp': [{ label: 'Temp. Rating', index: 0 }],
  'Max Temp': [{ label: 'Temp. Rating', index: 1 }],
  'Radiation Dissipation': [{ label: 'Radiation Scrub Rate', index: 0 }],
  Integrity: [{ label: 'Max. Integrity', index: 0 }],
  'Full Strength Dist.': [{ label: 'Full Strength Distance', index: 0 }],
  'Max. Distance': [{ label: 'Max Range', index: 0 }],
  Radius: [{ label: 'Radius', index: 0 }],
  Speed: [{ label: 'Extraction Speed', index: 0 }],
  Efficiency: [{ label: 'Extraction Efficiency', index: 0 }],
};

export type ItemStatRow = { label: string; value: string; base: string; modified: boolean };

/** Item stats with the quality effects worked into the numbers. Changed values are flagged. */
export function applyQualityToStats(
  stats: { label: string; value: string }[],
  effects: Record<string, StatEffect> | null,
): ItemStatRow[] {
  return stats.map(({ label, value }) => {
    let text = value;
    let modified = false;
    for (const [stat, targets] of Object.entries(EFFECT_TARGETS)) {
      const effect = effects?.[stat];
      if (!effect) continue;
      for (const t of targets) {
        if (t.label !== label) continue;
        let n = -1;
        text = text.replace(/-?\d+(?:\.\d+)?/g, (num) => {
          n++;
          if (n !== t.index) return num;
          const base = Number(num);
          const next = effect.kind === 'additive' ? base + effect.value : base * effect.value;
          if (Math.abs(next - base) < 0.005) return num;
          modified = true;
          return String(Number(next.toFixed(2)));
        });
      }
    }
    return { label, value: text, base: value, modified };
  });
}

/** Stats where the game's multiplier goes down as quality goes up, but a higher number is the better result. */
const FLIPPED_STATS = new Set(['Recoil Smoothness', 'Recoil Handling']);

/** The effect as it is shown: for flipped stats a 20% lower multiplier is shown as +20%. */
export function displayEffect(stat: string, effect: StatEffect): StatEffect {
  if (FLIPPED_STATS.has(stat) && effect.kind === 'multiplier') {
    return { kind: 'multiplier', value: 2 - effect.value };
  }
  return effect;
}
