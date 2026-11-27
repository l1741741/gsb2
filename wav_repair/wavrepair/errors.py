"""Exceptions raised by the wavrepair tool.

All exceptions in this module are expected failure modes: the command line
entry point turns them into a message on stderr and a non-zero exit status
instead of a traceback.
"""


class WavRepairError(Exception):
    """Base class for expected wavrepair failures."""


class WavError(WavRepairError):
    """The input is not a usable PCM WAV file."""


class ConfirmError(WavRepairError):
    """The confirmation file is malformed or internally inconsistent."""


class InputMismatchError(WavRepairError):
    """The confirmation file was made for a different input file."""


class OverlapError(ConfirmError):
    """Confirmed repair ranges conflict under the selected overlap policy."""
