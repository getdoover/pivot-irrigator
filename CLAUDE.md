# Pivot Irrigator

A monorepo of Doover apps for centre-pivot irrigators, built on pydoover 1.3+.
See `README.md` for the product overview.

## Apps in this repo

- **`src/pivot_water_map/`** — a *processor* (Lambda) that hosts the as-applied
  water-map **widget** (`widget/`). It does no server-side work; all map
  computation is client-side in the widget. Subclasses `pydoover.processor.Application`.
- **`src/valley_irrigator/`** — a *device app* (container) skeleton that will
  talk to a Valley panel via VCP over RS232. Subclasses `pydoover.docker.Application`.
- **`simulators/pivot/`** — a device app that produces test pivot data and
  backfills history via `log_history`.

## Commands

```bash
uv run pytest tests -v             # Run tests
uv run export-config-watermap      # Write pivot_water_map config_schema into doover_config.json
uv run export-ui-watermap          # Write pivot_water_map ui_schema (hosts the widget)
uv run export-config-valley        # Write valley_irrigator config_schema
uv run export-ui-valley            # Write valley_irrigator ui_schema
npm --prefix widget run build      # Build the widget bundle (needs the doover-js tarball)
doover app run                     # Run simulator + valley device app via docker-compose
```

## Project Structure

```
src/pivot_water_map/   # Processor / UI host for the map widget
  __init__.py          # Lambda handler — run_app(PivotWaterMapApp())
  application.py        # processor.Application (on_deployment only)
  app_config.py        # Config: TagSource mappings, geometry, units, dormancy, maps key
  app_ui.py            # ui.RemoteComponent hosting the widget
src/valley_irrigator/  # Device app skeleton (VCP/RS232 — TODO)
  __init__.py          # Entry point — run_app(ValleyIrrigatorApplication())
  application.py        # docker.Application (setup, main_loop)
  app_config.py        # Serial config
  app_tags.py          # flow / position / end-gun / pressure tags
  app_ui.py            # UI variables (with log_threshold to log history)
widget/                # RemoteComponent (rspack + Module Federation, Google Maps)
  src/PivotWaterMapWidget.tsx   # React widget
  src/lib/pivot.ts              # Pure computation: events, sector depth, GeoJSON
simulators/pivot/      # Simulator producing test pivot data
tests/                 # pytest suite
```

## pydoover Patterns

The device app + simulator use the pydoover declarative API. Key patterns:

### Application class (application.py)
- Set `config_cls`, `tags_cls`, `ui_cls` as class attributes — framework wires them up automatically
- Override `async def setup()` for init and `async def main_loop()` for the periodic loop
- Use `@ui.handler("element_name")` for UI interaction callbacks (signature: `self, ctx, value`)
- Access config via `self.config.<field>.value`, tags via `self.tags.<name>.set(val)` / `.get()`
- Cross-app tags: `self.get_tag("tag_name", app_key)`
- Messaging: `await self.create_message(channel, {data})`

### Config (app_config.py)
- Subclass `config.Schema` with class-level `config.Boolean`, `config.String`, `config.Application`, etc.
- `export()` is a classmethod: `SampleConfig.export(path, name)`

### Tags (app_tags.py)
- Subclass `Tags` with class-level `Tag("type", default=...)` declarations
- Types: "boolean", "number", "integer", "string", "array", "object"

### UI (app_ui.py)
- Subclass `ui.UI` with class-level element declarations
- Bind variables to tags: `ui.NumericVariable("Label", value=MyTags.field, name="id")`
- Element types: `BooleanVariable`, `NumericVariable`, `TextVariable`, `Button`, `TextInput`, `FloatInput`, `Select`, `Submodule`
- Use explicit `name=` kwarg on interactive elements to match handler names

### State Machine (app_state.py)
- Uses `pydoover.state.StateMachine` (wraps the `transitions` library)
- Define `states` and `transitions` as class attributes, `on_enter_<state>()` callbacks

## Doover Skills

If you have the doover-skills plugin installed, use `/doover` to see all available skills.
Key skills: `/doover-device-apps` for device app development, `/pydoover` for API reference.
