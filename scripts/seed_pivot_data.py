#!/usr/bin/env python
"""Seed an agent's `tag_values` channel with simulated pivot data for testing
the As-Applied Water Map widget.

It writes back-dated history (one logged message per time step, dated in the
past) so the widget sees a full irrigation event / rotation immediately —
no waiting for live data. Uses the pydoover cloud DataClient with your existing
`doover login` (a named profile from ~/.doover).

SAFE BY DEFAULT: prints a plan and does nothing. Add --yes to actually publish.

Examples
--------
    # dry run (default) — just shows what it would publish
    uv run python scripts/seed_pivot_data.py

    # actually publish to the configured test agent
    uv run python scripts/seed_pivot_data.py --yes

    # tweak the shape
    uv run python scripts/seed_pivot_data.py --hours 24 --step-min 2 --flow 60 --yes
"""

from __future__ import annotations

import argparse
import math
import sys
from datetime import datetime, timedelta, timezone


# Defaults match the test install's config:
#   flow_tag     = analog_flow_meter_1.flow
#   position_tag = analog_flow_meter_1.pivot_position
DEFAULT_AGENT = "188155265684606977"
DEFAULT_APP_KEY = "analog_flow_meter_1"
DEFAULT_PROFILE = "default"


def build_points(args) -> list[tuple[datetime, dict]]:
    """Build (timestamp, tags) points spanning the last `hours`, advancing the
    pivot angle and holding a noisy-but-steady flow."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=args.hours)
    step = timedelta(minutes=args.step_min)
    deg_per_min = 360.0 / (args.rotation_hours * 60.0)

    points: list[tuple[datetime, dict]] = []
    t = start
    minutes = 0.0
    while t <= now:
        angle = (minutes * deg_per_min) % 360.0
        # mild sine variation so the depth colour ramp is visible
        flow = max(0.0, args.flow + 0.1 * args.flow * math.sin(math.radians(angle * 2)))
        tags: dict[str, object] = {
            args.flow_tag: round(flow, 2),
            args.position_tag: round(angle, 2),
        }
        if args.end_gun_tag:
            tags[args.end_gun_tag] = bool(args.end_gun_start <= angle <= args.end_gun_end)
        if args.pressure_tag:
            tags[args.pressure_tag] = round(args.pressure + 8 * math.sin(math.radians(angle)), 1)
        points.append((t, {args.app_key: tags}))
        t += step
        minutes += args.step_min
    return points


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--agent", default=DEFAULT_AGENT, help="target agent id")
    p.add_argument("--app-key", default=DEFAULT_APP_KEY, help="source app key the tags live under")
    p.add_argument("--profile", default=DEFAULT_PROFILE, help="doover auth profile (~/.doover)")
    p.add_argument("--org", type=int, default=None, help="organisation id (if the profile needs it)")
    p.add_argument("--channel", default="tag_values", help="channel to publish to")
    p.add_argument("--flow-tag", default="flow")
    p.add_argument("--position-tag", default="pivot_position")
    p.add_argument("--end-gun-tag", default=None, help="optional boolean end-gun tag name")
    p.add_argument("--pressure-tag", default=None, help="optional pressure tag name")
    p.add_argument("--hours", type=float, default=14.0, help="how far back to backfill")
    p.add_argument("--step-min", type=float, default=3.0, help="minutes between samples")
    p.add_argument("--rotation-hours", type=float, default=12.0, help="time for one full 360 rotation")
    p.add_argument("--flow", type=float, default=50.0, help="nominal flow (in the configured units)")
    p.add_argument("--pressure", type=float, default=250.0)
    p.add_argument("--end-gun-start", type=float, default=200.0)
    p.add_argument("--end-gun-end", type=float, default=260.0)
    p.add_argument("--yes", action="store_true", help="actually publish (otherwise dry run)")
    args = p.parse_args()

    points = build_points(args)
    span_h = (points[-1][0] - points[0][0]).total_seconds() / 3600 if points else 0
    sample = points[len(points) // 2][1] if points else {}

    print("Pivot data seeder")
    print(f"  agent      : {args.agent}")
    print(f"  channel    : {args.channel}")
    print(f"  app key    : {args.app_key}")
    print(f"  tags       : {args.flow_tag}, {args.position_tag}"
          + (f", {args.end_gun_tag}" if args.end_gun_tag else "")
          + (f", {args.pressure_tag}" if args.pressure_tag else ""))
    print(f"  profile    : {args.profile}")
    print(f"  points     : {len(points)} over {span_h:.1f} h (every {args.step_min} min)")
    print(f"  sample msg : {sample}")

    if not args.yes:
        print("\nDRY RUN — nothing published. Re-run with --yes to publish.")
        return 0

    try:
        from pydoover.api import DataClient
    except Exception as e:  # pragma: no cover
        print(f"Failed to import pydoover.api: {e}", file=sys.stderr)
        return 1

    client = DataClient(profile=args.profile, organisation_id=args.org) if args.org else DataClient(profile=args.profile)
    agent_id = int(args.agent)

    print(f"\nPublishing {len(points)} messages…")
    for i, (ts, data) in enumerate(points, 1):
        client.create_message(agent_id, args.channel, data, timestamp=ts)
        if i % 25 == 0 or i == len(points):
            print(f"  {i}/{len(points)}")
    print("Done. Open the agent in customer-site and view the As-Applied Water Map.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
