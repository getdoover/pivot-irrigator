from pydoover.tags import Tag, Tags


class ValleyIrrigatorTags(Tags):
    """Live values published from the Valley panel.

    These are the tags the pivot water-map widget reads (by app + tag name) to
    build the as-applied map, so keep the names stable.
    """

    water_flow = Tag("number", default=0)
    pivot_position = Tag("number", default=0)
    end_gun_on = Tag("boolean", default=False)
    system_pressure = Tag("number", default=0)
