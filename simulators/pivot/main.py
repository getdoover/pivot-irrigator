"""Pivot irrigator simulator.

Produces a realistic centre-pivot data stream so the pivot water-map widget has
something to render before a real Valley panel exists. Publishes the same tag
names the Valley device app does:

    water_flow       (L/s)
    pivot_position   (degrees, 0 = North, clockwise)
    end_gun_on       (bool)
    system_pressure  (kPa)

On startup it backfills ~14 hours of history (a bit over one full rotation) via
``log_history`` so the map is populated immediately, then keeps advancing live.
"""

import logging
import math
import random
from datetime import datetime, timedelta, timezone

from pydoover.docker import Application, run_app
from pydoover.tags import Tag, Tags

log = logging.getLogger(__name__)

# --- pivot behaviour --------------------------------------------------------
ROTATION_RATE_DEG_PER_MIN = 0.5  # full circle in ~12 h
NOMINAL_FLOW_L_S = 25.0
NOMINAL_PRESSURE_KPA = 250.0
END_GUN_START_DEG = 200.0
END_GUN_END_DEG = 260.0

# --- backfill shape ---------------------------------------------------------
BACKFILL_HOURS = 14
BACKFILL_STEP_MIN = 2

LIVE_LOOP_PERIOD_S = 60


def _end_gun(angle_deg: float) -> bool:
    a = angle_deg % 360
    return END_GUN_START_DEG <= a <= END_GUN_END_DEG


def _flow() -> float:
    return round(NOMINAL_FLOW_L_S + random.uniform(-1.5, 1.5), 2)


def _pressure() -> float:
    return round(NOMINAL_PRESSURE_KPA + random.uniform(-8, 8), 1)


class SimulatorTags(Tags):
    water_flow = Tag("number", default=0)
    pivot_position = Tag("number", default=0)
    end_gun_on = Tag("boolean", default=False)
    system_pressure = Tag("number", default=0)


class PivotSimulator(Application):
    tags_cls = SimulatorTags

    async def setup(self):
        self.loop_target_period = LIVE_LOOP_PERIOD_S

        now = datetime.now(timezone.utc)
        start = now - timedelta(hours=BACKFILL_HOURS)
        step = timedelta(minutes=BACKFILL_STEP_MIN)

        # Angle at the start of the backfill window so that the series ends at
        # "now" having swept a bit over one full rotation.
        total_min = BACKFILL_HOURS * 60
        start_angle = -(total_min * ROTATION_RATE_DEG_PER_MIN) % 360

        points: list[tuple[datetime, dict]] = []
        t = start
        angle = start_angle
        while t <= now:
            points.append(
                (
                    t,
                    {
                        "water_flow": _flow(),
                        "pivot_position": round(angle % 360, 2),
                        "end_gun_on": _end_gun(angle),
                        "system_pressure": _pressure(),
                    },
                )
            )
            t += step
            angle += ROTATION_RATE_DEG_PER_MIN * BACKFILL_STEP_MIN

        written = await self.tag_manager.log_history(points)
        log.info("Backfilled %s historical pivot points", written)

        self._angle = angle % 360

    async def main_loop(self):
        self._angle = (self._angle + ROTATION_RATE_DEG_PER_MIN * (LIVE_LOOP_PERIOD_S / 60)) % 360

        await self.tags.water_flow.set(_flow(), log=True)
        await self.tags.pivot_position.set(round(self._angle, 2), log=True)
        await self.tags.end_gun_on.set(_end_gun(self._angle), log=True)
        await self.tags.system_pressure.set(_pressure(), log=True)
        log.debug("Pivot at %.1f deg", self._angle)


def main():
    """Run the pivot simulator application."""
    run_app(PivotSimulator())


if __name__ == "__main__":
    main()
