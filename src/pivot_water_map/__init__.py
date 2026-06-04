from typing import Any

from pydoover.processor import run_app

from .application import PivotWaterMapApp
from .app_config import PivotWaterMapConfig


def handler(event: dict[str, Any], context):
    """Lambda handler entry point."""
    PivotWaterMapConfig.clear_elements()
    return run_app(
        PivotWaterMapApp(),
        event,
        context,
    )
