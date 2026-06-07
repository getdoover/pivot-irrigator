#!/usr/bin/env bash
# Seed the pivot test device with simulated as-applied-map data.
#
#   Agent (device): 188155265684606977
#   Organisation:   105944684232226829
#
# Dry run (publishes nothing — just prints the plan):
#   ./scripts/seed_test_device.sh
#
# Actually publish the back-dated history:
#   ./scripts/seed_test_device.sh --yes
#
# Override the auth profile if "default" isn't the org's profile:
#   DOOVER_PROFILE=dv2 ./scripts/seed_test_device.sh --yes
#
# Any extra args are forwarded to seed_pivot_data.py, e.g.:
#   ./scripts/seed_test_device.sh --yes --hours 24 --step-min 2 --flow 60
set -euo pipefail

AGENT=188155265684606977
ORG=105944684232226829
PROFILE="${DOOVER_PROFILE:-default}"

cd "$(dirname "$0")/.."

exec uv run python scripts/seed_pivot_data.py \
  --agent "$AGENT" \
  --org "$ORG" \
  --profile "$PROFILE" \
  "$@"
