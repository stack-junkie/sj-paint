"""Independent metadata fixtures and export inspection using installed Pillow."""
import base64
import io
import json
import sys
from PIL import Image, TiffImagePlugin, __version__

if len(sys.argv) > 1 and sys.argv[1] == "inspect":
    with Image.open(io.BytesIO(sys.stdin.buffer.read())) as image:
        image.load()
        exif = image.getexif()
        print(json.dumps({"decoder": "Pillow " + __version__, "size": image.size,
                          "dpi": [float(value) for value in image.info["dpi"]] if "dpi" in image.info else None,
                          "exif": {str(tag): float(exif[tag]) for tag in [282, 283, 296] if tag in exif},
                          "rgba": base64.b64encode(image.convert("RGBA").tobytes()).decode("ascii")}))
else:
    image = Image.new("RGB", (3, 2))
    image.putdata([(11, 41, 79), (151, 83, 27), (22, 222, 7), (90, 80, 70), (200, 100, 3), (30, 40, 50)])
    fixtures = {}
    for fmt in ["PNG", "JPEG", "BMP", "TIFF"]:
        output = io.BytesIO()
        image.save(output, format=fmt, dpi=(300, 150))
        fixtures[fmt.lower()] = base64.b64encode(output.getvalue()).decode("ascii")
    for orientation in [1, 5, 6, 7, 8]:
        output = io.BytesIO()
        tags = TiffImagePlugin.ImageFileDirectory_v2()
        tags[282], tags[283], tags[296], tags[274] = 120, 60, 3, orientation
        image.save(output, format="TIFF", tiffinfo=tags)
        fixtures[f"tiff-cm-{orientation}"] = base64.b64encode(output.getvalue()).decode("ascii")
        output = io.BytesIO()
        exif = Image.Exif()
        exif[282], exif[283], exif[296], exif[274] = 120, 60, 3, orientation
        image.save(output, format="JPEG", exif=exif)
        fixtures[f"jpeg-cm-{orientation}"] = base64.b64encode(output.getvalue()).decode("ascii")
    print(json.dumps(fixtures))
