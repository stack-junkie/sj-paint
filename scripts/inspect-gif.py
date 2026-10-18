"""Independent GIF decoding through an already installed Pillow, no setup."""
import base64
import io
import json
import sys
from PIL import Image, __version__

with Image.open(io.BytesIO(sys.stdin.buffer.read())) as image:
    image.load()
    print(json.dumps({"decoder": "Pillow " + __version__, "format": image.format,
                      "width": image.width, "height": image.height, "frames": image.n_frames,
                      "rgba": base64.b64encode(image.convert("RGBA").tobytes()).decode("ascii")}))
