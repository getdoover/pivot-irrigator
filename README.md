
# Pivot Irrigator

<img src="https://doover.com/wp-content/uploads/Doover-Logo-Landscape-Navy-padded-small.png" alt="App Icon" style="max-width: 300px;">

**Doover apps for monitoring and analysing pivot irrigators**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

[Overview](#-overview) • [Apps](#apps) • [As-applied map](#how-the-as-applied-map-works) • [Development](DEVELOPMENT.md)

<br/>

## 📖 Overview

A monorepo of Doover apps for centre-pivot irrigators, built on
[pydoover](https://github.com/getdoover/pydoover) 1.3+.

The first deliverable is the **As-Applied Water Map**: a visualisation of how much
water a pivot applied across the field, derived from recorded water-flow and
angular-position tag history. It is built as a *processor that hosts a remote
component (widget)* — the app itself does no periodic server work; the widget
reads the recorded tag history and computes the map client-side, the same
pattern as the `connectivity-monitoring` and `sim-provider` apps.

<br/>

## Apps

| App | Package | Type | What it does |
|-----|---------|------|--------------|
| **Pivot As-Applied Water Map** | `src/pivot_water_map/` | Processor (Lambda) + widget | Hosts the map widget; carries the tag mappings, pivot geometry, units and maps key in its config. |
| **Valley Irrigator** | `src/valley_irrigator/` | Device app (container) | **Skeleton.** Talks to a Valley panel via VCP over RS232 and publishes flow / position / end-gun / pressure tags. VCP transport not yet implemented. |

The widget source lives in [`widget/`](widget/) and is built with rspack +
Module Federation into `widget/assets/PivotWaterMapWidget.js`.

A simulator in [`simulators/pivot/`](simulators/pivot/) produces a realistic
pivot data stream (and backfills ~14 h of history on startup via
`log_history`) so the widget can be exercised before a real panel exists.

<br/>

## How the as-applied map works

1. The widget reads the configured **flow**, **angular position** (degrees,
   0 = North, clockwise) and optional **end-gun** tags out of the source app's
   `tag_values` history over the selected window.
2. History is segmented into **irrigation events** — a new event starts when
   flow resumes after a configurable dormant gap (default **5 days**). You can
   also plot the whole window.
3. For each angular **sector** it integrates `flow × time` while the pivot
   sweeps that sector, then divides by the sector's ground area to get the
   **applied depth (mm)**, assuming uniform depth along the radius. The end-gun
   extends the wetted radius for the sectors where it was on.
4. Each watered sector is drawn as a colour-graded **annular-sector polygon** on
   a Google Map (satellite/hybrid).

### Configuration (Pivot As-Applied Water Map)

| Setting | Description |
|---------|-------------|
| **Water Flow Tag** | App + tag name carrying flow rate |
| **Pivot Position Tag** | App + tag name carrying angle (deg, 0 = N, CW) |
| **End-gun Tag** | *(optional)* App + tag name, boolean |
| **Flow Units** | `L/s` / `L/min` / `m3/h` / `US gpm` |
| **Pivot Centre Lat / Lon** | Pivot point location (decimal degrees) |
| **Wetted Radius (m)** | Span wetted radius |
| **End-gun Extra Radius (m)** | Additional radius when the end-gun is on |
| **Sector Resolution (deg)** | Angular width of each map sector (default 1) |
| **Position Offset (deg)** | Calibration to align reported angle with North |
| **Event Dormancy (days)** | Gap that starts a new event (default 5) |
| **Google Maps API Key** | Required to render the map; set per-deployment (not committed to the repo) |

Regenerate `doover_config.json` after changing config/UI with
`uv run export-config-watermap` / `uv run export-ui-watermap`.

<br/>

## Need Help?

- 📧 Email: support@doover.com
- 📖 [Doover Documentation](https://docs.doover.com)
- 👨‍💻 [Developer guide](DEVELOPMENT.md)

<br/>

## 📄 License

Licensed under the [Apache License 2.0](LICENSE).
