/**
 * Tests for the crafting-state mutations on loadoutState.js - the
 * setters that the popover writes through and the tab/share-URL
 * persistence layers read back.
 *
 * Backwards-compat is covered implicitly: the craftStdItem identity
 * fast-path in craftingModifiers.test.js proves that empty crafting
 * state == no behaviour change, so legacy tabs/share URLs (without
 * a crafting field) load with byte-identical results.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as state from '../js/loadoutState.js';

describe('currentCrafting state', () => {
  beforeEach(() => {
    state.setCurrentCrafting({});
  });

  it('setPortCrafting stores a per-port slot map', () => {
    state.setPortCrafting('port_a', { SHELL: 750, 'FIELD ARRAY': 1000 });
    expect(state.currentCrafting.port_a).toEqual({ SHELL: 750, 'FIELD ARRAY': 1000 });
  });

  it('setPortCrafting with an empty map deletes the port entry', () => {
    // Mimics commitPortQualityMap dropping default-only state to keep
    // the crafting payload minimal across tabs / share URLs.
    state.setPortCrafting('port_a', { SHELL: 750 });
    state.setPortCrafting('port_a', {});
    expect(state.currentCrafting.port_a).toBeUndefined();
  });

  it('clearPortCrafting removes only the named port', () => {
    state.setPortCrafting('port_a', { SHELL: 750 });
    state.setPortCrafting('port_b', { COOLANT: 800 });
    state.clearPortCrafting('port_a');
    expect(state.currentCrafting.port_a).toBeUndefined();
    expect(state.currentCrafting.port_b).toEqual({ COOLANT: 800 });
  });

  it('clearPortCrafting on a missing port is a no-op', () => {
    state.setPortCrafting('port_a', { SHELL: 750 });
    state.clearPortCrafting('port_does_not_exist');
    expect(state.currentCrafting.port_a).toEqual({ SHELL: 750 });
  });

  it('setCurrentCrafting replaces the whole map (wipes any prior state)', () => {
    state.setPortCrafting('port_a', { SHELL: 750 });
    state.setCurrentCrafting({ port_x: { GADGET: 250 } });
    expect(state.currentCrafting.port_a).toBeUndefined();
    expect(state.currentCrafting.port_x).toEqual({ GADGET: 250 });
  });

  it('setCurrentCrafting with null / non-object resets to empty', () => {
    // Backwards-compat for legacy tabs / shared builds: missing crafting
    // field is fed through as null/undefined → empty map → identity.
    state.setPortCrafting('port_a', { SHELL: 750 });
    state.setCurrentCrafting(null);
    expect(Object.keys(state.currentCrafting).length).toBe(0);
    state.setPortCrafting('port_a', { SHELL: 750 });
    state.setCurrentCrafting(undefined);
    expect(Object.keys(state.currentCrafting).length).toBe(0);
    state.setPortCrafting('port_a', { SHELL: 750 });
    state.setCurrentCrafting('not an object');
    expect(Object.keys(state.currentCrafting).length).toBe(0);
  });
});
