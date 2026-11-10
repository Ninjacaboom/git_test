/**
 * Tests for the pure helpers in dataLoader - the roster filters that decide
 * which hulls the rest of the app ever sees.
 */
import { describe, it, expect } from 'vitest';
import { findSupersededByGoldStandard } from '../js/dataLoader.js';

// ─── Gold Standard hulls replace their pre-rework twin ───
// `_GS` is CIG's reworked build of a ship, the one players own. It used to be
// treated as a cosmetic skin and hidden, which left the app showing the old
// hull's stats and loadout.
describe('findSupersededByGoldStandard', () => {
  const hulls = (...names) => names.map(ClassName => ({ ClassName }));
  const superseded = (...names) => [...findSupersededByGoldStandard(hulls(...names))].sort();

  it('drops the old hull when a Gold Standard twin exists', () => {
    expect(superseded('TEST_Ship', 'TEST_Ship_GS', 'TEST_Other')).toEqual(['TEST_Ship']);
  });

  it('pairs suffixed variants through the _GS token', () => {
    expect(superseded('TEST_Ship_Military', 'TEST_Ship_GS_Military')).toEqual(['TEST_Ship_Military']);
  });

  it('replaces nothing when the Gold Standard hull has no old twin', () => {
    expect(superseded('TEST_Aurora_GS_LX', 'TEST_Ship_GS_Display')).toEqual([]);
  });

  it('never marks the Gold Standard hull itself', () => {
    expect(superseded('TEST_Ship', 'TEST_Ship_GS')).not.toContain('TEST_Ship_GS');
  });

  it('ignores names that merely contain the letters GS', () => {
    expect(superseded('TEST_GSX', 'TEST_GSX_Mk2', 'TEST_BIGSHIP')).toEqual([]);
  });

  it('tolerates missing or malformed input', () => {
    expect(superseded()).toEqual([]);
    expect([...findSupersededByGoldStandard(null)]).toEqual([]);
    expect([...findSupersededByGoldStandard([null, {}, { ClassName: 'TEST_Ship_GS' }])]).toEqual([]);
  });
});
