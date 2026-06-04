"""Smoke tests for the pivot-irrigator apps.

Validate that both packages import, their config schemas are well-formed, the
Tags/UI classes subclass the correct bases, and the export entry points run
end-to-end.
"""

import json

from pydoover.config import Schema
from pydoover.tags import Tags
from pydoover.ui import UI


# --- pivot_water_map (processor / UI host) ---------------------------------


def test_import_watermap_app():
    from pivot_water_map.application import PivotWaterMapApp

    assert PivotWaterMapApp.config_cls is not None
    assert PivotWaterMapApp.ui_cls is not None


def test_watermap_handler_exists():
    from pivot_water_map import handler

    assert callable(handler)


def test_watermap_config_schema():
    from pivot_water_map.app_config import PivotWaterMapConfig

    assert issubclass(PivotWaterMapConfig, Schema)
    schema = PivotWaterMapConfig.to_schema()
    assert schema["type"] == "object"
    props = schema["properties"]
    # the source-tag mappings render as nested objects with app + tag fields
    for key in ("flow_tag", "position_tag"):
        assert key in props
        assert "app_name" in props[key]["properties"]
        assert "tag_name" in props[key]["properties"]
    # required geometry
    for key in ("pivot_centre_lat", "pivot_centre_lon", "wetted_radius_m"):
        assert key in schema["required"]


def test_watermap_ui_is_remote_component():
    from pivot_water_map.app_ui import PivotWaterMapUI

    assert issubclass(PivotWaterMapUI, UI)


def test_watermap_exports(tmp_path):
    from pivot_water_map.app_config import PivotWaterMapConfig
    from pivot_water_map.app_ui import PivotWaterMapUI

    fp = tmp_path / "doover_config.json"
    PivotWaterMapConfig.export(fp, "pivot_water_map")
    PivotWaterMapUI(None, None, None).export(fp, "pivot_water_map")

    data = json.loads(fp.read_text())
    entry = data["pivot_water_map"]
    assert "properties" in entry["config_schema"]
    assert entry["ui_schema"]["type"] == "uiApplication"
    assert "PivotWaterMap" in entry["ui_schema"]["children"]


# --- valley_irrigator (device app skeleton) --------------------------------


def test_import_valley_app():
    from valley_irrigator.application import ValleyIrrigatorApplication

    assert ValleyIrrigatorApplication.config_cls is not None
    assert ValleyIrrigatorApplication.tags_cls is not None
    assert ValleyIrrigatorApplication.ui_cls is not None


def test_valley_tags():
    from valley_irrigator.app_tags import ValleyIrrigatorTags

    assert issubclass(ValleyIrrigatorTags, Tags)
    # the contract the water-map widget reads
    for name in ("water_flow", "pivot_position", "end_gun_on", "system_pressure"):
        assert hasattr(ValleyIrrigatorTags, name)


def test_valley_exports(tmp_path):
    from valley_irrigator.app_config import ValleyIrrigatorConfig
    from valley_irrigator.app_ui import ValleyIrrigatorUI

    fp = tmp_path / "doover_config.json"
    ValleyIrrigatorConfig.export(fp, "valley_irrigator")
    ValleyIrrigatorUI(None, None, None).export(fp, "valley_irrigator")

    data = json.loads(fp.read_text())
    entry = data["valley_irrigator"]
    assert "properties" in entry["config_schema"]
    assert entry["ui_schema"]["type"] == "uiApplication"
