"""Independent raster oracle using an existing PyMuPDF installation."""
import json
import sys

import pymupdf

with pymupdf.open(stream=sys.stdin.buffer.read(), filetype="pdf") as document:
    red = blue = dark = 0
    white = True
    for page in document:
        pixels = page.get_pixmap(colorspace=pymupdf.csRGB, alpha=False).samples
        red += sum(pixels[i] > 240 and pixels[i + 1] < 15 and pixels[i + 2] < 15
                   for i in range(0, len(pixels), 3))
        blue += sum(pixels[i] < 15 and pixels[i + 1] < 15 and pixels[i + 2] > 240
                    for i in range(0, len(pixels), 3))
        dark += sum(max(pixels[i:i + 3]) < 100 for i in range(0, len(pixels), 3))
        white = white and pixels[:3] == b"\xff\xff\xff"
    print(json.dumps({"pages": len(document), "red": red, "blue": blue,
                      "dark": dark, "paperWhite": white,
                      "decoder": "PyMuPDF " + pymupdf.VersionBind}))
