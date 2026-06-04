import logging

from pydoover.processor import Application
from pydoover.models import DeploymentEvent

from .app_config import PivotWaterMapConfig
from .app_ui import PivotWaterMapUI

log = logging.getLogger(__name__)


class PivotWaterMapApp(Application):
    """Host for the pivot "as-applied water map" widget.

    This processor does **no** server-side work. The entire as-applied map —
    irrigation-event segmentation, the per-sector applied-depth maths and the
    GeoJSON rendering — is computed client side in the ``PivotWaterMapWidget``
    remote component, which reads the configured flow / position / end-gun tags
    straight out of the source app's ``tag_values`` history.

    The processor exists only to carry the configuration (which tags to read,
    pivot geometry, dormancy window, units, maps key) through to the widget and
    to host that widget via the static UI schema.
    """

    config_cls = PivotWaterMapConfig
    ui_cls = PivotWaterMapUI

    async def on_deployment(self, event: DeploymentEvent):
        log.info("Pivot Water Map deployed for agent %s", self.agent_id)
