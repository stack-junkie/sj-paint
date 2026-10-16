"""Regenerate original single-channel TIFF fixtures with installed Pillow/libtiff.

No Microsoft/private samples or third-party implementation source is included.
The application tests consume the resulting JSON without requiring Python.
"""
import base64
import hashlib
import io
import json
import struct
import zlib
from pathlib import Path

import PIL
from PIL import Image, features


def digest(data):
    return hashlib.sha256(data).hexdigest()


cases = [
    ("gray-black-packbits", "L", 1, "packbits", 1, 1),
    ("gray-white-lzw", "L", 0, "tiff_lzw", 2, 6),
    ("gray-black-deflate", "L", 1, "tiff_adobe_deflate", 2, 8),
    ("palette-raw", "P", 3, "raw", 1, 2),
    ("palette-lzw", "P", 3, "tiff_lzw", 2, 5),
    ("palette-deflate", "P", 3, "tiff_adobe_deflate", 2, 7),
]
fixtures = []


def capture(name, encoded, encoder):
    with Image.open(io.BytesIO(encoded)) as decoded:
        stored = {"width": decoded.width, "height": decoded.height,
                  "bits": decoded.tag_v2.get(258, (1,))[0],
                  "bitsTagPresent": 258 in decoded.tag_v2,
                  "photometric": decoded.tag_v2[262], "compression": decoded.tag_v2[259],
                  "predictor": decoded.tag_v2.get(317, 1), "orientation": decoded.tag_v2.get(274, 1),
                  "strips": len(decoded.tag_v2[273]), "encoder": encoder}
        # Pillow loads TIFF orientation itself. Capture dimensions after load.
        decoded.load()
        rgba = decoded.convert("RGBA").tobytes()
        fixtures.append({"name": name, "stored": stored,
                         "width": decoded.width, "height": decoded.height,
                         "encodedSha256": digest(encoded), "rgbaSha256": digest(rgba),
                         "encodedBase64": base64.b64encode(encoded).decode("ascii"),
                         "rgbaBase64": base64.b64encode(rgba).decode("ascii")})
    return stored


for name, mode, photo, compression, predictor, orientation in cases:
    width, height = (17, 17) if name == "palette-raw" else (5, 7)
    samples = bytes((index * 37) & 255 for index in range(width * height))
    image = Image.frombytes(mode, (width, height), samples)
    if mode == "P":
        image.putpalette(bytes(channel for index in range(256)
                               for channel in (index, 255 - index, (index * 13) & 255)))
    tags = {262: photo, 274: orientation, 278: 2}
    if predictor == 2:
        tags[317] = predictor
    stream = io.BytesIO()
    image.save(stream, format="TIFF", compression=compression, tiffinfo=tags)
    encoded = stream.getvalue()
    stored = capture(name, encoded, "Pillow")
    assert stored["strips"] > 1 and stored["bits"] == 8
    assert stored["photometric"] == photo and stored["predictor"] == predictor


# Pillow's ordinary P writer emits 8 bits even when lower depths are requested.
# Produce packed byte layout from TIFF 6.0 sections 2/8/9 here, independently of
# the JavaScript codec; Pillow remains the independent decoder/pixel oracle.
def packed_fixture(bits, photo, compression, little, orientation):
    width, height, rows_per_strip = 7, 5, 2
    levels = 2 ** bits
    rows = []
    for y in range(height):
        row = bytearray([255] * ((width * bits + 7) // 8))
        for x in range(width):
            value, shift, offset = (y * width + x) % levels, 8 - bits - x * bits % 8, x * bits // 8
            row[offset] = (row[offset] & ~((levels - 1) << shift)) | value << shift
        rows.append(bytes(row))
    strips = [b"".join(rows[y:y + rows_per_strip]) for y in range(0, height, rows_per_strip)]
    if compression == 8:
        strips = [zlib.compress(strip) for strip in strips]
    tags = {256: (4, [width]), 257: (4, [height]), 258: (3, [bits]), 259: (3, [compression]),
            262: (3, [photo]), 273: (4, [0] * len(strips)), 274: (3, [orientation]),
            277: (3, [1]), 278: (4, [rows_per_strip]), 279: (4, list(map(len, strips))),
            284: (3, [1]), 317: (3, [1])}
    if photo == 3:
        tags[320] = (3, [((i * 43) & 255) * 256 + 127 for i in range(levels * 3)])
    endian = "<" if little else ">"
    pack = lambda fmt, *values: struct.pack(endian + fmt, *values)
    directory_end = 8 + 2 + len(tags) * 12 + 4
    sizes = {3: 2, 4: 4}
    payload_start = directory_end + sum(len(values) * sizes[kind] for kind, values in tags.values() if len(values) * sizes[kind] > 4)
    position = payload_start
    for index, strip in enumerate(strips):
        tags[273][1][index] = position
        position += len(strip)
    entries, extra = [], bytearray()
    for tag, (kind, values) in sorted(tags.items()):
        data = pack(("H" if kind == 3 else "I") * len(values), *values)
        if len(data) > 4:
            value = pack("I", directory_end + len(extra))
            extra.extend(data)
        else:
            value = data.ljust(4, b"\0")
        entries.append(pack("HHI", tag, kind, len(values)) + value)
    return (b"II" if little else b"MM") + pack("HIH", 42, 8, len(tags)) + b"".join(entries) + b"\0" * 4 + bytes(extra) + b"".join(strips)


for bits in (1, 2, 4):
    for photo in (0, 1, 3):
        for compression in (1, 8):
            name = f"packed-{bits}-{'palette' if photo == 3 else 'white' if photo == 0 else 'black'}-{'raw' if compression == 1 else 'deflate'}"
            orientation = (bits + photo + compression) % 8 + 1
            encoded = packed_fixture(bits, photo, compression, little=compression == 1, orientation=orientation)
            stored = capture(name, encoded, "Specification-based Python layout; zlib for Deflate")
            assert stored["bits"] == bits and stored["strips"] == 3 and stored["predictor"] == 1

for compression in ("raw", "packbits", "tiff_lzw", "tiff_adobe_deflate"):
    image = Image.new("1", (7, 5))
    image.putdata([index % 2 for index in range(35)])
    stream = io.BytesIO()
    image.save(stream, format="TIFF", compression=compression, tiffinfo={278: 2})
    stored = capture(f"pillow-bilevel-{compression}", stream.getvalue(), "Pillow")
    assert stored["bits"] == 1
    if compression == "raw":
        assert not stored["bitsTagPresent"]

result = {"provenance": {"pillow": PIL.__version__, "libtiff": features.version("libtiff"),
                         "generatorSha256": digest(Path(__file__).read_bytes()),
                         "description": "Original generated pixels. Encoder provenance is per fixture; every expected RGBA buffer is independently decoded by Pillow. TIFF ColorMap uses high-byte RGBA8 conversion; no color-management or Microsoft Paint parity claim."},
          "fixtures": fixtures}
destination = Path(__file__).parent / "fixtures" / "tiff-single-channel.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"path": str(destination), "fixtures": len(fixtures), "provenance": result["provenance"]}))
