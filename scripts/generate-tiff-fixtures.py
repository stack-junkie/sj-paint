"""Regenerate original single-channel TIFF fixtures with installed Pillow/libtiff.

No Microsoft/private samples or third-party implementation source is included.
The application tests consume the resulting JSON without requiring Python.
"""
import base64
import hashlib
import io
import json
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
    with Image.open(io.BytesIO(encoded)) as decoded:
        stored = {"width": decoded.width, "height": decoded.height,
                  "photometric": decoded.tag_v2[262], "compression": decoded.tag_v2[259],
                  "predictor": decoded.tag_v2.get(317, 1), "orientation": decoded.tag_v2[274],
                  "strips": len(decoded.tag_v2[273])}
        assert stored["strips"] > 1
        assert decoded.tag_v2[258] == (8,)
        assert stored["photometric"] == photo and stored["predictor"] == predictor
        # Pillow loads TIFF orientation itself. Capture dimensions after load.
        decoded.load()
        rgba = decoded.convert("RGBA").tobytes()
        fixtures.append({"name": name, "stored": stored,
                         "width": decoded.width, "height": decoded.height,
                         "encodedSha256": digest(encoded), "rgbaSha256": digest(rgba),
                         "encodedBase64": base64.b64encode(encoded).decode("ascii"),
                         "rgbaBase64": base64.b64encode(rgba).decode("ascii")})

result = {"provenance": {"pillow": PIL.__version__, "libtiff": features.version("libtiff"),
                         "generatorSha256": digest(Path(__file__).read_bytes()),
                         "description": "Original generated pixels, encoded and independently decoded by Pillow. TIFF ColorMap uses high-byte RGBA8 conversion; no color-management claim."},
          "fixtures": fixtures}
destination = Path(__file__).parent / "fixtures" / "tiff-single-channel.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"path": str(destination), "fixtures": len(fixtures), "provenance": result["provenance"]}))
