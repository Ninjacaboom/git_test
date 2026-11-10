/**
 * Tests for buildManager.js pure logic - shared-build payload sanitization.
 * (The DOM-heavy parts of buildManager are exercised in-browser.)
 */

import { describe, it, expect } from 'vitest';
import { sanitizeSharedBuild } from '../js/buildManager.js';

describe('sanitizeSharedBuild', () => {
  it('returns null for non-object payloads', () => {
    expect(sanitizeSharedBuild(null)).toBeNull();
    expect(sanitizeSharedBuild('x')).toBeNull();
    expect(sanitizeSharedBuild([1, 2])).toBeNull();
  });

  it('keeps well-formed fields', () => {
    const out = sanitizeSharedBuild({
      l: { hp1: 'WPN_A', hp2: null },
      s: [0, 2],
      d: ['hp1'],
      c: { hp1: { SHELL: 750 } },
      p: { weapons: 4 },
    });
    expect(out.l).toEqual({ hp1: 'WPN_A', hp2: null });
    expect(out.s).toEqual([0, 2]);
    expect(out.d).toEqual(['hp1']);
    expect(out.c).toEqual({ hp1: { SHELL: 750 } });
    expect(out.p).toEqual({ weapons: 4 });
  });

  it('drops __proto__/constructor keys so Object.assign cannot rewire prototypes', () => {
    // JSON.parse creates "__proto__" as an OWN property - exactly what a
    // crafted share payload would contain.
    const payload = JSON.parse('{"l": {"__proto__": "x", "constructor": "y", "hp1": "WPN_A"}}');
    const out = sanitizeSharedBuild(payload);
    expect(Object.keys(out.l)).toEqual(['hp1']);
    const target = {};
    Object.assign(target, out.l);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
  });

  it('drops values of the wrong type in every field', () => {
    const out = sanitizeSharedBuild({
      l: { hp1: 42, hp2: { nested: true }, hp3: 'ok' },
      s: 'not-an-array',
      d: ['ok', 7, null],
      c: { hp1: 'not-an-object', hp2: { SHELL: 'NaN-string', OK: 500 } },
      p: { weapons: 'four', shields: Infinity, engines: 2 },
    });
    expect(out.l).toEqual({ hp3: 'ok' });
    expect(out.s).toBeNull();
    expect(out.d).toEqual(['ok']);
    expect(out.c).toEqual({ hp2: { OK: 500 } });
    expect(out.p).toEqual({ engines: 2 });
  });

  it('normalizes missing fields to safe empties', () => {
    const out = sanitizeSharedBuild({});
    expect(out).toEqual({ l: {}, s: null, d: [], c: {}, p: {} });
  });
});
