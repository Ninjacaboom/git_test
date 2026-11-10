# Plan: Loadout Advisor (weapon recommendations v1)

Status: Draft (next: discuss open questions, then `/plan-eng-review`)

A recommendation engine that, for the currently selected ship, proposes the
best component combination for what the user wants to DO with the ship -
starting with weapons. Where the TTK dialog answers *"how fast does THIS
loadout kill THAT ship?"*, the Advisor answers *"which loadout should I
equip to fight that ship (or that class of ships) in the first place?"*

Logic would live in `js/advisorCalc.js` (pure) + `js/advisorUI.js` (modal),
mirroring the `ttkCalc.js` / `ttkCalcUI.js` split.

---

## Core modeling insight: the matchup decides the loadout

The reference example (Anvil Arrow) shows why "max DPS" is not a
recommendation:

- **Arrow vs Guardian MX** (slower, heavily armored target): the Arrow
  controls the engagement range. Weapons can be scored at their OWN best
  band - short-range high-DPS repeaters/scatterguns become viable. But the
  Guardian's high deflection thresholds mean per-pellet alpha must clear
  them, which pushes back toward cannons. The tension between those two
  forces is exactly what the engine must surface.
- **Arrow vs M80** (faster target): the M80 dictates range and pass timing.
  Time-on-target windows are short and chosen by the enemy, so projectile
  velocity, effective range coverage, and per-pass alpha matter more than
  peak DPS at a band you cannot force. And because the M80 can disengage at
  will, shield and distortion progress rewinds between passes - damage that
  is PERMANENT (ballistic through to armor/hull) is what compounds.

Formalized, the engagement model derives a few factors from data both sides
already have:

1. **Range control** `rc in [-1, +1]` from the SCM/boost speed delta
   (attacker minus target, normalized). Positive = attacker picks the band,
   negative = target picks it, near zero = contested.
2. **Expected range bands with weights.** If `rc > 0`: bands where the
   candidate loadout peaks (the attacker forces its own optimum). If
   `rc < 0`: bands where the TARGET's stock loadout peaks (proxy for what a
   competent enemy pilot forces). Contested: blend.
3. **Hit-probability proxy** per weapon and band:
   `pHit = f(timeOfFlight, target agility, target size, gimbal/aim assist)`
   where `timeOfFlight = range / projectileSpeed`. Simple first version:
   a clamped ratio of target displacement during flight time
   (lateral speed proxy from SCM + angular rates) vs target dimensions.
   Tuning constants live in one place and are documented as heuristics.
4. **Damage permanence.** Two pools recover automatically: shield HP
   (`RegenRate` after `DamagedDelay`) and the PP distortion pool
   (`Durability.Distortion.DecayRate` after `DecayDelay` - verified on
   Live 4.9: every real PP drains its FULL pool in exactly 15 s, i.e.
   `DecayRate = MaximumDamage / 15`, with `DecayDelay` 1.5-6 s and
   `RecoveryTime = DecayDelay + 15`). Armor, hull, vital-part and PP
   physical damage never recover during a fight - manual component repair
   (`Durability.SelfRepair`, an engineer/pilot operation on destroyed
   components) is deliberately ignored (decision 2026-07-29): once a ship
   is disabled it dies quickly in a real fight. Range control decides how
   much permanence matters:
   - `rc < 0` (target faster): the enemy controls disengagement, so
     off-target gaps are long enough for shield regen to rewind temporary
     damage. Progress that survives the gaps is what wins - favor ballistic
     (permanent bleed-through even shield-up via the absorption split, then
     armor/hull damage). Energy loadouts risk a Sisyphus fight where each
     pass re-fights the same shield, and distortion suffers twice: it only
     lands in shield-down windows, and the pool it filled drains within
     seconds once the target disengages.
   - `rc > 0` (attacker faster): continuous pressure is available, regen
     never starts, and energy weapons (infinite ammo, shield-first) become
     a real alternative - the sustained-pressure assumption the TTK sim
     already makes actually holds.
5. **Exposure model (later phase):** fraction of the fight you can keep guns
   on target, from angular-rate delta (turn-fight tracking) vs pass-based
   jousting. v1 can fold this into the band weights.

PvE vs PvP is a multiplier on the evasion side of `pHit`: NPCs barely
evade, so PvE collapses toward sustained DPS + ammo economy; PvP raises the
weight of velocity and forgiveness.

---

## Parameter inventory

### A. Weapon parameters (per candidate - ALL already parsed)

| Parameter | Source | Why it matters |
|---|---|---|
| Alpha per damage type, pellets, per-pellet | `weaponParser` | Deflection viability is per pellet; armor thresholds |
| Burst DPS / Sustained DPS | `sustained.js` | Peak vs long-fight output |
| RPM | `weaponParser` | Forgiveness - aim-error cost per miss |
| Projectile speed | `Ammunition.Speed` | Hit probability vs fast/agile targets |
| Range | `Ammunition.Range` | Engagement-band coverage |
| Ammo: capacity / pool + regen, rounds-before-overheat | `sustained.js` | Fight length, kills per rearm |
| Damage type mix (Ballistic / Energy / Distortion) | `weaponParser` | Different defense pipelines (see FORMULAS "Find Deflection") |
| Heat / continuous-fire time | `sustained.js` | Burst discipline, pause cadence |
| Power draw | `ResourceNetwork` | PP feasibility, pip demand |
| EM signature | `ResourceNetwork` | Stealth intents |
| Penetration distance | `Ammunition.Penetration` | Component-disable reach gate |
| Gimballed vs fixed | port data | Size trade vs aim assist (skill profile) |
| Charged / burst fire modes | `Firing` | Cadence model already in TTK enumerator |

### B. Target parameters (opponent - all in `buildOpponentProfile` + vehicle data)

- Class / role: `vehicle.Role` (Light/Medium/Heavy Fighter, Interceptor,
  Stealth Fighter, ... - the `FIGHTER_ROLES` taxonomy in `config.js`)
- Shield: HP, face count, resistances, absorption, `RegenRate`,
  `DamagedDelay`, `DownedDelay`
- Armor: deflection thresholds (phys/energy), durability multipliers, armor HP
- Hull: HP, vital parts, hull damage multipliers, penetration multipliers
- Power plant: HP, distortion pool + decay (`Distortion.MaximumDamage`,
  `DecayDelay`, `DecayRate`, `RecoveryTime`), count, reach depth
  (`ppReachForSize`). `Durability.SelfRepair` (manual repair of destroyed
  components by engineer/pilot) is deliberately ignored (decision
  2026-07-29)
- Flight: SCM, boost, NAV, pitch/yaw/roll, boost multipliers
- Geometry: size, dimensions, cross-section, mass
- Their offense (later phase, for TTD): stock-loadout DPS as a proxy

### C. Attacker parameters (the ship being configured)

- Hardpoint layout: counts, sizes, gimbal options (the search space)
- Power plant budget vs total weapon draw (feasibility, weapon power
  efficiency at full pips)
- Cooling budget (weapons + rest of loadout)
- Flight performance incl. equipped Flight Blade - the blade changes the
  matchup itself (a TSB Arrow vs M80 is a different `rc` than a PHB Arrow)
- Pip system: weapon channel segment vs needed
- Own survivability (shield/hull) - how long a fight can last, so how much
  sustained matters; later: TTD / win margin
- Own signature (stealth intents)

### D. User intent (the input UI)

- **Goal**: destroy / disable-and-loot (distortion mix) / drive off
- **Target**: specific ship (TTK-style picker), a role preset ("light
  fighters", "heavy fighters"), or a weighted meta set
- **PvP or PvE** (evasion factor, NPC behavior) - v1 assumes PvP, PvE later
- **Fight context**: duel vs outnumbered / multi-kill session (ammo economy
  weight)
- **Range doctrine**: brawl / mid / snipe / "let the matchup decide"
  (default: derived from `rc`)
- **Skill profile**: forgiving (high RoF, gimbals) vs high-skill (fixed,
  high alpha)
- **Stealth priority** (EM weight)
- Crafting availability (Impact Force scaling) - later phase

### E. Derived metrics (what the score is built from)

- **TTK per outcome vs the target** - reuse `simulateTtk` as-is
- **Effective DPS** = DPS x `pHit` at the weighted range bands
- **Deflection viability** - per-pellet alpha vs target thresholds
  (hard filter / heavy penalty, from `tierEngine`)
- **Ammo sufficiency** - kills per ammo load vs the fight-context intent
- **Permanent-damage share** - fraction of a combo's per-window output that
  lands in non-recovering pools (armor/hull/vital/PP physical; shield and
  distortion both rewind, see "Damage permanence"). Weighted up as `rc`
  goes negative
- **Power / cooling feasibility** - hard constraints
- **Signature delta** - only weighted under stealth intent
- Later: **TTD / win margin** (their stock DPS vs your defense)

---

## Engine design - `js/advisorCalc.js`

### 1. Hard filters (before any scoring)

- Port compatibility: reuse the existing picker logic (`isCompatible`,
  size/tag rules). Never invent combos the picker would reject.
- Power feasibility: total weapon draw the PP + pip system can actually
  feed (under-powered loadouts allowed only with an explicit flag, since
  `powerFrac < 1` is sometimes a legitimate choice). **The feasibility
  predicate is a Phase 0 deliverable**: a formula over existing pure
  outputs (pip-channel arithmetic from the pip model, not just the
  `powerDraw` scalar) - without it the "no recommended combo violates
  power/cooling feasibility" criterion is untestable.
- Deflection viability is a **COMBO-level property, not per-weapon**
  (eng-review decision, verified against `runArmorPipeline`): the armor
  threshold scales with armor fraction, so an energy weapon deflected at
  100% armor becomes effective once a ballistic partner strips armor.
  Hard-filter only combos where EVERY weapon is non-viable at full armor
  AND no member can strip armor. Sub-threshold weapons are demoted in
  the score at the per-weapon stage, never excluded - excluding them
  would delete exactly the energy+ballistic archetype that exists for
  high-deflection targets like the Guardian MX.

### 2. Candidate generation

Not full combinatorics. Ports in scope: pilot-controlled weapons, plus
manned-turret weapon ports when the "include manned turrets" toggle is on
(same pilot/crew classification `combatCalc` already uses; the TTK
enumerator walks both sets today). Per size-group on the ship:

- **Uniform-per-size combos** (same weapon on all ports of a size) - covers
  the overwhelming majority of real builds.
- **Curated mixed archetypes**: energy + ballistic split (shield-phase +
  armor-phase), distortion mix for disable intents (sized so the distortion
  pool fill beats the PP physical kill when goal = disable), gimbal vs
  fixed variants of the top uniform combos.

Uniform-per-size is a PRODUCT across size groups (~25-40 candidates per
size x gimbal/fixed variants lands in the low thousands before curated
mixes) - fine for the cheap pre-score, which is arithmetic. The
**combo cap applies only AFTER the pre-score ranking, never before**
(capping earlier could silently drop the best build), and the truncation
log line states the cap. Cheap pre-score (effective DPS x viability)
prunes to a top-N (~20) before the expensive step.

**Candidate superset**: kill AND disable archetypes are generated once
per (ship, opponent) and all simmed; intent changes only reweight cached
results. (An intent-dependent candidate set would silently invalidate
the "re-rank without re-simulating" property.)

### 3. Scoring

- **Utility-axes architecture** (approved via office-hours Approach B):
  each consideration (rc-weighted permanence, TTK per outcome, velocity,
  range coverage, ammo economy, ...) is a normalized 0-1 response curve;
  `score = sum(w_i * curve_i(x_i))` with weight vectors per intent
  preset. Per-axis contributions ARE the "because" lines - no separate
  rationale generation. Curves + weights are DATA (module table in
  `advisorCalc.js`, `SALVAGE_HEAD_BASES` pattern).
- Run `simulateTtk` for each surviving combo vs the target. **Pause
  policy** (eng-review): pre-rank at ONE documented heuristic pause
  length; run `computeOptimalPauseLen` only on the final top ~5; surface
  the chosen pause in the because-lines so the TTK dialog's numbers
  cross-check against the Advisor's. (Running the optimizer per combo is
  an ~18x sim multiplier; running none makes the Advisor and TTK dialog
  disagree on the same loadout.)
- **Cache key tuple** (exact, Phase 0 deliverable): weapon multiset +
  opponent (ship, shield override, PP override, counts) + pauseLen +
  distortionMode + ppReach + applyArmorDurability. Intent changes only
  reweight - zero new sims.
- **Permanent-damage share is derived from the `simulateTtk` run** (not
  a separate `simulateShot` pass): pool deltas per outcome give a
  whole-fight share. A full-shield single-shot formula degenerates to a
  binary ballistic/energy flag (energy leaks exactly 0 through a full
  4.x shield) and double-counts `componentDmg`; the sim-derived share is
  a real spectrum and costs nothing extra.
- **Crafting rules** (eng-review): candidates are scored at BASE stats
  (`portName = null` so `getCraftedItemStats` cannot inherit the
  incumbent's crafted rolls); the current loadout is scored as an
  explicit "crafted baseline" candidate at its crafted stats, labeled as
  such; Apply clears `currentCrafting` for every changed port.
- **Latency budget**: scoring runs chunked/async (yield between combos,
  progress indicator) with a per-run event budget. Fighter-vs-fighter is
  ms-scale, but decision 1C allows capital-ship opponents where a
  ballistic grind approaches the sim's HARD_CAP - the cap backstops
  correctness, not latency. Harder pre-sim pruning applies when the
  opponent is not fighter-class.
- **Windowed-pressure TTK** (Phase 3): when `rc < 0`, sustained pressure is
  not achievable - the target disengages at will. Model this as
  matchup-derived forced gaps between fire windows: window/gap lengths
  derived from the speed delta and pass geometry. The sim machinery mostly
  exists (the pilot-fire model already handles pauses with enemy shield
  regen); the additions are enemy-dictated gap cycles and distortion-pool
  decay during gaps (`DecayDelay` + `DecayRate`, same interval-integration
  pattern as shield regen). This makes the ballistic-vs-energy doctrine
  fall out of the simulation instead of being hand-weighted: an energy
  combo vs a faster target sees its shield progress rewind per gap and its
  TTK stretch toward infinity, a ballistic combo keeps its armor/hull
  progress. v1-2 approximate the same effect with the static
  permanent-damage-share weight; Phase 3 replaces the heuristic with the
  windowed sim. The TTK dialog's own sustained-pressure assumption stays
  untouched. **Replacement gate** (eng-review): the windowed sim replaces
  the static permanence heuristic ONLY if it beats it on the meta-corpus
  - reproducing the three golden fixtures is not sufficient (gap
  parameters can be tuned to produce any ranking; that would launder the
  heuristic, not remove it). The permanence axis stays alive alongside
  the windowed sim regardless - "38% of output is permanent" is also the
  more explainable number.
- `score = sum(w_i * normalizedMetric_i)` with the weight vector `w` coming
  from the intent preset. Weights are DATA (one table in the module, or a
  JSON file), not scattered constants - both for transparency and for the
  calibration suite below.
- Every result carries a **"because" list**: the top contributing metrics
  with their raw values ("TTK 6.4 s vs Guardian MX", "projectile 1 400 m/s
  covers M80-dictated 800 m band", "ammo for 3.2 kills", "per-pellet alpha
  clears 60 phys deflection"). Explainability is the trust anchor.

### 4. Calibration / regression

A fixture suite of community-accepted builds per patch ("meta corpus"):
for a handful of (ship, intent, target) triples, assert the known-good
build lands in the top 3. When game data or weights change, the suite says
whether the advisor still produces sane output. This is the weights'
regression test - without it, tuning is guesswork.

---

## UX - `js/advisorUI.js`

- **Entry point**: "Advisor" button in `.lo-analysis-cluster` next to
  Deflection / TTK - gated behind the `SHOW_ADVISOR` dev flag until the
  feature is complete (hidden in production).
- **Step 1 - intent**: target picker (reuse the TTK opponent
  ship/shield/PP dropdowns; single opponent in v1), goal (kill / disable),
  "include manned turrets" toggle (shown only when the ship has manned
  turrets; toggle OFF excludes turret groups from BOTH candidate
  generation and the TTK sim - no gunner means those guns don't fire),
  fight context. PvP is assumed. **v1 UI is presets only** - weight
  sliders deferred to Phase 3 (eng-review decision 2A), landing together
  with the calibration corpus that makes them meaningful.
- **All ships allowed; non-fighters get a calibration banner** (user
  decision 1C): the Advisor button is always visible, but results for
  ships outside `FIGHTER_ROLES` carry a clear "model calibrated for
  fighters" banner.
- **Failure states** (all designed, none silent): empty candidate set ->
  honest-answer state (least-bad combo + unfavorable-matchup because-
  line, or an explicit empty state in matchup terms); Infinity TTK ranks
  last showing `∞` + the limiting factor; ships with missing flight data
  -> rc = 0 (neutral) noted in the because-lines.
- **Matchup panel**: before results, show the engagement analysis - speed
  delta, who controls range, the derived band weights, target's deflection
  thresholds. This is the pedagogical payoff: the user learns WHY the
  recommendation differs between an M80 and a Guardian MX.
- **Step 2 - results**: top 3-5 loadout cards, each with a metric
  scorecard (TTK, eff. DPS, ammo, power fit, deflection status), the
  "because" lines, and an **Apply** action after a `showConfirmDialog`
  confirm. Delta view vs the current loadout.
- **Apply mechanics** (eng-review): builds a `{portName: className}`
  loadout fragment incl. gimbal sub-ports and goes through the
  `applySharedBuild`-style restore path scoped to weapon/turret ports -
  NEVER through the picker click handlers. Apply also: re-enables
  user-disabled weapon/turret ports (the score assumed they fire),
  clears `currentCrafting` on changed ports, and guards against stale
  state (ship changed while the dialog was open -> clean abort with a
  message, never a partially applied loadout).
- Prefs persisted via `stateStore` (`sc-advisor-prefs`).

---

## Reuse map

| Existing piece | Role in the Advisor |
|---|---|
| `simulateTtk` + pilot-fire model (`ttkCalc.js`) | The scoring core - TTK per outcome per combo. Its pause + enemy-shield-regen machinery is also the basis for the Phase 3 windowed-pressure mode |
| `buildOpponentProfile`, `simulateShot` (`deflectionCalc.js`) | Full defense chain per target |
| `lookupOpponentShip`, `listShieldItems`, `listPowerPlants`, `ppReachForSize` (`loadoutQuery.js`) | Opponent resolution + pickers |
| `tierEngine` (`deriveTier`, `getImmuneShips`) | Deflection viability filter |
| `sustained.js` (`getWeaponCadence`, `classifyFiringMode`) | Cadence + ammo economy |
| `weaponParser` output (Speed, Range, RPM, pellets, ...) | Candidate weapon stats |
| `FlightCharacteristics` + Flight Blade override | Both sides of the range-control model |
| `vehicle.Role` + `FIGHTER_ROLES` (`config.js`) | Class presets and target grouping |
| Picker compatibility logic (`isCompatible`) | Hard filter for candidate generation |
| TTK dialog shell (`.lo-build-dialog`, ESC/close pattern) | Modal skeleton |

The genuinely NEW pieces are: the engagement/matchup model, the intent
schema + weight presets, candidate generation, and the recommendation UI.
Everything else is composition of existing machinery.

---

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| **0 - Data audit + model spec** ✅ **DONE 2026-07-29** (see "Phase 0 - findings + specs") | ROSTER-WIDE coverage sweep (schema existence already sampled): Speed/Range across all weapons, `Role` across ships, agility fields. Response-curve spec per axis (incl. velocity + range-coverage curves). Power-feasibility predicate as a formula over pure pip-model outputs. Exact cache-key tuple. Heuristic pre-rank pause length. Gap-length de-risk spike (paper derivation: speed delta -> pass period -> window/gap; confirms Approach B's "additive" claim BEFORE later phases commit to it). Intent schema + preset weight vectors. Draft the FORMULAS section. | ~0.5-1 day |
| **1 - Engine: filters + per-weapon scoring** | `advisorCalc.js`: hard filters (combo-viability rule, capacitor predicate), `rc` scalar, velocity/range/permanence axes per the Phase 0 curve specs, single-weapon scoring vs one target - "best weapon per slot" table. **Additive `damageByLayerAt` counters on `simulateTtk`** (Phase 0 Finding 2 - required by the permanence axis; non-behavioral, TTK dialog must stay byte-identical). **`resolveFlightStats()` extraction** from `statsPanel.js:1026-1054` (~28 lines, pure given base stats + blade item). Per-weapon golden fixtures. Vitest coverage. | ~1.5 days |
| **2 - Combos + TTK integration + dialog** | Candidate superset generation (kill+disable, manned-turret toggle, cap after pre-score), TTK-integrated ranking (heuristic pause, top-5 optimal-pause pass, chunked async scoring), combo-level golden fixtures `[Phase 2 approx]`, `advisorUI.js` with target picker, presets (no sliders), result cards, calibration banner (1C), honest-answer states, confirm-gated Apply (fragment path + 4 regression-critical tests), `SHOW_ADVISOR` dev flag. **Shippable v1** (still hidden in prod). | ~2 days |
| **3 - Engagement model v2** | Range-band weighting, `pHit`, PvE mode (low-evasion NPCs), multi-target weighted sets / role presets, TTD / win-margin context, weight sliders (2A). **Windowed-pressure TTK mode** (forced gaps + shield regen + distortion decay) - replaces the static permanence heuristic ONLY if it beats it on the meta-corpus; the axis stays either way. Meta-corpus calibration suite; combo fixtures tighten to `[Phase 3 exact]`. Flip `SHOW_ADVISOR` on in prod when this lands. | ~2-3 days |
| **4 - Beyond weapons** | Shield choice (TTD), PP/cooler auto-fix for feasibility, Flight Blade recommendation as part of the matchup, missiles, crafting-aware scoring. | later |

---

## Tests - `test/advisorCalc.test.js` (same commits as the code)

- `computeRangeControl`: faster / slower / parity -> sign + magnitude;
  missing flight data -> 0 + neutral flag.
- Hard filters: port compat; feasibility predicate; **combo-viability
  rule** incl. the armor-strip synergy case (energy+ballistic combo
  survives vs a high-deflection target while an all-non-viable combo is
  filtered); empty result -> honest-answer payload with per-filter
  reasons.
- Candidate generation: uniform-per-size, archetypes, gimbal variants,
  turret toggle ON/OFF affecting both ports and sim groups, cap applied
  only post-pre-score with logged truncation.
- Scoring: curve normalization (0-1), contribution summing, permanence
  share from sim pool deltas, because-lines as structured data.
- Ranking: Infinity TTK ranks last, carries the limiting factor.
- Golden fixtures per the design doc: per-weapon `[Phase 1, exact]`,
  combo `[Phase 2 approximate, Phase 3 exact]`.
- **REGRESSION CRITICAL (Apply path, IRON RULE - no skipping):**
  1. Non-weapon ports byte-identical after Apply.
  2. Null-port semantics: intentionally empty ports stay empty
     (`in` checks, never `??` - documented bug history in FORMULAS.md).
  3. Gimbal sub-port fragments equip correctly through the restore path.
  4. User-disabled weapon ports are re-enabled by Apply (the score
     assumed they fire).
- Browser verification per repo protocol (Chrome MCP vs localhost:8080,
  report Live/PTU + version, XSS probe on names rendered in cards and
  because-lines). QA test plan artifact:
  `~/.gstack/projects/NovaTools/imfal-master-eng-review-test-plan-20260729-020500.md`.

## Risks / open questions

1. **Weights are opinions.** Mitigated by transparency (the "because"
   lines), user-tweakable sliders, and the meta-corpus suite. Never present
   the output as ground truth - it is a reasoned suggestion.
2. **`pHit` is a heuristic.** Keep it simple, documented, and in one place;
   calibrate against known matchups (low-velocity ballistics must score
   poorly vs interceptors in PvP).
3. **Enemy stock loadout as band proxy** (when the target controls range)
   assumes a competent default enemy; customized enemies differ. Acceptable
   for a recommendation tool; note it in the dialog footnote.
4. **Manned turrets assume a gunner.** The toggle makes the assumption
   explicit; the matchup model does not otherwise change (turret tracking
   quality vs `pHit` is a refinement for later).
5. **Missiles**: out of scope v1 (consistent with the TTK plan).
6. **Sim cost**: top-N pruning + TTK cache keeps combo scoring bounded;
   `HARD_CAP` already backstops the sim.

## Decisions (2026-07-29)

Locked in with the user:

1. **v1 scope: pilot-controlled weapons + manned turrets, the latter as an
   option.** The focus is fighters, but several heavy fighters (Scorpius,
   Hurricane, ...) carry a manned turret that is a large share of their
   firepower - an "include manned turrets" toggle covers them (assumes a
   gunner is present). Missiles stay out of the equation for now.
2. **Target input v1: single opponent** (TTK parity). Role presets and
   weighted sets remain Phase 3.
3. **Placement: own dialog next to TTK / Deflection**, but the button is
   HIDDEN in the live environment until the feature is complete. Suggested
   gate: a `SHOW_ADVISOR` flag in `config.js` that is true only on
   localhost (exact mechanism decided at implementation).
4. **Apply behavior: replace the current weapon loadout, on explicit
   confirm** (`showConfirmDialog`), touching weapon/turret ports only -
   the rest of the loadout is left untouched.
5. **v1 assumes PvP.** The `pHit` heuristic is tuned for evading human
   pilots; a PvE mode (low-evasion NPCs) may be added later.
6. **Distortion pool decay IS modeled; manual `SelfRepair` is ignored.**
   Two distinct mechanics that must not be conflated:
   - `Durability.Distortion.{DecayDelay, DecayRate, RecoveryTime}` -
     AUTOMATIC decay of accumulated distortion damage, the direct analog
     of shield regen. Verified on Live 4.9 (77 real PPs): full pool drains
     in exactly 15 s (`DecayRate = MaximumDamage / 15`), `DecayDelay`
     1.5 / 3 / 4.5 / 6 s, `RecoveryTime = DecayDelay + 15`. Belongs in the
     windowed-pressure mode (Phase 3); until then the permanent-damage-
     share heuristic treats distortion as a rewinding pool.
   - `Durability.SelfRepair` - MANUAL repair of destroyed components, an
     engineer/pilot operation. Ignored in every phase: once a ship is
     disabled it dies quickly in a real fight, so post-disable repair is
     irrelevant to the recommendation.
   Note: the TTK plan's Phase 0 note mislabeled `SelfRepair` as
   "distortion self-repair" - corrected in `PLAN_TIME_TO_KILL.md`.

## Eng-review decisions (2026-07-29)

Locked during `/plan-eng-review` (run manually; full trail in the review
report at the end of this file). Design doc:
`~/.gstack/projects/NovaTools/imfal-master-design-20260729-013238.md`
(office-hours, Status: APPROVED, spec-review 9/10).

1. **Approach B** from office-hours: utility-axes response curves +
   golden fixtures (per-weapon in Phase 1, combo in Phase 2).
2. **1C**: all ships allowed; non-fighters get a "model calibrated for
   fighters" banner.
3. **2A**: weight sliders deferred to Phase 3; v1 UI is presets only.
4. **Combo-level deflection viability** (outside-voice tension #4):
   armor-strip synergy preserved; per-weapon demote, not exclude.
5. **Permanence from sim pool deltas** (tension #5): the full-shield
   single-shot formula is degenerate; whole-fight share from
   `simulateTtk` output instead.
6. **Hybrid fixture resolution** (tension #3): velocity/range axes into
   Phase 1; combo fixtures retagged `[Phase 2 approx, Phase 3 exact]`;
   new per-weapon Phase 1 fixtures.
7. **Beat-the-heuristic gate** (tension #10): windowed sim replaces the
   permanence heuristic only if it wins on the meta-corpus; the axis
   stays regardless.
8. **Eight consensus gap-fills**: pause policy (heuristic pre-rank +
   top-5 optimizer + pause in because-lines); latency budget (chunked
   async, event budget, non-fighter pruning); crafting isolation (base-
   stat scoring, crafted-baseline candidate, crafting cleared on Apply);
   disabled-port re-enable + 4th regression test; candidate superset +
   exact cache-key tuple; pure flight-stats extraction scheduled in
   Phase 1; combo cap post-pre-score only; power-feasibility predicate
   as Phase 0 formula.

## Phase 0 - findings + specs (COMPLETE, 2026-07-29)

Swept against `data/Live.zip` **4.9.0.12326004** (no PTU snapshot present).
Sweep scripts: `scratchpad/phase0_sweep.py`, `phase0_sweep2.py`.

### Data coverage (roster-wide, counts not samples)

| Question | Answer |
|---|---|
| Weapon `Ammunition.Speed` / `.Range` | **188 / 189** WeaponGun items populate both. The single exclusion is `RSI_Constellation_Taurus_Tractor_Beam` (no `Firing` block at all - already skipped by existing code). No fallback needed. |
| Weapon `RoundsPerMinute` | 6 items lack it: the same tractor beam + **5 beam weapons** (`FireType: 'beam'`, DPS present, S9-S10). Beams already route through the "no alpha -> use sustained DPS" rule in `tierEngine`; the velocity axis still works (they carry Speed). |
| Projectile speed spread | **700-1500 m/s, median 1196** - only a 2.1x spread across the whole roster, and flat across sizes (S1 median 1200, S6 median 1096). -> normalize the velocity curve **globally** over [700, 1500]. |
| Weapon range spread | **999-12003 m, median 2404**, strongly size-stratified: S1-S4 medians 2000-2800 m, S5 4003, S6 6002, S7 7284, S12 12003. -> normalize the range-coverage curve **per size bracket**, never globally. |
| Ship `Role` | 293 ships, **0 missing**, 52 distinct roles, **94 fighter-class** by `FIGHTER_ROLES` substring match. The 1C banner gate is reliable. `Racing` (20 ships) correctly falls outside. |
| `FlightCharacteristics` | **28 / 293 ships have none at all** - the `rc = 0` neutral path is a real case, not hypothetical. Fighters: SCM 205-265 (spread 60 m/s), BoostFwd 385-610 (spread 225 m/s), Pitch 34-75. |
| `VitalParts` | The extractor marks a part vital when its destruction triggers the game's `Destroy` damage group, so ships normally populate it and the kill target is a real vital part. `mainBodyPart` (largest `.Parts`) stays as a defensive fallback for a ship without one. |
| Shield `DamagedDelay` | Real key names are `DamagedDelay` / `DownedDelay` / `RegenRate` (flat on `Shield`). S1: 2.92-6.33 (median 4.68). S2: 3.21-6.96 (median 5.07). S3: 5.04-7.65. |
| Distortion decay | Re-confirmed on this snapshot: 77 PPs with a pool, **every one drains in exactly 15.000 s**, `DecayDelay` in {1.5: 32, 3.0: 24, 4.5: 17, 6.0: 4}. The constant-ratio simplification (`DecayRate = MaximumDamage / 15`) HOLDS. |

### Finding 1 (decisive): `rc` must be boost-dominant, not SCM-based

```
              SCM    Boost   NAV     P/Y/R
Anvil Arrow   229    515     1215    75/57/205
Origin M80    225    560     1400    38/30/150     <- Arrow FASTER on SCM
Guardian MX   208    455     1100    39/39/120
```

The Arrow's SCM (229) is **higher** than the M80's (225). An SCM-based `rc`
would return `rc > 0` for Arrow-vs-M80 - the exact opposite of the doctrine,
and it would break golden fixture 2. Range control in SCM combat is decided
by **boost** (how you close and disengage), where the M80 leads 560 vs 515.

**Spec:**

```
scmRel   = (a.scm   - t.scm)   / max(a.scm, t.scm)
boostRel = (a.boost - t.boost) / max(a.boost, t.boost)
raw      = W_SCM * scmRel + W_BOOST * boostRel      W_SCM = 0.3, W_BOOST = 0.7
rc       = clamp(raw / RC_DECISIVE, -1, +1)          RC_DECISIVE = 0.10
```

Verified against both fixtures:

| Matchup | scmRel | boostRel | raw | **rc** | Reads as |
|---|---|---|---|---|---|
| Arrow vs Guardian MX | +0.092 | +0.117 | +0.109 | **+1.00** (saturated) | attacker fully controls range |
| Arrow vs M80 | +0.018 | -0.080 | -0.051 | **-0.51** | target dictates, clearly but not absolutely |

Both signs match the doctrine, and the magnitudes read correctly: the Arrow
"can without problem control the distance" vs a Guardian (saturated), while
the M80 dictates without it being hopeless (the Arrow keeps an SCM and a
large agility edge).

Numerically verified (script run 2026-07-29, values reproduced exactly):
antisymmetry holds (`rc(A,B) == -rc(B,A)`), self-matchup gives exactly 0,
and the axis is not binary - Arrow vs F7C Hornet Mk II lands at **+0.59**.

**Robustness note:** `RC_DECISIVE = 0.10` saturates roughly a third of
fighter matchups (Arrow vs Guardian MX clears it by only 0.009; Arrow vs
Ares Ion reaches raw 0.208). That is intended for genuinely lopsided pairs,
but it means **golden fixtures must assert the sign and the ranking
consequence, never an exact `rc` value** - a patch nudging boost by 5 m/s
would otherwise break them.

Deliberate exclusions, documented so they are not mistaken for oversights:
**NAV speed** (out-of-combat travel; irrelevant inside SCM engagements) and
**angular rates** (they decide turn-fight tracking, which belongs to the
pHit / exposure axis in Phase 3, not to who dictates *range*).

### Finding 2: `simulateTtk` cannot currently express the permanence axis

`snap()` (`js/ttkCalc.js:516`) captures pool **states** (shieldHp, armorHp,
powerplantHp, distortionPct); `damageAt` is a **single total scalar**;
`shotLog` carries the per-layer split but only under `captureLog` and it is
capped. Pool states cannot recover cumulative shield damage once regen is
active. So the eng-review's "derive permanence from the sim run" decision
needs a small **additive** change:

- Accumulate 5 counters (shield / armor / hull / component / distortion)
  next to the existing `totalDamage`, expose as
  `damageByLayerAt[outcome]`.
- Non-behavioral: the sim already computes every `shot.*` field per volley;
  this only sums them separately. ~6 lines.
- **Must keep the TTK dialog byte-identical** - covered by the existing
  `simulateShot` contract test plus a new assertion that
  `sum(damageByLayerAt) === damageAt` for each outcome.

Permanence share then reads:

```
permanentShare = (armor + hull + component + distortion) / total   at the decisive outcome
```

(Distortion counts as permanent per decision 6: automatic decay is modeled
by the windowed sim, and a disabled ship dies quickly.)

### Finding 3: power feasibility is simpler than feared; cooling is not a differentiator

The weapons channel is capped by the **ship capacitor**, not the power plant
(`loadoutManager.js:860-877`: `max: weaponPoolSize` from
`shipConfig.weaponPoolSize`, `needed: sum(getPowerDraw(cn).segment)`).

```
FEASIBLE(combo)  <=>  sum(getPowerDraw(cn).segment for cn in combo) <= shipConfig.weaponPoolSize
```

A pure function of the candidate combo - **no `buildPipAllocation` run
needed**, which removes the cost concern behind outside-voice finding #12.
Under-powered combos are not excluded but scored with
`powerFrac = min(needed, pool) / needed < 1` (a legitimate choice), and the
frac feeds a curve.

**Cooling is dropped from the hard filter** with rationale: the weapons
channel allocation is capped at the same `weaponPoolSize` for every
candidate, so weapon choice cannot change cooling demand on that channel -
it is invariant across combos and therefore not a discriminator. (The
success criterion is amended accordingly: power feasibility, not
power/cooling.)

### Finding 4: gap-length de-risk spike - result

Two separate questions, two different answers:

**(a) Is a windowed mode expressible without new simulation state? YES.**
An enemy-dictated gap IS the existing `pauseLen` machinery (forced silence,
regen integrated over the interval). The only addition is a burst-length
**cap**: Mode A currently ends a burst when the dictator weapon empties, so
windowed mode ends it at `min(dictator empty, windowLen)` - one extra
termination condition on an existing branch. Approach B's "additive, not a
rewrite" claim **holds**; no revisit of the A-vs-B choice is needed.

**(b) Is the gap MAGNITUDE derivable from kinematics? NO.** A pure
kinematic model breaks at near-parity speeds. Arrow vs M80: the M80's edge
is 45 m/s on 515, so opening from a 2000 m engagement range to a 3000 m
break range takes `2 x 1000 / 45 = 44 s` - an absurd gap that no fight
contains. There is no ground truth for break range or re-attack discipline.

**Therefore the gap is specified as a bounded tactical heuristic, not a
derivation:** the faster pilot opens just long enough for their own shield
to start recovering, i.e. the `DamagedDelay`..`DownedDelay` band, which the
data puts at **3-7 s for fighter shields** - scaled mildly by `|rc|`:

```
gapLen = clamp(GAP_MIN + (GAP_MAX - GAP_MIN) * |rc|, GAP_MIN, GAP_MAX)
         GAP_MIN = 3 s, GAP_MAX = 7 s, applied only when rc < 0
```

This materially strengthens eng-review decision 7: since the gap is itself
a heuristic, the windowed sim has **no epistemic advantage** over the static
permanence axis, so it must earn its place on the meta-corpus rather than
being assumed better. The beat-the-heuristic gate stays.

### Response-curve specs (per axis)

Curve shapes are deliberately simple and monotone; all inputs are clamped
to [0, 1] before weighting. `lin(x, lo, hi)` = clamped linear ramp.

| Axis | Input | Curve | Rationale |
|---|---|---|---|
| `ttk` | seconds to the intent's decisive outcome | `1 - lin(t, T_FAST, T_SLOW)`, T_FAST = 5 s, T_SLOW = 60 s; `Infinity -> 0` | Primary; the fixture ships resolve in this band. |
| `permanence` | permanent share (Finding 2) | `lin(x, 0, 1)`, weight ramped by `max(0, -rc)` | Only matters when the target dictates range. |
| `velocity` | projectile m/s | `lin(v, 700, 1500)` (global) | 2.1x roster spread, flat across sizes. |
| `rangeCover` | weapon range / size-bracket median | `lin(r, 0.7, 1.4)` | Per size bracket; medians in the coverage table. |
| `viability` | per-pellet alpha / target deflection threshold | `lin(x, 1.0, 2.0)`, 0 below 1.0 (demote, never exclude) | Combo-level filter handles total non-viability. |
| `ammo` | kills per ammo load | `lin(k, 1, 3)` | Saturates at 3 - beyond that ammo stops mattering. |
| `powerFit` | `min(needed, pool) / needed` | `lin(x, 0.7, 1.0)` | Under-power is a soft penalty. |

### Intent presets (weight vectors, v1)

| Preset | ttk | perm | vel | range | viab | ammo | power |
|---|---|---|---|---|---|---|---|
| **Duel a fighter (kill)** | 0.35 | 0.20 | 0.15 | 0.10 | 0.10 | 0.05 | 0.05 |
| **Break a heavy (kill)** | 0.30 | 0.15 | 0.05 | 0.10 | 0.30 | 0.05 | 0.05 |
| **Disable and loot** | 0.30 | 0.10 | 0.10 | 0.10 | 0.15 | 0.20 | 0.05 |
| **Long fight / outnumbered** | 0.25 | 0.20 | 0.10 | 0.10 | 0.10 | 0.20 | 0.05 |

Weights sum to 1.0 per preset and live in one module table
(`SALVAGE_HEAD_BASES` pattern). The disable preset scores against the
distortion outcome; the others against `killVital`.

### Cache key tuple (exact)

```
key = [ sortedWeaponMultiset,                              // className:count, sorted
        opponent.shipName, opponent.shieldCn, opponent.ppCn,
        opponent.shieldCount, opponent.ppCount,
        pauseLen, distortionMode, ppReach, applyArmorDurability,
        includeTurrets ].join('|')
```

Intent is deliberately NOT in the key - intent only reweights cached axis
values, which is what makes preset switching free.

### Heuristic pre-rank pause

Use the existing **`DEFAULT_PAUSE_LEN = 3 s`** (`js/ttkCalc.js:211`),
clamped up by `computeMinUsefulPause(weaponGroups)`. Justification from the
sweep: 3 s sits below the `DamagedDelay` of every fighter shield except the
single fastest S1 (2.92 s), so enemy regen stays off during pre-ranking and
no combo is penalized by regen noise it did not cause. The top-5
`computeOptimalPauseLen` pass (which already clamps below `DamagedDelay`)
handles the exception, and the chosen pause is surfaced in the
because-lines.

### Phase 1 hand-off: flight-stats extraction is small

The blade-override half of `computeFlightStats` (`js/statsPanel.js`
1026-1054) is already pure given `(baseFlightStats, bladeStdItem)` -> extract
as `resolveFlightStats()` (~28 lines). The boosted-rotation half stays in
the UI (needs engine pips, irrelevant to `rc`). Documented asymmetry: the
**attacker** side resolves the equipped Flight Blade; the **opponent** side
reads the raw vehicle record, since an opponent's blade is unknowable.

### Phase 0 exit

All eight Phase 0 deliverables are answered above: coverage sweep, response
curves, feasibility predicate, cache key, heuristic pause, gap-length
spike, intent presets, FORMULAS draft (see FORMULAS.md ->
"Loadout Advisor (planned)"). Two spec changes fall out and are folded in:
the additive `damageByLayerAt` change to `simulateTtk` (Finding 2) joins
Phase 1, and cooling leaves the hard filter (Finding 3).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 (Claude subagent - codex unavailable) | INCORPORATED | 12 findings, 12 incorporated (4 as tension decisions, 8 as gap-fills) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 26 issues, 0 critical gaps, 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**CROSS-MODEL:** office-hours second opinion + plan outside voice both ran
as fresh-context Claude subagents; 4 tension points arbitrated by the user
(all resolved toward the outside voice), 8 consensus additions folded in.
Office-hours design doc survived 2 adversarial spec-review rounds
(10 issues fixed, final 9/10):
`~/.gstack/projects/NovaTools/imfal-master-design-20260729-013238.md`.

**UNRESOLVED:** 0

**VERDICT:** ENG CLEARED - ready to implement (Phase 0). Design review
optional before the Phase 2 dialog work.
