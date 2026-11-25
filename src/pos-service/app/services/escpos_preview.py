"""Turns the ESC/POS bytes made by services/escpos.py into plain-text lines, so tests and developers can SEE a slip.

Understands exactly what the builder emits: ESC @ (init), ESC t (code page), ESC a (align), ESC E (bold), GS ! (size),
GS ( k (QR -> `[QR: data]`), GS v 0 (raster logo -> `[LOGO]`, a rastered text line -> `[TEXT-IMAGE]`), ESC d (feed), GS V (cut -> `--- CUT ---`). Alignment and double
width are applied to a line of `columns` characters; bold and double height are not shown unless `annotate` is set."""
CODEC = {19: "cp858", 16: "cp1252", 0: "cp437"}


def decode(data: bytes, columns: int = 42, annotate: bool = False) -> list[str]:
    out: list[str] = []
    cur = bytearray()
    codec, align, bold, wide, high = "cp437", 0, False, 1, 1
    qr = b""
    i, n = 0, len(data)

    def flush():
        nonlocal cur
        text = bytes(cur).decode(codec, "replace")
        cur = bytearray()
        shown = len(text) * wide
        if shown < columns:
            pad = {0: 0, 1: (columns - shown) // 2, 2: columns - shown}[align]
            text = " " * pad + text
        if annotate and text.strip():
            tags = ("B" if bold else "") + (f"{wide}x{high}" if (wide, high) != (1, 1) else "")
            text += f"   <{tags}>" if tags else ""
        out.append(text.rstrip() if not annotate else text)

    while i < n:
        b = data[i]
        if b == 0x0A:
            flush()
            i += 1
        elif b == 0x1B and i + 1 < n:
            c = data[i + 1]
            if c == 0x40:  # init
                codec, align, bold, wide, high = "cp437", 0, False, 1, 1
                i += 2
            elif c == 0x74:  # ESC t n
                codec = CODEC.get(data[i + 2], "cp437")
                i += 3
            elif c == 0x61:
                align = data[i + 2]
                i += 3
            elif c == 0x45:
                bold = bool(data[i + 2])
                i += 3
            elif c == 0x64:  # ESC d n: feed n lines
                out.extend([""] * data[i + 2])
                i += 3
            else:
                i += 2
        elif b == 0x1D and i + 1 < n:
            c = data[i + 1]
            if c == 0x21:  # GS ! n
                wide, high = (2 if data[i + 2] & 0x10 else 1), (2 if data[i + 2] & 0x01 else 1)
                i += 3
            elif c == 0x56:  # GS V m [n]: cut
                if cur:
                    flush()
                out.append("--- CUT ---")
                i += 4 if data[i + 2] in (65, 66) else 3
            elif c == 0x28 and data[i + 2] == 0x6B:  # GS ( k pL pH cn fn ...
                ln = data[i + 3] + data[i + 4] * 256
                body = data[i + 5:i + 5 + ln]
                if body[:2] == bytes([49, 80]):  # store
                    qr = bytes(body[3:])
                elif body[:2] == bytes([49, 81]):  # print
                    out.append(f"[QR: {qr.decode('utf-8', 'replace')}]")
                i += 5 + ln
            elif c == 0x76 and data[i + 2] == 0x30:  # GS v 0 m xL xH yL yH data
                wb = data[i + 4] + data[i + 5] * 256
                hp = data[i + 6] + data[i + 7] * 256
                out.append("[LOGO]" if hp > 80 else "[TEXT-IMAGE]")  # text lines (Hindi, rupee) are one row high
                i += 8 + wb * hp
            else:
                i += 2
        else:
            cur.append(b)
            i += 1
    if cur:
        flush()
    return out


def preview(data: bytes, columns: int = 42, annotate: bool = False) -> str:
    return "\n".join(decode(data, columns, annotate))
