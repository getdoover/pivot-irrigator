from pydoover.docker import run_app

from .application import ValleyIrrigatorApplication


def main():
    """Run the Valley irrigator device application."""
    run_app(ValleyIrrigatorApplication())
