# Nova Tools - Icon Reference

Nova Tools uses two self-hosted icon fonts:

| Font family | Class prefix | Source | Used for |
|---|---|---|---|
| `spv-icons` | `spvi-` | spviewer.eu (`fonts/spv-icons-*.{eot,woff,woff2}`) | The bulk of in-app glyphs - pip channels, section headers, component icons |
| `Font Awesome 6 Free` (Solid) | `fa-` (+ `fa-solid`) | Font Awesome 6.5.1 Free (`fonts/fa-solid-900.woff2`) | Supplemental icons not in `spv-icons` (e.g. component crafting) |

Use whichever set already has the glyph you need. Only add a new icon to a font when the icon legitimately isn't available in the other one.

## `spv-icons` (`spvi-`)

The full icon reference with visual previews is available at `admin/font.html`.

```html
<i class="spvi-{name}"></i>
```

CSS requires a mapping in `css/styles.css`:
```css
.spvi-{name}:before{content:"\{hex}"}
```

### Adding New Icons

1. Look up the icon name and hex code in `admin/font.html`
2. Add the CSS mapping to `css/styles.css` (near the top, with other `.spvi-` rules)
3. Use `<i class="spvi-{name}"></i>` in HTML/JS

## Font Awesome (`fa-`)

Self-hosted FA 6 Free Solid only - we don't pull from the FA CDN at runtime. The woff2 lives at `fonts/fa-solid-900.woff2`.

```html
<i class="fa-solid fa-{name}"></i>
```

The `fa-solid` class is required (it sets the font-family + weight). Per-icon mappings live in `css/styles.css` next to the `@font-face` declaration:

```css
.fa-{name}:before{content:"\{hex}"}
```

### Adding New Icons

1. Look up the icon on https://fontawesome.com/icons (filter: Free + Solid)
2. Note the icon name and unicode (shown in the icon's detail page)
3. Add `.fa-{name}:before{content:"\{hex}"}` to `css/styles.css`
4. Use `<i class="fa-solid fa-{name}"></i>` in markup

If a future feature needs FA Regular or Brands, drop the corresponding `.woff2` into `fonts/`, add a second `@font-face` with the matching font-weight, and document here.

### Currently mapped FA icons

| Name | Hex | CSS class | Used for |
|---|---|---|---|
| wrench | f0ad | `fa-wrench` | Component crafting indicator on loadout slot rows |

## Available Icons (from font.html)

| Name | Hex | CSS Class |
|---|---|---|
| cooler | ea02 | `spvi-cooler` |
| countermeasure | ea04 | `spvi-countermeasure` |
| dimensions | ea05 | `spvi-dimensions` |
| crew | ea06 | `spvi-crew` |
| drive | ea07 | `spvi-drive` |
| crewoperator | ea08 | `spvi-crewoperator` |
| emp | ea09 | `spvi-emp` |
| dashboard | ea0a | `spvi-dashboard` |
| engine | ea0b | `spvi-engine` |
| down | ea0d | `spvi-down` |
| flair | ea0e | `spvi-flair` |
| fuelgauge | ea0f | `spvi-fuelgauge` |
| fuelpump | ea10 | `spvi-fuelpump` |
| gimbal | ea11 | `spvi-gimbal` |
| health | ea12 | `spvi-health` |
| electric | ea13 | `spvi-electric` |
| jumpmodule | ea14 | `spvi-jumpmodule` |
| lockers | ea15 | `spvi-lockers` |
| hydrogenfueltank | ea16 | `spvi-hydrogenfueltank` |
| insurance | ea17 | `spvi-insurance` |
| fuelintake | ea18 | `spvi-fuelintake` |
| infrared | ea19 | `spvi-infrared` |
| missile | ea1a | `spvi-missile` |
| max | ea1b | `spvi-max` |
| missilerack | ea1d | `spvi-missilerack` |
| paint | ea1e | `spvi-paint` |
| parts | ea1f | `spvi-parts` |
| modularity | ea20 | `spvi-modularity` |
| pod | ea21 | `spvi-pod` |
| qdrive | ea22 | `spvi-qdrive` |
| pilot | ea23 | `spvi-pilot` |
| gear | ea24 | `spvi-gear` |
| qed | ea25 | `spvi-qed` |
| powerplant | ea26 | `spvi-powerplant` |
| mass | ea27 | `spvi-mass` |
| pyr | ea28 | `spvi-pyr` |
| radar | ea29 | `spvi-radar` |
| ramp | ea2a | `spvi-ramp` |
| mining | ea2b | `spvi-mining` |
| reverse | ea2c | `spvi-reverse` |
| quantumfueltank | ea2d | `spvi-quantumfueltank` |
| scmnav | ea2e | `spvi-scmnav` |
| shield | ea2f | `spvi-shield` |
| shelve | ea31 | `spvi-shelve` |
| scm | ea35 | `spvi-scm` |
| stealth | ea36 | `spvi-stealth` |
| stealthv | ea37 | `spvi-stealthv` |
| slowdown | ea38 | `spvi-slowdown` |
| thrustermain | ea39 | `spvi-thrustermain` |
| speedup | ea3a | `spvi-speedup` |
| thrustermainretro | ea3b | `spvi-thrustermainretro` |
| thrusterman | ea3c | `spvi-thrusterman` |
| timer | ea3d | `spvi-timer` |
| up | ea3e | `spvi-up` |
| utility | ea3f | `spvi-utility` |
| vault | ea40 | `spvi-vault` |
| weapon | ea41 | `spvi-weapon` |
| weaponcrew | ea42 | `spvi-weaponcrew` |
| weaponturret | ea43 | `spvi-weaponturret` |
| acceleration | ea44 | `spvi-acceleration` |
| armor | ea45 | `spvi-armor` |
| bomb | ea46 | `spvi-bomb` |
| boost | ea47 | `spvi-boost` |
| spool | ea48 | `spvi-spool` |
| cargo | ea49 | `spvi-cargo` |
| strafe | ea4a | `spvi-strafe` |
| cargogrid | ea4b | `spvi-cargogrid` |
| cash | ea4c | `spvi-cash` |
| coins | ea4d | `spvi-coins` |
| brake | ea4e | `spvi-brake` |
| break | ea4f | `spvi-break` |
| crosssection | ea50 | `spvi-crosssection` |
| icon_common_ship_component_wear | ea59 | `spvi-icon_common_ship_component_wear` |
| icon_common_cross_section | ea5b | `spvi-icon_common_cross_section` |
| Engineering_Icon_ItemThrusters | ea5c | `spvi-Engineering_Icon_ItemThrusters` |
| icon_common_EMP | ea5d | `spvi-icon_common_EMP` |
| icon_common_QED | ea5e | `spvi-icon_common_QED` |
| icon_common_coolant | ea5f | `spvi-icon_common_coolant` |
| icon_common_generator_shield | ea60 | `spvi-icon_common_generator_shield` |
| icon_common_life_support | ea61 | `spvi-icon_common_life_support` |
| icon_common_quantum | ea62 | `spvi-icon_common_quantum` |
| icon_common_radar | ea63 | `spvi-icon_common_radar` |
| icon_common_tractor-beam | ea65 | `spvi-icon_common_tractor-beam` |
| icon_common_vehicle_wheel_control | ea66 | `spvi-icon_common_vehicle_wheel_control` |
| icon_common_weapon_gun | ea67 | `spvi-icon_common_weapon_gun` |
| MFD-Icon-Generator | ea69 | `spvi-MFD-Icon-Generator` |
| shieldfrontback | ea6b | `spvi-shieldfrontback` |
| shieldbubble | ea6c | `spvi-shieldbubble` |
| shieldquadrant | ea6d | `spvi-shieldquadrant` |
| icon_common_mining | ea6e | `spvi-icon_common_mining` |
| Engineering_Icon_ItemShields | ea6f | `spvi-Engineering_Icon_ItemShields` |
| PU_mobiapp_icon_mission_salvage | ea70 | `spvi-PU_mobiapp_icon_mission_salvage` |
| icon_common_3D_cargo_boxes | ea71 | `spvi-icon_common_3D_cargo_boxes` |
| icon_common_fuel_quantum | ea73 | `spvi-icon_common_fuel_quantum` |
| icon_common_fuel_hydrogen | ea74 | `spvi-icon_common_fuel_hydrogen` |
| icon_room_type_locker_room | ea75 | `spvi-icon_room_type_locker_room` |
| icon_common_grenade_coil | ea76 | `spvi-icon_common_grenade_coil` |
| icon_services_refuel_a | ea77 | `spvi-icon_services_refuel_a` |
| icon_common_gimbal_mode | ea78 | `spvi-icon_common_gimbal_mode` |
| Engineering_Icon_ItemTurret | ea79 | `spvi-Engineering_Icon_ItemTurret` |
| standard_control | ea7a | `spvi-standard_control` |
| ui_icon_vehicle_ground | ea7b | `spvi-ui_icon_vehicle_ground` |
| icon_common_healing_target_health | ea7c | `spvi-icon_common_healing_target_health` |
| salvage | ea7d | `spvi-salvage` |
| icon_hullscraping_temperature | ea7e | `spvi-icon_hullscraping_temperature` |
| icon_common_warning_overheat | ea7f | `spvi-icon_common_warning_overheat` |
| icon_mining_laserfocuser | ea80 | `spvi-icon_mining_laserfocuser` |
| computer | ea81 | `spvi-computer` |
| icon_services_app_cockpit | ea83 | `spvi-icon_services_app_cockpit` |
| restart_alt | ea84 | `spvi-restart_alt` |
| drag_indicator | ea85 | `spvi-drag_indicator` |
| power_button | ea86 | `spvi-power_button` |
| icon_common_warning_nopower | ea87 | `spvi-icon_common_warning_nopower` |
| AEGS_ENV_Icon_Systems | ea88 | `spvi-AEGS_ENV_Icon_Systems` |

## Icons Currently Mapped in styles.css

Not all icons are mapped in `styles.css`. Only icons that are actively used in the app have CSS rules. To use a new icon, add its `.spvi-{name}:before{content:"\{hex}"}` rule to styles.css.

## Currently Used Icons in the App

| Icon | Used For |
|---|---|
| `spvi-weapon` | Weapons pip channel |
| `spvi-Engineering_Icon_ItemThrusters` | Engine/boost pip channel |
| `spvi-icon_common_generator_shield` | Shields pip channel, shield section header |
| `spvi-icon_common_quantum` | Quantum drive pip channel, QD section header |
| `spvi-icon_common_tractor-beam` | Utility pip channel |
| `spvi-icon_common_radar` | Radar pip channel, radar section header |
| `spvi-icon_common_life_support` | Life support pip channel, LS section header |
| `spvi-icon_common_coolant` | Cooler pip channel, cooler section header |
| `spvi-powerplant` | Power draw stat, power plant section header |
| `spvi-electric` | EM signature stat, power distribution header |
| `spvi-infrared` | IR signature stat |
| `spvi-icon_common_cross_section` | Cross-section stat |
| `spvi-Engineering_Icon_ItemTurret` | Turret section header |
| `spvi-MFD-Icon-Generator` | MFD/generator icon |
| `spvi-power_button` | Shield power toggle button |
| `spvi-standard_control` | Ship stats header, loadouts button |
| `spvi-weapon` | Weapon section header |
| `spvi-missile` | Missile section header |
| `spvi-bomb` | Bomb section header |
| `spvi-icon_common_EMP` | EMP section header |
| `spvi-icon_common_QED` | QED section header |
| `spvi-icon_common_mining` | Mining section header |
| `spvi-salvage` | Salvage section header |
| `spvi-Engineering_Icon_ItemThrusters` | Flight Blade section header (shared with Thrusters/Engine) |
| `spvi-Engineering_Icon_ItemShields` | Armor icon in the collapsed Structure cell and the expanded Armor sub-section |
| `spvi-shield` | Hull icon in the expanded Hull section header |
| `spvi-icon_common_3D_cargo_boxes` | Carrying Capacity sub-header in the expanded overlay |
| `spvi-fuelpump` | Fuel sub-header in the expanded overlay |
| `spvi-insurance` | Insurance sub-header in the expanded overlay |
| `spvi-drag_indicator` | Section drag handle for reordering |
