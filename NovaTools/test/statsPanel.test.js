/**
 * Tests for statsPanel.js pure helpers.
 *
 * Focus: humanizeVitalPartName normalization pipeline.
 *
 * The raw VitalParts keys come from the ship model asset pipeline and are
 * inconsistent across ships. The humanizer strips asset-engine prefixes
 * (geo_, dmg_, mesh_, aegs_, M_), strips cosmetic suffixes (_geo, _mesh,
 * _main, _exterior), extracts trailing directional markers as parenthesized
 * qualifiers, and Title Cases the remainder.
 *
 * Test cases cover all 27 unique keys observed across the 200+ ships in
 * the current SPViewer data snapshot, plus defensive edge cases.
 */

import { describe, it, expect } from 'vitest';

// statsPanel.js -> loadoutState.js reads localStorage at module init.
// Stub it before the import so the module graph loads in the node
// environment without a ReferenceError.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}

const { humanizeVitalPartName } = await import('../js/statsPanel.js');

describe('humanizeVitalPartName', () => {
  describe('clean single-word keys pass through Title Cased', () => {
    it.each([
      ['Body', 'Body'],
      ['Nose', 'Nose'],
      ['Tail', 'Tail'],
      ['Front', 'Front'],
      ['Rear', 'Rear'],
      ['Bridge', 'Bridge'],
      ['middle', 'Middle'],
      ['neck', 'Neck'],
      ['body', 'Body'],
      ['nose', 'Nose'],
      ['tail', 'Tail'],
    ])('%s -> %s', (input, expected) => {
      expect(humanizeVitalPartName(input)).toBe(expected);
    });
  });

  describe('strips asset-engine prefixes', () => {
    it('strips geo_ prefix (Apollo, Paladin, UTV, Guardian)', () => {
      expect(humanizeVitalPartName('geo_body')).toBe('Body');
    });

    it('strips geo_ prefix with multi-word suffix (Perseus)', () => {
      expect(humanizeVitalPartName('geo_main_wings')).toBe('Main Wings');
    });

    it('strips M_ modifier prefix (Polaris)', () => {
      expect(humanizeVitalPartName('M_Body')).toBe('Body');
    });

    it('strips aegs_ manufacturer prefix (Argo MPUV Personnel)', () => {
      expect(humanizeVitalPartName('aegs_escape_pod_exterior')).toBe('Escape Pod');
    });

    it('prefers longer alternation match - mesh_body not M_esh_body', () => {
      expect(humanizeVitalPartName('mesh_body')).toBe('Body');
    });
  });

  describe('strips cosmetic trailing suffixes', () => {
    it('strips _main (Mantis, Meteor)', () => {
      expect(humanizeVitalPartName('body_main')).toBe('Body');
    });

    it('strips _mesh (Tumbril Nova)', () => {
      expect(humanizeVitalPartName('body_mesh')).toBe('Body');
    });

    it('strips _geo (MISC Hull A)', () => {
      expect(humanizeVitalPartName('tail_geo')).toBe('Tail');
    });

    it('strips _exterior (Argo MPUV Cargo)', () => {
      expect(humanizeVitalPartName('Cargo_Container_Exterior')).toBe('Cargo Container');
    });

    it('strips _main to reveal rollcage (ROC, ROC-DS)', () => {
      expect(humanizeVitalPartName('rollcage_main')).toBe('Rollcage');
    });
  });

  describe('extracts directional markers as parenthesized qualifiers', () => {
    it('front -> (Front) (Aopoa Nox)', () => {
      expect(humanizeVitalPartName('body_front')).toBe('Body (Front)');
    });

    it('back -> (Rear) (Aopoa Nox)', () => {
      expect(humanizeVitalPartName('body_back')).toBe('Body (Rear)');
    });

    it('front on hull_ keeps hull and adds qualifier (Razor series)', () => {
      expect(humanizeVitalPartName('hull_front')).toBe('Hull (Front)');
    });

    it('rear on hull_ keeps hull and adds qualifier (Razor series)', () => {
      expect(humanizeVitalPartName('hull_rear')).toBe('Hull (Rear)');
    });

    it('left on multi-word base (Spirit A1/C1)', () => {
      expect(humanizeVitalPartName('wing_base_left')).toBe('Wing Base (Left)');
    });

    it('right on multi-word base (Spirit A1/C1)', () => {
      expect(humanizeVitalPartName('wing_base_right')).toBe('Wing Base (Right)');
    });

    it('capitalized Body_Front (Origin 890 Jump)', () => {
      expect(humanizeVitalPartName('Body_Front')).toBe('Body (Front)');
    });
  });

  describe('defensive edge cases', () => {
    it('returns raw key for null / undefined', () => {
      expect(humanizeVitalPartName(null)).toBe(null);
      expect(humanizeVitalPartName(undefined)).toBe(undefined);
    });

    it('returns raw key for non-string input', () => {
      expect(humanizeVitalPartName(42)).toBe(42);
    });

    it('returns raw key for empty string', () => {
      expect(humanizeVitalPartName('')).toBe('');
    });

    it('falls back to raw key if pipeline strips everything', () => {
      // If every token matched a stripper, return the original
      expect(humanizeVitalPartName('geo_')).toBe('geo_');
    });
  });
});
