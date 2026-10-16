"""One-shot, offline U2NetP mask worker. Protocol v1: JSON line followed by mask bytes.

No model acquisition, subprocesses, temporary files or document mutation.
Numerical preprocessing follows the published U-2-Net/rembg recipe; implementation
is independent. Model provenance is configured separately from this source.
"""
import hashlib
import io
import json
import os
import struct
import sys
import time
import warnings

MODEL_SHA256 = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8'
MODEL_BYTES = 4574861
MAX_PIXELS = 16_000_000
MAX_PNG_BYTES = 64 * 1024 * 1024


class WorkerError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def verify_png_end(encoded):
    # Traverse declared chunk lengths; a copied IEND suffix cannot conceal data
    # after an earlier end marker. Pillow verify checks preceding chunk CRCs.
    if encoded[:8] != b'\x89PNG\r\n\x1a\n':
        raise WorkerError('INPUT', 'The PNG input has an invalid signature.')
    offset = 8
    while offset < len(encoded):
        if len(encoded) - offset < 12:
            break
        length = struct.unpack_from('>I', encoded, offset)[0]
        end = offset + length + 12
        if end > len(encoded):
            break
        if encoded[offset + 4:offset + 8] == b'IEND':
            if length == 0 and end == len(encoded) and encoded[offset + 8:end] == b'\xae\x42\x60\x82':
                return
            break
        offset = end
    raise WorkerError('INPUT', 'The PNG input has an invalid ending or trailing data.')


def main():
    started = time.perf_counter()
    operation = sys.argv[1] if len(sys.argv) > 1 else 'invalid'
    try:
        if len(sys.argv) != 5 or operation not in ('probe', 'run') or not os.path.isabs(sys.argv[2]):
            raise WorkerError('INPUT', 'The worker request is invalid.')
        width, height = int(sys.argv[3]), int(sys.argv[4])
        if operation == 'run' and (width < 1 or height < 1 or width * height > MAX_PIXELS):
            raise WorkerError('INPUT', 'Choose an image of at most 16 million pixels.')
        try:
            with open(sys.argv[2], 'rb') as model_file:
                model = model_file.read(MODEL_BYTES + 1)
        except OSError:
            raise WorkerError('MODEL', 'The configured local model could not be read.') from None
        if len(model) != MODEL_BYTES or hashlib.sha256(model).hexdigest() != MODEL_SHA256:
            raise WorkerError('MODEL', 'The local model does not match the approved U2NetP model.')
        try:
            import numpy as np
            import onnxruntime as ort
            from PIL import Image
        except ImportError:
            raise WorkerError('RUNTIME', 'The configured Python needs ONNX Runtime CPU, Pillow and NumPy.') from None
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        source = None
        if operation == 'run':
            encoded = sys.stdin.buffer.read(MAX_PNG_BYTES + 1)
            if len(encoded) > MAX_PNG_BYTES:
                raise WorkerError('INPUT', 'The PNG input exceeds 64 MiB.')
            verify_png_end(encoded)
            try:
                with Image.open(io.BytesIO(encoded), formats=['PNG']) as image:
                    if image.size != (width, height) or getattr(image, 'n_frames', 1) != 1:
                        raise WorkerError('INPUT', 'PNG dimensions or frame count do not match the request.')
                    image.verify()
                with Image.open(io.BytesIO(encoded), formats=['PNG']) as image:
                    source = image.convert('RGBA')
            except WorkerError:
                raise
            except Exception:
                raise WorkerError('INPUT', 'The image is not a valid, bounded single-frame PNG.') from None
            if source.getchannel('A').getextrema()[1] == 0:
                raise WorkerError('INPUT', 'The image is fully transparent; there is no foreground to remove.')
            # Only inference uses white compositing. The caller retains the original RGBA.
            rgb = Image.alpha_composite(Image.new('RGBA', source.size, 'white'), source).convert('RGB')
            if all(low == high for low, high in rgb.getextrema()):
                raise WorkerError('INPUT', 'Background removal does not support a uniform image.')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.log_severity_level = 3
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        # Passing verified bytes prevents path replacement between verification and loading.
        session = ort.InferenceSession(model, sess_options=options, providers=['CPUExecutionProvider'])
        if session.get_providers() != ['CPUExecutionProvider'] or session.get_inputs()[0].shape != [1, 3, 320, 320]:
            raise WorkerError('RUNTIME', 'The local model/runtime input contract is incompatible.')
        metadata = {'model': 'u2netp', 'modelSha256': MODEL_SHA256,
                    'provider': 'CPUExecutionProvider', 'runtimeVersion': ort.__version__}
        response = {'version': 1, 'operation': operation, 'ok': True, 'metadata': metadata}
        payload = b''
        if operation == 'run':
            pixels = np.asarray(rgb.resize((320, 320), Image.Resampling.LANCZOS), dtype=np.float64)
            pixels /= max(float(pixels.max()), 1e-6)
            pixels = (pixels - np.array([.485, .456, .406])) / np.array([.229, .224, .225])
            tensor = np.ascontiguousarray(pixels.transpose(2, 0, 1)[None], dtype=np.float32)
            prediction = session.run([session.get_outputs()[0].name], {session.get_inputs()[0].name: tensor})[0][0, 0]
            minimum, maximum = float(prediction.min()), float(prediction.max())
            if not np.isfinite(prediction).all() or maximum - minimum <= 1e-8:
                raise WorkerError('RUNTIME', 'The local model returned an unusable mask.')
            normalized = (prediction - minimum) / (maximum - minimum)
            mask = Image.fromarray((normalized * 255).astype(np.uint8)).resize((width, height), Image.Resampling.LANCZOS)
            payload = mask.tobytes()
            metadata.update({'rawMin': minimum, 'rawMax': maximum, 'elapsedMs': (time.perf_counter() - started) * 1000})
            response.update({'width': width, 'height': height})
        sys.stdout.buffer.write(json.dumps(response, separators=(',', ':')).encode('ascii') + b'\n' + payload)
        sys.stdout.buffer.flush()
        return 0
    except WorkerError as error:
        response = {'version': 1, 'operation': operation, 'ok': False, 'code': error.code, 'message': error.message}
    except Exception:
        response = {'version': 1, 'operation': operation, 'ok': False, 'code': 'RUNTIME', 'message': 'The configured local inference runtime failed.'}
    sys.stdout.write(json.dumps(response, separators=(',', ':')) + '\n')
    sys.stdout.flush()
    return 1


if __name__ == '__main__':
    sys.exit(main())
