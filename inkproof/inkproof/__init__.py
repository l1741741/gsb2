"""inkproof — spot-ink separation proofs for RGBA artwork.

Pure standard library: no Pillow, no NumPy, no network.
"""

from .colors import Ink, InkTable, make_table, rgb_to_lab

__version__ = "1.0.0"
