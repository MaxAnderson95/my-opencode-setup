#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["python-escpos[usb]==3.1"]
# ///
"""Print on the Epson TM-T88V receipt printer over USB.

Reads a printout as JSON on stdin (the schema lives in index.ts) and writes a
plain-text preview of its layout to stdout. Problems go to stderr with exit
code 1 when the printer cannot print and 2 when the printout cannot be rendered.

With the "status" argument it instead reports whether the printer is connected
and its paper level, exiting 3 when it is not connected.

    echo '{"blocks":[{"type":"text","text":"hi"}],"dry_run":true}' | ./print_receipt.py
    ./print_receipt.py status
"""

import json
import sys
import textwrap
from typing import Any

import usb.core
from escpos.escpos import Escpos
from escpos.exceptions import Error as EscposError
from escpos.printer import Dummy, Usb

VENDOR_ID, PRODUCT_ID = 0x04B8, 0x0202
# Tells python-escpos the paper is 512 dots wide (Font A 42 columns, Font B 56).
PROFILE = "TM-T88V"
# Without a timeout python-escpos waits forever when the printer stops accepting data.
USB_TIMEOUT_MS = 10_000
PAPER_OUT, PAPER_LOW = 0, 1
# Distinct from 1, which Python uses for an uncaught exception.
NOT_CONNECTED = 3
QR_SIZE = 6

Block = dict[str, Any]


def _wrap(text: str, columns: int) -> list[str]:
    """Word-wrap each paragraph, keeping blank lines and leading indentation.

    Paragraphs that already fit print verbatim, so padding such as an inverted
    " TITLE " survives.
    """
    lines: list[str] = []
    for para in text.split("\n"):
        if len(para) <= columns:
            lines.append(para)
            continue
        indent = " " * min(len(para) - len(para.lstrip(" ")), columns - 1)
        lines += textwrap.wrap(
            para.strip(), columns, initial_indent=indent, subsequent_indent=indent
        ) or [""]
    return lines


def _place(line: str, align: str, columns: int, scale: int = 1) -> str:
    """Position a line in the preview the way the printer's alignment would."""
    pad = max(0, columns - len(line) * scale)
    offset = {"center": pad // 2, "right": pad}.get(align, 0)
    return " " * offset + line


def _text(p: Escpos, block: Block) -> list[str]:
    font, align = block.get("font", "a"), block.get("align", "left")
    width, height = block.get("width", 1), block.get("height", 1)
    p.set_with_default(
        align=align,
        font=font,
        bold=block.get("bold", False),
        underline=1 if block.get("underline") else 0,
        invert=block.get("invert", False),
        custom_size=True,
        width=width,
        height=height,
        smooth=True,
    )
    base = p.profile.get_columns(font)
    lines = _wrap(block["text"], base // width)
    for line in lines:
        p.textln(line)
    return [_place(line, align, base, width) for line in lines]


def _row(p: Escpos, block: Block) -> list[str]:
    """Left text and right-aligned text on one line, like an item and its price."""
    left, right = block["left"], block["right"]
    columns = p.profile.get_columns("a")
    p.set_with_default(bold=block.get("bold", False))
    width = columns - len(right) - 1
    if width < 1:
        lines = [*_wrap(left, columns), right.rjust(columns)]
    else:
        lines = _wrap(left, width)
        lines[0] = lines[0].ljust(width) + " " + right
    for line in lines:
        p.textln(line)
    return lines


def _rule(p: Escpos, block: Block) -> list[str]:
    char = block.get("char", "-")
    if len(char) != 1:
        raise ValueError(f"rule char must be one character, got {char!r}")
    line = char * p.profile.get_columns("a")
    p.set_with_default()
    p.textln(line)
    return [line]


def _qr(p: Escpos, block: Block) -> list[str]:
    align = block.get("align", "center")
    # Native QR codes ignore qr(center=True), so ESC a alignment positions them.
    p.set_with_default(align=align)
    data = block["data"]
    if not data:
        raise ValueError("qr data is empty")
    p.qr(data, size=block.get("size", QR_SIZE), native=True)
    label = data if len(data) <= 32 else data[:29] + "..."
    return [_place(f"[QR: {label}]", align, p.profile.get_columns("a"))]


def _feed(p: Escpos, block: Block) -> list[str]:
    lines = block.get("lines", 1)
    p.ln(lines)
    return [""] * lines


RENDERERS = {"text": _text, "row": _row, "rule": _rule, "qr": _qr, "feed": _feed}


def render(p: Escpos, printout: dict[str, Any]) -> list[str]:
    """Send the printout to p and return its preview lines."""
    if not printout["blocks"]:
        raise ValueError("blocks is empty")
    # Reset modes a previous job may have left behind.
    p.hw("INIT")
    preview = [
        line
        for block in printout["blocks"]
        for line in RENDERERS[block["type"]](p, block)
    ]
    if printout.get("cut", True):
        p.cut(mode="PART")
    return preview


def status() -> None:
    """Report whether the printer is on the USB bus, and its paper level if it is."""
    if usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID) is None:
        print("Not connected: the printer is unplugged or powered off.")
        sys.exit(NOT_CONNECTED)
    printer = Usb(VENDOR_ID, PRODUCT_ID, profile=PROFILE, timeout=USB_TIMEOUT_MS)
    try:
        paper = {PAPER_OUT: "out", PAPER_LOW: "low"}.get(printer.paper_status(), "ok")
    except (EscposError, usb.core.USBError) as e:
        print(f"Connected, but the paper level could not be read: {e}")
        return
    finally:
        printer.close()
    print(f"Connected. Paper: {paper}.")


def print_job() -> None:
    printout = json.load(sys.stdin)
    # Render into memory first so a bad block fails before any paper moves.
    job = Dummy(profile=PROFILE)
    try:
        preview = render(job, printout)
    except (EscposError, ValueError) as e:
        print(f"cannot render printout: {e}", file=sys.stderr)
        sys.exit(2)

    if not printout.get("dry_run"):
        printer = Usb(VENDOR_ID, PRODUCT_ID, profile=PROFILE, timeout=USB_TIMEOUT_MS)
        try:
            paper = printer.paper_status()
            if paper == PAPER_OUT:
                print("printer is out of paper; load a new roll", file=sys.stderr)
                sys.exit(1)
            # python-escpos has no public call for sending a prebuilt job.
            printer._raw(job.output)
            if paper == PAPER_LOW:
                print("paper is running low", file=sys.stderr)
        except (EscposError, usb.core.USBError) as e:
            print(f"printer error: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            printer.close()

    print("\n".join(preview))


if __name__ == "__main__":
    if sys.argv[1:] == ["status"]:
        status()
    else:
        print_job()
