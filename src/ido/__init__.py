"""Thin re-export so `import ido` works with src-layout via pyproject."""

from . import decoder as decoder

__all__ = ["decoder"]
