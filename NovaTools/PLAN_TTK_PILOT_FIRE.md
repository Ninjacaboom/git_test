# Plan: Realistic Pilot Fire Policy for TTK

Branch: `feature/time-to-kill` (continuation)
Status: Draft (next: `/plan-eng-review`)

The current TTK simulator (Phase 1-2 of `PLAN_TIME_TO_KILL.md`) assumes every
weapon group fires at its own max cadence independently. That gives "ideal TTK"
- a floor, not a realistic number. Real SC pilots synchronize fire and pause to
prevent enemy shield regen.

This plan replaces ideal-mode with a synchronized-fire model plus a
**fire-policy toggle** that lets the user choose between conserving distortion
ammo (optimal) and dumping everything from the opening salvo.

Logic lives in [`js/ttkCalc.js`](js/ttkCalc.js) (sim) +
[`js/ttkCalcUI.js`](js/ttkCalcUI.js) (slider + footnote update).

---

## Why

Two pilot behaviors are unmodeled today:

1. **Synchronized pause after shortest-CF weapon empties.** Pilot stops firing
   everything for 2-4 s, just long enough to prevent enemy shield regen from
   starting (governed by `Shield.DamagedDelay`). NOT a full-recharge wait.
2. **Distortion-saving during shield-up (optimal play).** Distortion has
   `abs.dist = 1.0` on every 4.x shield - all distortion damage absorbed,
   zero leak. Firing distortion at a live shield wastes ammo. Skilled pilots
   hold distortion until the shield drops, then dump it into the powerplant
   pool. **Less optimal play:** fire everything from the start regardless.
   Both are valid; the user picks via a toggle.

The optimal rhythm is **two-phase: Mode A (Energy + Ballistic) while shield
up → Mode B (everything) once shield breaks.** The "fire all" alternative is
**Mode B from t=0.**

---

## What ships

- **Replace ideal-fire sim** with the two-mode realistic model below.
- **Add enemy shield regen** to the opponent profile (needed so the pause
  slider has meaning - otherwise long pauses are free).
- **Pause slider** in the dialog: 2 s to max-recharge across equipped weapons.
- **Fire-policy toggle** with two options:
  - **Optimal** (default): Mode A while shield up, auto-switch to Mode B at
    shield-break. Saves distortion ammo.
  - **Fire all**: Mode B from t=0. Distortion wasted on the shield, but no
    held trigger.
- **Remove the implicit "ideal mode"** - the new sim covers both realistic
  policies. One TTK number per outcome per policy.

Phasing keeps the largest pieces independently shippable.

---

## Fire model

### Mode A - shield is up (`op.shield.hp > 0`)

- **Active weapons:** every equipped weapon **except** those with
  `dmgByType.dist > 0`. Distortion is held back.
- **Cycle dictator:** the weapon with the **shortest continuous fire time**
  among active weapons.
  - For energy: `magazine / rpm * 60` until pool empty.
  - For ballistic with heat: `magazine / rpm * 60` until overheat.
  - For continuous-fire (no magazine constraint): excluded from the
    dictator pick - they never run dry.
- **During fire:** every active weapon fires at its own `shotInterval`
  cadence (groups still on independent clocks within the fire window).
- **Per-weapon physical state, continuously integrated:**
  - **Ballistic:** track `heat` per weapon. Each shot adds `HeatPerShot`.
    Between events: `heat -= CoolingPerSecond * max(0, dt - TimeTillCoolingStarts)`,
    clamped at `MinTemp`. Overheat fires when `heat >= OverheatTemp`.
  - **Energy:** track `pool` per weapon. Each shot subtracts the per-shot
    cost (`MaxAmmo` is treated as shot-equivalent, so cost = 1 unit). Between
    events: `pool += MaxRegenPerSec * dt`, clamped at `MaxAmmo`, with a
    `Cooldown` silent window after pool first hits 0 before regen starts.
  - **State persists across pauses.** Heat dissipates during the synced
    pause; energy regen accrues during the synced pause. A ballistic that
    fired 60% of its rounds in a 3 s pause-cycle resumes with partially
    cooled heat - meaningful, since cumulative heat over many cycles
    determines whether ballistic ever overheats independently of the
    dictator.
- **When dictator empties:** the entire active group pauses for `pauseLen`
  (slider value). Slower-cycling weapons cut their fire short - they did NOT
  empty their own magazine. Their heat / pool state at the moment of pause is
  preserved and resumed after.
- **After pause:** all active weapons reset `nextFire = t + shotInterval`.
  Their per-weapon physical state (heat, pool) carries over from before the
  pause, reduced by `pauseLen` worth of cooling / regen.

### Mode B - shield is down (`op.shield.hp == 0`)

Triggered automatically the instant Mode A drops the shield to 0.

- **Active weapons:** every equipped weapon, including distortion.
- **Cycle dictator:** **distortion ammo pool.** Distortion fires every shot
  at its own `shotInterval` until empty.
- **Energy weapons - "trickle fire" (two phases):**
  1. **Phase 1 - pool drain.** Pool full at Mode-B entry. Fire at
     `shotInterval` until pool empty.
  2. **Phase 2 - cooldown + trickle.** Once empty, wait `Consumption.Cooldown`
     seconds (the standard energy cooldown before regen starts), THEN cadence
     becomes `max(shotInterval, regenTimePerShot)` where
     `regenTimePerShot = 1 / (MaxRegenPerSec * regenMult * powerFrac)`. Fire
     one shot, wait for one shot to regen, fire next.
  - This matches the existing `sustained.js` math (`regenTime = effAmmo /
    regenPerSec + cooldown`) - if we ignore the Cooldown component we
    overestimate effective DPS by a noticeable margin on weapons with
    Cooldown > 0.5 s.
- **Ballistic:** fires at its own `shotInterval` until overheat / mag empty,
  then its own `reloadTime`. Not gated by distortion.
- **When distortion empties:** the entire group pauses for `pauseLen` (same
  slider). Energy pools regen during this window; ballistic continues its
  own cycle on next fire.
- **After pause:** distortion's magazine refills only enough to fire a couple
  of shots (because pause < full distortion recharge by default). Cycle
  resumes.

### Mode switching

Driven by the **fire-policy toggle**:

- **Optimal policy** (default):
  - Start in Mode A (or Mode B immediately if `op.shield.maxHp == 0`).
  - On the **same sim tick** that `op.shield.hp` first reaches 0:
    - Flip mode to B.
    - Reset all `nextFire = t` so the switch is instantaneous (no orphan
      Mode-A pause carries over).
    - Distortion's clock starts at `t`.
  - No switch back.
- **Fire-all policy:**
  - Start in Mode B at `t=0`. Distortion fires immediately, absorbed by the
    shield (zero progress on the distortion pool until shield breaks).
  - No mode flip - same sim from start to finish.

The user picks the policy via a radio in the dialog; both policies are
otherwise identical (same pause slider, same shield-regen model, same
synchronized fire).

### Loadout without distortion

Mode B == Mode A in this case (distortion-active-set is empty, dictator stays
the shortest-CF energy/ballistic). Both policies produce identical output -
the toggle effectively no-ops. Hide the radio when no distortion is equipped.

---

## Pause slider

- **Range:** 2 s minimum → `max(fullCooldown)` across all equipped weapons,
  with continuous-fire weapons excluded from the max calc (their fullCooldown
  is Infinity). If ALL equipped weapons are continuous-fire, cap at 30 s.
  `fullCooldown = (magazine / rpm * 60) + reloadTime`.
- **Default:** dynamically derived from the **selected opponent shield's**
  `DamagedDelay`. Default = `clamp(2, max, damagedDelay)`. Live.zip data:
  S0/S1 shields land at 3.85-4.55 s, so default is ~4 s for typical
  fighter targets. Updates when the user changes opponent shield.
- **Readout:** the slider value displays alongside the shield's regen window,
  e.g. `"3.5 s   (shield regens after 4.55 s)"`. Lets the user see at a glance
  whether their pause prevents regen for THIS opponent. The exact regen-onset
  number is a useful design hint that pilots don't get in-game.
- **Persistence:** `saveTtkPrefs` (`sc-ttk-prefs.pauseLen`).

The slider stays a user knob - we don't lock it. Pilots can't tell 3 s from
3.24 s in a real fight, and they rarely know exactly what shield the target
runs (Military / Civilian / Stealth all have different `DamagedDelay`). The
slider is for exploring what's a realistic target pause for the current
matchup, not enforcing one.

---

## Optimal cooling / reloading time (the `optimal: X s` suggestion)

`computeOptimalPauseLen(weaponGroups, opponent, opts)` proposes the pause the UI
labels `(optimal: X s)`. It is a *suggestion*, not a lock - the slider stays a
user knob. The reasoning is a judgement call (and **may change**), so it is
documented here:

**Goal:** the most forgiving cadence that costs nothing in TTK. A human can't
hold a tight 0.5 s burst-pause rhythm in a dogfight; waiting ~5 s is far easier.
So we want the *largest* pause that doesn't slow the kill.

The function searches `[minPause, maxPause]` and applies three rules:

1. **Prefer the largest pause among ties.** Among pauses that reach the decisive
   outcome (priority: kill > disable > break-shields) in the *fastest* time, pick
   the **largest**, not the smallest. When the kill lands inside the first burst
   (`CYCLES 1`) the cooldown never even fires, so every pause ties - and we hand
   back the most relaxed one. When the pause genuinely matters (multi-cycle, or
   shield regen between bursts) only the true optimum ties, so it still wins.

2. **Stay strictly below the shield's regen onset** (`shield.DamagedDelay`). A
   pause that reaches the onset lets the shield start regenerating the instant the
   pilot is a hair late, undoing progress - never worth it. Applied only when the
   shield can regen (`RegenRate > 0`).

3. **Never exceed the fastest gun's return-to-100%.** Past that, the quickest gun
   sits ready and idle (wasted uptime), so the synced pause should end as soon as
   it can re-open fire. "Return to 100%" depends on the weapon's firing economy:
   - **Energy:** refill the ammo pool from regen, plus the post-empty cooldown -
     `MaxAmmo / MaxRegenPerSec + Cooldown`.
   - **Ballistic:** the **natural cooldown** - cool from the overheat threshold
     back to `MinTemp` at `CoolingPerSecond` -
     `(OverheatTemp - MinTemp) / CoolingPerSecond + TimeTillCoolingStarts`.
     **NOT `OverheatFixTime`.** That lockout only applies if you let the gun
     *overheat*; the model deliberately stops the burst *before* overheat (the
     ideal burst time). So the ballistic cadence is: fire to just under overheat,
     then wait this cool-down before re-opening fire.

Net result: `clamp(minPause, largest-tie pause, min(regenOnset, fastest
recovery))`. If the caps fall below `minPause`, the floor wins.

> **Firing-economy classification is consolidated.** The energy / heat /
> continuous classification, full-recovery time, and continuous-fire time all
> live in `sustained.js` (`classifyFiringMode`, `fullRecoveryTime`, and the
> `mode` / `continuousFireTime` / `fullRecoveryTime` fields on `getWeaponCadence`).
> The TTK sim, `computeIdealBurstDuration`, this optimal-pause cap, and the
> weapon-column ammo / fire-time readouts all read from there, so the rule
> (notably "heat needs a real `OverheatTemp`") can't diverge again.

---

## Enemy shield regen

Pause slider only has meaning if longer pauses actually cost something. Model
shield regen using the fields already present on shield items:

```
{ shield.DamagedDelay, shield.RegenRate, shield.DownedDelay }
```

- **Integrate over inter-event interval, not per-tick.** With an event-driven
  sim, `dt` between two consecutive events can be many seconds. A discrete
  per-tick check that "compares `t - lastShieldDmgT` to `DamagedDelay`"
  silently skips regen if the threshold crosses mid-interval.
- **Correct integration at each event:**
  ```
  regenStartT  = lastShieldDmgT + DamagedDelay
  regenWindow  = max(0, t_now - max(t_prev, regenStartT))
  op.shield.hp = min(maxHp, op.shield.hp + RegenRate * regenWindow)
  ```
- **`lastShieldDmgT`** updates on every event where `shieldDmg > 0`.
- **`DownedDelay`** drives a separate timer: if `op.shield.hp == 0` and
  `t - shieldDownT >= DownedDelay`, shield begins recovering from 0
  (rarely matters once Mode B is dropping distortion into the PP pool,
  but model it correctly for the slider's worst-case).
- **Resistance/absorption unchanged** - already in the deflection profile.

This is **additive on `buildOpponentProfile`** - same byte-identical output
for the Deflection dialog (which never invokes the regen tick).

---

## Removed: ideal-mode

Reasons (your call):

- Hard to interpret. 6 weapons × differing CFs → no human jongles 6 independent
  cooldowns. The ideal floor doesn't correspond to any achievable behavior.
- The realistic sim + 2 s pause slider already produces the practical floor.
  The fire-policy toggle covers the conserve-vs-dump distortion decision.
  Between those two knobs every meaningful TTK question is answered.
- One TTK number per outcome (per policy) reads cleaner in the result table.

---

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| **1** | Mode A + pause slider + enemy shield regen. Single-mode sim, replaces ideal. (Mode-B stub keeps Mode A's behavior for now.) | ~1.5 days |
| **2** | Mode B (distortion-anchor + energy trickle-fire) + auto-switch at shield break + **fire-policy toggle** (optimal vs fire-all). | ~1 day |
| **3** | (Deferred) Per-weapon trigger mapping UI - drag weapons into T1/T2. Only if real fights surface a need. | ~1 day |

Phase 1 alone produces useful, shippable TTK numbers for the
energy+ballistic case (which is the dominant fight phase against a shielded
target). Phase 2 closes the loop for the shield-down phase.

---

## Code map

- `js/ttkCalc.js`
  - Replace `simulateTtk` event loop with two-mode dispatcher.
  - Add `firePilot(weaponGroups, opponent, mode, pauseLen)` helper.
  - Add `applyShieldRegen(op, t, lastDmgT, dt)` helper.
- `js/sustained.js`
  - Export `regenTimePerShot(weapon, consumption, powerFrac, regenMult)` for
    the trickle-fire cadence. Already computable from `effectiveAmmo` +
    `regenTime` but factor out cleanly.
- `js/deflectionCalc.js`
  - `buildOpponentProfile` already returns `shield.maxHp`; add
    `shield.damagedDelay`, `shield.regenRate`, `shield.downedDelay`
    (additive - Deflection dialog ignores them).
- `js/ttkCalcUI.js`
  - Remove any "ideal vs realistic" toggle (if present).
  - Add `.ttk-pause-slider` with label, value readout, slider min/max from
    the loadout's `max(fullCooldown)`.
  - Add **fire-policy radio** with verb-based labels:
    "Hold distortion until shields drop" / "Fire distortion from the start".
    Hidden when no distortion is equipped.
  - Update footnote: "Pause between fire cycles (see ⓘ)." with hover detail
    on the trade-off.
- `js/stateStore.js`
  - Add `pauseLen` and `firePolicy` to `saveTtkPrefs` / `loadTtkPrefs` shape.
- `test/ttkCalc.test.js`
  - Mode A: shortest-CF dictator selected correctly across mixed loadout.
  - Mode A: pause honored (all weapons silent during `pauseLen`).
  - Shield regen: hp recovers after `damagedDelay` + `regenRate * dt`; held
    off as long as damage lands every < `damagedDelay`.
  - Slider effect: 2 s pause → faster TTK than 8 s pause when regen is non-zero;
    equal TTK when regen is zero (sanity check).
  - Mode B (Phase 2): distortion fires every cycle; energy trickle-fires after
    pool empty; ballistic uncoupled.
  - Mode switch (Phase 2): with optimal policy, shield-break tick flips mode,
    all clocks reset.
  - Fire-all policy (Phase 2): distortion fires from t=0, contributes 0 to
    distortion pool until shield breaks (absorbed), then starts filling.
  - No-distortion loadout: both policies produce identical output.
- `PLAN_TIME_TO_KILL.md` - add cross-link to this plan, mark ideal-mode replaced.
- `FORMULAS.md` - add "Time to Kill" section documenting the two-mode model.
- `TODOS.md` - add Phase 3 (per-weapon trigger mapping) as deferred.

---

## Eng-review decisions (2026-06-01)

Locked in during `/plan-eng-review`:

1. **Pause slider is user-controlled, default tied to opponent shield.**
   Default = `clamp(2, max, damagedDelay)`. Readout shows the shield's regen
   window so the user sees the trade-off. Updates on opponent change.
2. **Continuous-fire weapons excluded from slider max calc.** If every
   equipped weapon is continuous-fire, cap at 30 s.
3. **Per-weapon physical state continuously integrated** during pauses.
   Heat (ballistic) and pool (energy) carry over with cooling / regen applied
   over inter-event intervals.
4. **Trickle-fire is two-phase:** pool-drain → Consumption.Cooldown silence
   → per-shot regen cadence.
5. **Fire-policy label** revised to verb-based ("Hold distortion until shields
   drop" vs "Fire distortion from the start") to avoid the ambiguity of
   "Optimal / Fire all".
6. **Shield regen integrated over interval**, not checked per-event.

## Critical regression tests (mandatory)

Per the eng-review IRON RULE for regressions:

- **`simulateShot` byte-identical contract.** Lock with a fixture-based
  test that compares the deflection-dialog output before and after this
  plan's changes to `buildOpponentProfile`. The Deflection dialog must
  see zero functional change.
- **Ideal-mode tests migrated.** All existing `test/ttkCalc.test.js` cases
  that assume independent per-group cadence (no synchronized pause) need
  rewriting against the new model. Confirm no surviving test relies on
  ideal-mode behavior.

## Open / out of scope

- **Per-weapon trigger mapping UI** (Phase 3) - deferred until we see a real
  loadout this can't express.
- **Attacker shield regen during pauses** - not modeled. We simulate the
  attacker's offense, not their defense.
- **Missiles in TTK** - already out of scope (PLAN_TIME_TO_KILL.md non-goals).
- **Energy-weapon power management beyond full pips** - the existing sim runs
  weapons at `powerFrac = 1`. Out of scope here.
- **Heat budgeting across the loadout** - heat is per-weapon today. Cross-
  weapon thermal coupling not modeled.
- **Auto-margin for ballistic overheat avoidance** - ballistics in SC have
  no magazine reload; the only recovery cost is `OverheatFixTime` (~1-3 s)
  after overheat OR natural cooling after a voluntary pause
  (`TimeTillCoolingStarts` ~0.2-0.6 s, then `CoolingPerSecond`). The
  voluntary pause is much cheaper. **By design**, the sim does NOT
  auto-apply a safety margin to ballistic cadence - the user manages this
  manually via the pause-slider. If their pause is shorter than the
  longest-overheating ballistic needs to cool, that weapon overheats and
  the longer `OverheatFixTime` penalty surfaces in the result. The slider
  IS the pilot's safety-margin knob.
