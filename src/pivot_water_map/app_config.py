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
    track_responsiveness = config.Number(
        "Track Responsiveness",
        default=0.001,
        required=False,
        minimum=0,
        description="How readily the rotation-speed estimate follows the "
        "position tag. The tag only updates in steps, so a small reading error "
        "lands as one fast sector beside one slow sector -- a stripe the "
        "machine never applied. A Kalman filter over the track removes that. "
        "Lower is smoother; higher follows real stop/start more closely.\n\n"
        "Measured on a simulated 24 h revolution with a real 30 min stop:\n"
        "  off     map varies 7-12%, stop fully visible\n"
        "  0.01    map varies  2-7%, stop 103% visible, speed 98% of true\n"
        "  0.001   map varies  2-3%, stop  86% visible, speed 97% of true "
        "(default)\n"
        "  0.0001  map varies  1-2%, stop  60% visible, speed 93% of true\n"
        "  0.00001 map varies  0-2%, stop  38% visible, speed 87% of true\n\n"
        "Below the default the map barely improves while real stops disappear "
        "and the speed chart drifts low, so there is little reason to go there. "
        "0 disables filtering entirely.",
        name="track_responsiveness",
    )
    reversal_threshold_deg = config.Number(
        "Direction Reversal Threshold (deg)",
        default=5.0,
        required=False,
        minimum=0,
        description="How far the pivot must turn back before it counts as a new "
        "pass rather than reading noise. Each pass is filtered on its own, so "
        "this must sit above the position error and below the shortest real "
        "reversal. 5 deg is about 20 m of arc on a 225 m machine. 0 uses that "
        "default.",
        name="reversal_threshold_deg",
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
