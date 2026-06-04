from pathlib import Path

from pydoover import ui

from .app_tags import ValleyIrrigatorTags


class ValleyIrrigatorUI(ui.UI):
    # log_threshold ensures these are written to tag history as they change, so
    # the pivot water-map widget has a time series to build the map from.
    water_flow = ui.NumericVariable(
        "Water Flow",
        value=ValleyIrrigatorTags.water_flow,
        name="water_flow",
        precision=1,
        log_threshold=0.5,
    )
    pivot_position = ui.NumericVariable(
        "Pivot Position",
        value=ValleyIrrigatorTags.pivot_position,
        name="pivot_position",
        precision=1,
        log_threshold=0.5,
    )
    system_pressure = ui.NumericVariable(
        "System Pressure",
        value=ValleyIrrigatorTags.system_pressure,
        name="system_pressure",
        precision=1,
        log_threshold=1.0,
    )
    end_gun_on = ui.BooleanVariable(
        "End-gun On",
        value=ValleyIrrigatorTags.end_gun_on,
        name="end_gun_on",
    )


def export():
    ValleyIrrigatorUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json",
        "valley_irrigator",
    )
