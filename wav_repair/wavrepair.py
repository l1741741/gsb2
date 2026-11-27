"""Thin ``wavrepair`` console-script wrapper (``python wavrepair.py ...``)."""

import sys

from wavrepair.cli import main

if __name__ == "__main__":
    sys.exit(main())
