from pathlib import Path

from pydoover import ui


class PivotWaterMapUI(ui.UI, default_open=True):
    widget = ui.RemoteComponent(
        name="PivotWaterMap",
        display_name="As-Applied Water Map",
        component_url="$config.app().dv_widget_url",
        scope="PivotWaterMapWidget",
        module="./PivotWaterMapWidget",
        # The widget reads the configured flow / position / end-gun tag history
        # directly; app_key lets it pull this app's deployment config (tag
        # mappings, pivot geometry, units, maps key) out of deployment_config.
        app_key="$config.app().APP_KEY",
    )


def export():
    PivotWaterMapUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json", "pivot_water_map"
    )
