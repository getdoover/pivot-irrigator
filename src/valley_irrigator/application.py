import logging

from pydoover.docker import Application

from .app_config import ValleyIrrigatorConfig
from .app_tags import ValleyIrrigatorTags
from .app_ui import ValleyIrrigatorUI

log = logging.getLogger(__name__)


class ValleyIrrigatorApplication(Application):
    """Device app for Valley centre-pivot control panels.

    SKELETON — this app is intended to run on a doovit wired to a Valley pivot
    panel and talk to it via the VCP protocol over RS232, publishing the live
    flow / angular position / end-gun / pressure as tags. The pivot water-map
    widget then reads that tag history to build the as-applied map.

    The VCP transport and frame decode are **not implemented yet**; see the
    TODOs in ``setup`` and ``main_loop``. Everything else (config, tags, UI) is
    wired up so the contract with the water-map widget is already defined.
    """

    config_cls = ValleyIrrigatorConfig
    tags_cls = ValleyIrrigatorTags
    ui_cls = ValleyIrrigatorUI

    config: ValleyIrrigatorConfig
    tags: ValleyIrrigatorTags

    async def setup(self):
        # TODO: open the RS232 serial port and initialise the VCP client, e.g.
        #   self._serial = serial.Serial(
        #       self.config.serial_port.value,
        #       baudrate=self.config.baud_rate.value,
        #       timeout=1,
        #   )
        #   self._vcp = VCPClient(self._serial)
        log.info(
            "Valley irrigator setup — serial %s @ %s baud (VCP transport TODO)",
            self.config.serial_port.value,
            self.config.baud_rate.value,
        )

    async def main_loop(self):
        # TODO: poll the Valley panel over VCP, decode the live values, and
        # publish them. Publish with ``log=True`` (or rely on the UI elements'
        # log_threshold) so the water-map widget can read the history:
        #
        #   reading = await self._vcp.poll()
        #   await self.tags.water_flow.set(reading.flow_l_s, log=True)
        #   await self.tags.pivot_position.set(reading.angle_deg, log=True)
        #   await self.tags.end_gun_on.set(reading.end_gun, log=True)
        #   await self.tags.system_pressure.set(reading.pressure_kpa, log=True)
        log.debug("Valley irrigator main_loop — VCP poll not yet implemented")
