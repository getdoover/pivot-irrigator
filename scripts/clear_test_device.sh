#!/usr/bin/env bash
# Clear seeded pivot data from the test device's tag_values channel.
#
#   Agent (device): 188155265684606977
#   Organisation:   105944684232226829
#
# Dry run (shows what would be deleted, deletes nothing):
#   ./scripts/clear_test_device.sh --last 24h
#
# Actually delete the last 24 h of seeded data:
#   ./scripts/clear_test_device.sh --last 24h --yes
#
# Delete everything this app published:
#   ./scripts/clear_test_device.sh --all --yes
#
# Override the auth profile if needed:
#   DOOVER_PROFILE=dv2 ./scripts/clear_test_device.sh --all --yes
set -euo pipefail

AGENT=188155265684606977
ORG=105944684232226829
PROFILE="${DOOVER_PROFILE:-default}"

cd "$(dirname "$0")/.."

exec uv run python scripts/clear_pivot_data.py \
  --agent "$AGENT" \
  --org "$ORG" \
  --profile "$PROFILE" \
  "$@"
