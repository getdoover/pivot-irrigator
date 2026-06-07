#!/usr/bin/env python
"""Delete tag_values channel messages for an agent within a time range, so you
can wipe a seeded test run and publish a fresh one.

By default it only deletes messages belonging to the seeded source app
(``--app-key``, default ``analog_flow_meter_1``) so it won't touch other apps'
tag history. Pass ``--any-app`` to ignore that filter.

SAFE BY DEFAULT: prints what it would delete and does nothing. Add --yes to
actually delete. You MUST specify a range (--last / --after) or --all.

Examples
--------
    # preview deleting the last 24 h of seeded data
    uv run python scripts/clear_pivot_data.py --last 24h

    # actually delete the last 24 h
    uv run python scripts/clear_pivot_data.py --last 24h --yes

    # delete an explicit window
    uv run python scripts/clear_pivot_data.py --after 2026-06-01T00:00:00Z --before 2026-06-04T00:00:00Z --yes

    # delete ALL of this app's tag_values messages
    uv run python scripts/clear_pivot_data.py --all --yes
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime, timedelta, timezone


DEFAULT_AGENT = "188155265684606977"
DEFAULT_APP_KEY = "analog_flow_meter_1"
DEFAULT_PROFILE = "default"

_REL = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([smhd])\s*$")
_UNIT = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days"}


def parse_duration(text: str) -> timedelta:
    m = _REL.match(text)
    if not m:
        raise argparse.ArgumentTypeError(f"bad duration {text!r}; use e.g. 90m, 14h, 2d")
    return timedelta(**{_UNIT[m.group(2)]: float(m.group(1))})


def parse_dt(text: str) -> datetime:
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--agent", default=DEFAULT_AGENT)
    p.add_argument("--app-key", default=DEFAULT_APP_KEY, help="only delete messages for this app")
    p.add_argument("--any-app", action="store_true", help="delete ALL matching messages regardless of app")
    p.add_argument("--profile", default=DEFAULT_PROFILE)
    p.add_argument("--org", type=int, default=None)
    p.add_argument("--channel", default="tag_values")
    p.add_argument("--last", type=parse_duration, default=None, help="delete the last N (e.g. 14h, 2d)")
    p.add_argument("--after", type=parse_dt, default=None, help="ISO start of range")
    p.add_argument("--before", type=parse_dt, default=None, help="ISO end of range (default now)")
    p.add_argument("--all", action="store_true", help="no time bound — delete the whole history")
    p.add_argument("--yes", action="store_true", help="actually delete (otherwise dry run)")
    args = p.parse_args()

    now = datetime.now(timezone.utc)
    if args.all:
        after, before = None, None
    elif args.last is not None:
        after, before = now - args.last, now
    elif args.after is not None:
        after, before = args.after, args.before or now
    else:
        p.error("specify a range: --last <dur>, --after <iso> [--before <iso>], or --all")

    try:
        from pydoover.api import DataClient
    except Exception as e:  # pragma: no cover
        print(f"Failed to import pydoover.api: {e}", file=sys.stderr)
        return 1

    client = DataClient(profile=args.profile, organisation_id=args.org) if args.org else DataClient(profile=args.profile)
    agent_id = int(args.agent)

    def matches(msg) -> bool:
        if args.any_app:
            return True
        data = getattr(msg, "data", None) or {}
        return bool(data) and set(data.keys()) <= {args.app_key}

    # iter_messages paginates; bound it by before/after when given.
    it = client.iter_messages(agent_id, args.channel, before=before, after=after)
    victims = []
    for msg in it:
        if matches(msg):
            victims.append((msg.id, getattr(msg, "timestamp", None)))

    print("Clear pivot data")
    print(f"  agent    : {args.agent}")
    print(f"  channel  : {args.channel}")
    print(f"  app key  : {'(any)' if args.any_app else args.app_key}")
    print(f"  range    : {after.isoformat() if after else 'BEGINNING'} -> {before.isoformat() if before else 'now'}")
    print(f"  matched  : {len(victims)} messages")
    if victims:
        print(f"  oldest   : {victims[-1][1]}")
        print(f"  newest   : {victims[0][1]}")

    if not victims:
        print("\nNothing to delete.")
        return 0
    if not args.yes:
        print("\nDRY RUN — nothing deleted. Re-run with --yes to delete.")
        return 0

    print(f"\nDeleting {len(victims)} messages…")
    for i, (mid, _ts) in enumerate(victims, 1):
        client.delete_message(agent_id, args.channel, mid)
        if i % 25 == 0 or i == len(victims):
            print(f"  {i}/{len(victims)}")
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
