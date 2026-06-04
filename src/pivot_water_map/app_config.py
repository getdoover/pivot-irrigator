from pathlib import Path

from pydoover import config


class TagSource(config.Object):
    """A reference to a tag published by another app on this agent.

    The water-map widget reads the named tag's *history* straight out of the
    source app's ``tag_values`` channel, so all we need to capture is which app
    publishes it and the tag's name.
    """

    app_name = config.ApplicationInstall(
        "Application",
        description="App on this agent that publishes the tag.",
        name="app_name",
    )
    tag_name = config.String(
        "Tag Name",
        description="Name of the tag within that app.",
        name="tag_name",
    )


class PivotWaterMapConfig(config.Schema):
    # --- Source tags -------------------------------------------------------
    flow_tag = TagSource(
        "Water Flow Tag",
        description="Tag carrying the pivot's water flow rate.",
        name="flow_tag",
    )
    position_tag = TagSource(
        "Pivot Position Tag",
        description="Tag carrying the pivot's angular position in degrees "
        "(0 = North, increasing clockwise).",
        name="position_tag",
    )
    end_gun_tag = TagSource(
        "End-gun Tag",
        description="Optional boolean tag indicating the end-gun is on. Leave "
        "blank if the pivot has no end-gun.",
        name="end_gun_tag",
        required=False,
        default=None,
    )

    # --- Units -------------------------------------------------------------
    flow_units = config.Enum(
        "Flow Units",
        choices=["L/s", "L/min", "m3/h", "US gpm"],
        default="L/s",
        description="Units the flow tag is reported in.",
        name="flow_units",
    )

    # --- Pivot geometry ----------------------------------------------------
    pivot_centre_lat = config.Number(
        "Pivot Centre Latitude",
        description="Latitude of the pivot point (decimal degrees).",
        name="pivot_centre_lat",
    )
    pivot_centre_lon = config.Number(
        "Pivot Centre Longitude",
        description="Longitude of the pivot point (decimal degrees).",
        name="pivot_centre_lon",
    )
    wetted_radius_m = config.Number(
        "Wetted Radius (m)",
        description="Radius watered by the pivot span, in metres.",
        name="wetted_radius_m",
    )
    end_gun_radius_m = config.Number(
        "End-gun Extra Radius (m)",
        default=0.0,
        required=False,
        description="Additional radius watered when the end-gun is on, in metres.",
        name="end_gun_radius_m",
    )

    # --- Analysis ----------------------------------------------------------
    sector_resolution_deg = config.Number(
        "Sector Resolution (deg)",
        default=1.0,
        required=False,
        description="Angular width of each map sector, in degrees.",
        name="sector_resolution_deg",
    )
    position_offset_deg = config.Number(
        "Position Offset (deg)",
        default=0.0,
        required=False,
        description="Calibration offset added to the reported angle to align it "
        "with true North (clockwise positive).",
        name="position_offset_deg",
    )
    dormancy_days = config.Number(
        "Event Dormancy (days)",
        default=5.0,
        required=False,
        description="A new irrigation event starts when flow resumes after at "
        "least this many days without flow.",
        name="dormancy_days",
    )

    # --- Rendering ---------------------------------------------------------
    google_maps_api_key = config.String(
        "Google Maps API Key",
        default=None,
        required=False,
        description="Google Maps JavaScript API key used to render the map. "
        "Set this per-deployment — it is intentionally not committed to the repo.",
        name="google_maps_api_key",
    )

    position = config.ApplicationPosition(default=150)


def export():
    PivotWaterMapConfig.export(
        Path(__file__).parents[2] / "doover_config.json",
        "pivot_water_map",
    )
