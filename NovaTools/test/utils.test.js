/**
 * Tests for utils.js pure helper: compareGameVersions.
 *
 * Focus areas:
 *  1. Numeric ordering per part (the 4.10 vs 4.9 case that hid the PTU build)
 *  2. Legacy `sc-live-X.Y.Z` prefix handling
 *  3. Degenerate input: missing parts, empty/null, non-numeric parts
 */

import { describe, it, expect } from 'vitest';
import { compareGameVersions } from '../js/utils.js';

describe('compareGameVersions', () => {
  // ─── Numeric ordering ──────────────────────────────────────────────────────

  it('orders a double-digit minor above a single-digit one', () => {
    // Regression: `'4.10.0.12368639' > '4.9.0.12344265'` is false as strings,
    // so the PTU toggle rendered disabled on the first 4.10 PTU drop.
    expect(compareGameVersions('4.10.0.12368639', '4.9.0.12344265')).toBe(1);
    expect(compareGameVersions('4.9.0.12344265', '4.10.0.12368639')).toBe(-1);
  });

  it('returns 0 for identical versions', () => {
    expect(compareGameVersions('4.9.0.12344265', '4.9.0.12344265')).toBe(0);
  });

  it('breaks ties on the p4 change number', () => {
    expect(compareGameVersions('4.9.0.12344266', '4.9.0.12344265')).toBe(1);
  });

  it('compares major before minor', () => {
    expect(compareGameVersions('5.0.0.1', '4.99.0.999999')).toBe(1);
  });

  // ─── Legacy prefixes ───────────────────────────────────────────────────────

  it('strips the legacy sc-<channel>- prefix before comparing', () => {
    expect(compareGameVersions('sc-ptu-4.10.0', 'sc-live-4.9.0')).toBe(1);
    expect(compareGameVersions('sc-alpha-4.9.0', '4.9.0')).toBe(0);
  });

  // ─── Degenerate input ──────────────────────────────────────────────────────

  it('treats missing trailing parts as zero', () => {
    expect(compareGameVersions('4.9', '4.9.0.0')).toBe(0);
    expect(compareGameVersions('4.9.1', '4.9')).toBe(1);
  });

  it('sorts empty and non-numeric input oldest instead of throwing', () => {
    expect(compareGameVersions('', '4.9.0')).toBe(-1);
    expect(compareGameVersions(null, undefined)).toBe(0);
    expect(compareGameVersions('not-a-version', '0.0.1')).toBe(-1);
  });
});
