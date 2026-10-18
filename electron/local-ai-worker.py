"""Offline image worker. Protocol v2: bounded JSON line and sized binary payload.

No model acquisition, subprocesses, temporary files or document mutation.
Numerical preprocessing follows the published U-2-Net/rembg recipe; implementation
is independent. Model provenance is configured separately from this source.
"""
import hashlib
import io
import json
import os
import re
import struct
import sys
import time
import warnings

MODEL_SHA256 = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8'
MODEL_BYTES = 4574861
BACKGROUND_MODELS = {'u2netp': (MODEL_BYTES, MODEL_SHA256), 'u2net': (175997641, '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491')}
REMOVAL_MODEL = 'migan'
REMOVAL_SPEC = (28079181, '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b')
REMOVAL_MARGIN = 1 + 2  # Upstream keep-mask max-pool radius plus Gaussian radius.
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



SELECTION_MAX_SIDE = 1024
SELECTION_MAX_PNG_BYTES = 8 * 1024 * 1024
SELECTION_MODELS = [('encoder', 24799761, '84ed466ffcc5c1f8d08409bc34a23bb364ab2c15e402cb12d4335a42be0e0951'), ('decoder', 16565728, 'a62f8fa5ea080447c0689418d69e58f1e83e0b7adf9c142e2bd9bcc8045c0b11')]
MAX_HEADER_BYTES = 4096


def checked_model(filename, size, digest):
    if not os.path.isabs(filename):
        raise WorkerError('MODEL', 'The configured model path must be absolute.')
    try:
        with open(filename, 'rb') as source:
            data = source.read(size + 1)
    except OSError:
        raise WorkerError('MODEL', 'The configured local model could not be read.') from None
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise WorkerError('MODEL', 'The local model does not match the approved model.')
    return data


def png_source(encoded, width, height, selection):
    limit = SELECTION_MAX_PNG_BYTES if selection else MAX_PNG_BYTES
    if type(width) is not int or type(height) is not int or width < 1 or height < 1 or width * height > MAX_PIXELS or (selection and max(width, height) > SELECTION_MAX_SIDE) or len(encoded) > limit:
        raise WorkerError('INPUT', 'The image exceeds the local operation bounds.')
    verify_png_end(encoded)
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    warnings.simplefilter('error', Image.DecompressionBombWarning)
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
    return source


def png_rgb(encoded, width, height, selection):
    from PIL import Image
    source = png_source(encoded, width, height, selection)
    if source.getchannel('A').getextrema()[1] == 0:
        raise WorkerError('INPUT', 'The image is fully transparent.')
    rgb = Image.alpha_composite(Image.new('RGBA', source.size, 'white'), source).convert('RGB')
    if all(low == high for low, high in rgb.getextrema()):
        raise WorkerError('INPUT', ('Object selection' if selection else 'Background removal') + ' does not support a uniform image.')
    return rgb, source


def removal_inputs(request, payload):
    width, height = request.get('width'), request.get('height')
    token, seed = request.get('targetToken'), request.get('seed')
    lengths = (request.get('sourceLength'), request.get('maskLength'))
    if (request.get('mode') != 'erase' or request.get('prompt', '') != '' or request.get('negativePrompt', '') != ''
            or any(type(value) is not int or value < 64 or value > 1024 or value % 8 for value in (width, height))
            or type(seed) is not int or not 0 <= seed <= 0xffffffff
            or not isinstance(token, str) or re.fullmatch(r'[A-Za-z0-9_-]{1,80}', token) is None
            or any(type(value) is not int or not 33 <= value <= SELECTION_MAX_PNG_BYTES for value in lengths)
            or sum(lengths) != len(payload)):
        raise WorkerError('INPUT', 'Erase requires bounded source and mask PNGs and no prompt.')
    source = png_source(payload[:lengths[0]], width, height, True)
    mask = png_source(payload[lengths[0]:], width, height, True).convert('L')
    if mask.getextrema()[1] == 0 or mask.getextrema()[0] > 0:
        raise WorkerError('INPUT', 'Select an object while leaving surrounding context for removal.')
    return source, mask


def remove_object(session, source, mask, np, Image):
    from PIL import ImageFilter
    # The upstream graph dilates the keep-mask by one pixel then blurs with a
    # five-pixel kernel. Its original-image contribution must end before the
    # original selection begins. Final document ownership stays fractional.
    model_mask = mask.point(lambda value: 255 if value else 0).filter(ImageFilter.MaxFilter(2 * REMOVAL_MARGIN + 1))
    rgb = Image.alpha_composite(Image.new('RGBA', source.size, 'white'), source).convert('RGB')
    tensor = np.ascontiguousarray(np.asarray(rgb).transpose(2, 0, 1)[None])
    keep = np.ascontiguousarray((255 - np.asarray(model_mask))[None, None])
    values = session.run(None, {'image': tensor, 'mask': keep})
    if (len(values) != 1 or values[0].dtype != np.uint8
            or values[0].shape != (1, 3, source.height, source.width)):
        raise WorkerError('RUNTIME', 'The removal model returned an invalid image.')
    generated = Image.fromarray(values[0][0].transpose(1, 2, 0)).convert('RGBA')
    generated.putalpha(source.getchannel('A'))
    result = Image.composite(generated, source, mask)
    output = io.BytesIO()
    result.save(output, format='PNG')
    encoded = output.getvalue()
    if len(encoded) > SELECTION_MAX_PNG_BYTES:
        raise WorkerError('RUNTIME', 'The removal result exceeds the PNG output bound.')
    return encoded


def flat_drawing_matte(rgb, np, Image):
    """Conservative uniform-paper correction, never a general photograph matte.

    Exact flat-color support is required within the foreground as well as the
    border. This rejects a mostly white photograph with a textured small subject.
    Four-connected paper is removed; enclosed white interiors remain opaque.
    Antialias alpha is estimated only along connected paper edges. The consumer
    must unmix partial edge RGB against paperRgb before multiplying source alpha.
    """
    sample = np.asarray(rgb.resize((min(256, rgb.width), min(256, rgb.height)), Image.Resampling.NEAREST), dtype=np.uint8)
    border = np.concatenate((sample[0], sample[-1], sample[:, 0], sample[:, -1]))
    colors, counts = np.unique(border, axis=0, return_counts=True)
    background = colors[int(counts.argmax())]
    border_match = np.max(np.abs(border.astype(np.int16) - background), axis=1) <= 2
    border_fraction = float(border_match.mean())
    if border_fraction < .995:
        return None
    foreground = sample[np.max(np.abs(sample.astype(np.int16) - background), axis=2) > 2]
    if len(foreground) < 4:
        return None
    _, counts = np.unique(foreground, axis=0, return_counts=True)
    foreground_color_count = len(counts)
    flat_fraction = float(np.sort(counts)[-8:].sum() / len(foreground))
    colors, counts = np.unique(sample.reshape(-1, 3), axis=0, return_counts=True)
    palette = colors[np.argsort(counts)[-8:]]
    flat_pixels = np.zeros(sample.shape[:2], dtype=bool)
    for color in palette:
        flat_pixels |= np.all(sample == color, axis=2)
    # Antialias transitions belong near flat-color regions, not throughout a
    # textured subject or a broad soft gradient. Two sampled pixels cover the
    # narrow transition of the editor's antialiased drawing edges.
    from PIL import ImageFilter
    supported = np.asarray(Image.fromarray(flat_pixels.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))) > 0
    foreground_pixels = np.max(np.abs(sample.astype(np.int16) - background), axis=2) > 2
    edge_support = float(supported[foreground_pixels].mean())
    if flat_fraction < .90 and edge_support < .995:
        return None
    # Scanline flood fill avoids a tuple/set for every pixel. Each queued span is
    # marked immediately, bounding work and storage by the existing pixel limit.
    from collections import deque
    pixels = np.asarray(rgb, dtype=np.uint8)
    available = np.max(np.abs(pixels.astype(np.int16) - background), axis=2) <= 2
    removed = np.zeros(available.shape, dtype=bool)
    height, width = available.shape
    queue = deque()

    def span(x, y):
        if not available[y, x]:
            return x + 1
        left, right = x, x + 1
        while left > 0 and available[y, left - 1]:
            left -= 1
        while right < width and available[y, right]:
            right += 1
        available[y, left:right] = False
        removed[y, left:right] = True
        queue.append((left, right, y))
        return right

    for y in (0, height - 1):
        x = 0
        while x < width:
            x = span(x, y)
    for y in range(1, height - 1):
        span(0, y); span(width - 1, y)
    while queue:
        left, right, y = queue.popleft()
        for adjacent in (y - 1, y + 1):
            if 0 <= adjacent < height:
                x = left
                while x < right:
                    x = span(x, adjacent)
    matte = np.where(removed, 0, 255).astype(np.uint8)
    # Keep distinct ink directions from the paper color. A black outline must
    # not hide a less frequent blue/gray thin stroke in a frequency-only palette.
    distances = np.sum((colors.astype(np.float32) - background) ** 2, axis=1)
    anchors = []
    for color in colors[np.argsort(distances)[::-1]]:
        vector = color.astype(np.float32) - background
        if np.max(np.abs(vector)) <= 2:
            continue
        transitional = False
        for other in anchors:
            factor = float(np.dot(vector, other) / np.dot(other, other))
            if 0 < factor <= 1 and float(np.max(np.abs(vector - factor * other))) <= 3:
                transitional = True
                break
        if not transitional:
            anchors.append(vector)
            if len(anchors) > 32:
                return None  # Too many independent shades for conservative flat art.
    near_paper = np.asarray(Image.fromarray(removed.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))) > 0
    edge = near_paper & ~removed
    edge_colors = pixels[edge].astype(np.float32) - background
    best_error = np.full(len(edge_colors), np.inf, dtype=np.float32)
    best_alpha = np.ones(len(edge_colors), dtype=np.float32)
    for vector in sorted(anchors, key=lambda value: float(np.dot(value, value)), reverse=True):
        alpha = np.clip((edge_colors @ vector) / np.dot(vector, vector), 0, 1)
        residual = np.max(np.abs(edge_colors - alpha[:, None] * vector), axis=1)
        # Within 8-bit rounding tolerance, prefer the farthest supported ink,
        # rather than overfitting an intermediate shade as an opaque color.
        better = np.isinf(best_error) & (residual <= 3)
        best_error[better] = residual[better]
        best_alpha[better] = alpha[better]
    # Already discrete artwork needs only paper removal. Treating an intentional
    # gray ink as a mixture of black ink and paper would change opaque pixels.
    if foreground_color_count > 8:
        matte[edge] = np.maximum(1, np.rint(best_alpha * 255)).astype(np.uint8)
    return Image.fromarray(matte), {
        'method': 'flat-drawing-border-flood', 'paperRgb': background.tolist(), 'unmixEdges': True,
        'borderAgreement': border_fraction, 'foregroundFlatColorFraction': flat_fraction,
        'antialiasEdgeSupport': edge_support,
        'connectivity': 4, 'preservesEnclosedInteriors': True}


class Inference:
    def __init__(self, feature, paths):
        self.feature, self.paths = feature, paths
        self.sessions, self.embedding, self.size = None, None, None

    def initialize(self):
        if self.sessions is not None:
            return
        try:
            import numpy as np
            import onnxruntime as ort
            from PIL import Image
        except ImportError:
            raise WorkerError('RUNTIME', 'The configured Python needs ONNX Runtime CPU, Pillow and NumPy.') from None
        self.np, self.Image = np, Image
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1 if self.feature == REMOVAL_MODEL else 2
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.log_severity_level = 3
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        specs = [('model', *REMOVAL_SPEC)] if self.feature == REMOVAL_MODEL else [('model', *BACKGROUND_MODELS[self.feature])] if self.feature in BACKGROUND_MODELS else SELECTION_MODELS
        self.sessions = {}
        for (name, size, digest), filename in zip(specs, self.paths):
            data = checked_model(filename, size, digest)
            session = ort.InferenceSession(data, sess_options=options, providers=['CPUExecutionProvider'])
            del data
            if session.get_providers() != ['CPUExecutionProvider']:
                raise WorkerError('RUNTIME', 'The local runtime must use the CPU provider.')
            self.sessions[name] = session
        self.metadata = {'model': self.feature, 'provider': 'CPUExecutionProvider', 'runtimeVersion': ort.__version__}
        if self.feature == REMOVAL_MODEL:
            session = self.sessions['model']
            if ([(value.name, value.type) for value in session.get_inputs()] != [('image', 'tensor(uint8)'), ('mask', 'tensor(uint8)')]
                    or len(session.get_outputs()) != 1 or session.get_outputs()[0].type != 'tensor(uint8)'):
                raise WorkerError('RUNTIME', 'The removal model/runtime contract is incompatible.')
            self.metadata['modelSha256'] = REMOVAL_SPEC[1]
        elif self.feature in BACKGROUND_MODELS:
            session = self.sessions['model']
            if len(session.get_inputs()) != 1 or session.get_inputs()[0].type != 'tensor(float)' or session.get_inputs()[0].shape != [1, 3, 320, 320]:
                raise WorkerError('RUNTIME', 'The local model/runtime input contract is incompatible.')
            self.metadata['modelSha256'] = BACKGROUND_MODELS[self.feature][1]
        else:
            encoder, decoder = self.sessions['encoder'], self.sessions['decoder']
            if [(x.name, x.type) for x in encoder.get_inputs()] != [('batched_images', 'tensor(float)')] or [(x.name, x.type) for x in decoder.get_inputs()] != [('image_embeddings', 'tensor(float)'), ('batched_point_coords', 'tensor(float)'), ('batched_point_labels', 'tensor(float)'), ('orig_im_size', 'tensor(int64)')] or len(encoder.get_outputs()) != 1 or len(decoder.get_outputs()) != 3:
                raise WorkerError('RUNTIME', 'The selection model/runtime contract is incompatible.')
            self.metadata.update({'encoderSha256': SELECTION_MODELS[0][2], 'decoderSha256': SELECTION_MODELS[1][2]})

    def execute(self, request, payload):
        started = time.perf_counter()
        operation = request['operation']
        removal = removal_inputs(request, payload) if self.feature == REMOVAL_MODEL and operation == 'generate' else None
        self.initialize()
        np, Image = self.np, self.Image
        extra = {}; result = b''
        if removal is not None:
            source, mask = removal
            result = remove_object(self.sessions['model'], source, mask, np, Image)
            extra.update(width=source.width, height=source.height, targetToken=request['targetToken'], mode='erase', seed=request['seed'])
        elif operation in ('run', 'cutout', 'prepare'):
            if self.embedding is not None:
                raise WorkerError('INPUT', 'Release the current image before preparing another.')
            width, height = request.get('width'), request.get('height')
            rgb, source = png_rgb(payload, width, height, operation in ('prepare', 'cutout'))
            extra.update({'width': width, 'height': height})
            if operation in ('run', 'cutout'):
                # Existing-alpha sources stay on the model path. Compositing
                # their RGB onto white does not justify opaque-paper unmixing.
                drawing = flat_drawing_matte(rgb, np, Image) if source.getchannel('A').getextrema() == (255, 255) else None
                if drawing is not None:
                    matte, extra['matte'] = drawing
                    extra['modelExecuted'] = False
                else:
                    pixels = np.asarray(rgb.resize((320, 320), Image.Resampling.LANCZOS), dtype=np.float64)
                    pixels /= max(float(pixels.max()), 1e-6)
                    pixels = (pixels - np.array([.485, .456, .406])) / np.array([.229, .224, .225])
                    tensor = np.ascontiguousarray(pixels.transpose(2, 0, 1)[None], dtype=np.float32)
                    session = self.sessions['model']
                    prediction = session.run([session.get_outputs()[0].name], {session.get_inputs()[0].name: tensor})[0][0, 0]
                    minimum, maximum = float(prediction.min()), float(prediction.max())
                    if not np.isfinite(prediction).all() or maximum - minimum <= 1e-8:
                        raise WorkerError('RUNTIME', 'The local model returned an unusable mask.')
                    normalized = (prediction - minimum) / (maximum - minimum)
                    # Alpha is coverage: negative-lobe interpolation can create
                    # detached faint streaks outside the predicted foreground.
                    # Bilinear preserves local range without discarding real
                    # low-alpha ink or disconnected subject parts.
                    matte = Image.fromarray((normalized * 255).astype(np.uint8)).resize((width, height), Image.Resampling.BILINEAR)
                    extra['matte'] = {'method': 'model-saliency'}
                    extra['modelExecuted'] = True
                if operation == 'cutout':
                    from PIL import ImageChops
                    cutout = source.copy()
                    if drawing is not None:
                        rgba = np.asarray(cutout).copy()
                        alpha = np.asarray(matte, dtype=np.float32) / 255
                        partial = (alpha > 0) & (alpha < 1)
                        paper = np.asarray(extra['matte']['paperRgb'], dtype=np.float32)
                        rgba[partial, :3] = np.clip(np.rint((rgba[partial, :3] - (1-alpha[partial, None])*paper) / alpha[partial, None]), 0, 255).astype(np.uint8)
                        cutout = Image.fromarray(rgba)
                    cutout.putalpha(ImageChops.multiply(cutout.getchannel('A'), matte))
                    output = io.BytesIO()
                    cutout.save(output, format='PNG')
                    result = output.getvalue()
                    if len(result) > SELECTION_MAX_PNG_BYTES:
                        raise WorkerError('RUNTIME', 'The sticker PNG exceeds the output bound.')
                else:
                    result = matte.tobytes()
                if extra['modelExecuted']:
                    extra['range'] = {'rawMin': minimum, 'rawMax': maximum}
            else:
                tensor = np.asarray(rgb, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
                embedding = self.sessions['encoder'].run(None, {'batched_images': tensor})[0]
                if embedding.shape != (1, 256, 64, 64) or embedding.dtype != np.float32 or not np.isfinite(embedding).all():
                    raise WorkerError('RUNTIME', 'The model returned an invalid image embedding.')
                self.embedding, self.size = embedding, (width, height)
        elif operation == 'select':
            if self.embedding is None:
                raise WorkerError('INPUT', 'Prepare an image before selecting an object.')
            width, height = self.size
            coords, labels = request.get('coords'), request.get('labels')
            if not isinstance(coords, list) or not isinstance(labels, list) or not 1 <= len(coords) <= 6 or len(coords) != len(labels):
                raise WorkerError('INPUT', 'Use one to six prompt slots.')
            for point, label in zip(coords, labels):
                if not isinstance(point, list) or len(point) != 2 or type(label) is not int or label not in (0, 1, 2, 3) or any(type(v) not in (int, float) or not np.isfinite(v) for v in point) or not (0 <= point[0] < width and 0 <= point[1] < height):
                    raise WorkerError('INPUT', 'Selection prompts must be valid image coordinates.')
            boxes = [(point, label) for point, label in zip(coords, labels) if label in (2, 3)]
            if boxes and (len(boxes) != 2 or [v[1] for v in boxes] != [2, 3] or not (boxes[0][0][0] < boxes[1][0][0] and boxes[0][0][1] < boxes[1][0][1])):
                raise WorkerError('INPUT', 'Provide ordered nonempty rectangle corners.')
            included = [(point, label) for point, label in zip(coords, labels) if label != 0]
            excluded = [point for point, label in zip(coords, labels) if label == 0]
            if not included:
                raise WorkerError('INPUT', 'Include a foreground point or rectangle before excluding an object.')

            def decode(query_coords, query_labels):
                values = self.sessions['decoder'].run(None, {'image_embeddings': self.embedding,
                    'batched_point_coords': np.asarray([[query_coords]], dtype=np.float32),
                    'batched_point_labels': np.asarray([[query_labels]], dtype=np.float32),
                    'orig_im_size': np.asarray([height, width], dtype=np.int64)})
                logits, scores, lowres = values
                if logits.shape != (1, 1, 3, height, width) or scores.shape != (1, 1, 3) or lowres.shape != (1, 3, 256, 256) or not all(np.isfinite(value).all() for value in values):
                    raise WorkerError('RUNTIME', 'The model returned invalid selection masks.')
                selected = int(np.argmax(scores[0, 0]))
                return logits[0, 0] >= 0, scores[0, 0].tolist(), selected

            candidates, scores, selected = decode([value[0] for value in included], [value[1] for value in included])
            # EfficientSAM encodes labels 1/2/3, not SAM's background label 0.
            # Exclusion is explicit object-mask subtraction using the same cached
            # embedding. Any overlap with an excluded object's mask is removed.
            exclusion_scores = []
            for point in excluded:
                excluded_masks, candidate_scores, candidate = decode([point], [1])
                candidates &= ~excluded_masks[candidate]
                exclusion_scores.append({'scores': candidate_scores, 'selectedCandidate': candidate})
            # Keep the model's three bounded alternatives in their original order.
            # Confidence selects the default; the user may preview another mask.
            result = candidates.astype(np.uint8).tobytes()
            # Return a binary selection mask, not opacity or a confidence probability.
            extra.update({'width': width, 'height': height, 'selectedCandidate': selected, 'scores': scores})
            if excluded:
                extra['refinement'] = {'method': 'object-mask-subtraction', 'excludedObjects': len(excluded),
                    'empty': not bool(candidates[selected].any()), 'candidates': exclusion_scores}
        metadata = {**self.metadata, **extra.pop('range', {}), 'elapsedMs': (time.perf_counter() - started) * 1000}
        if removal is not None:
            metadata['conditioningMargin'] = REMOVAL_MARGIN
        if 'matte' in extra:
            metadata['matte'] = extra.pop('matte')
            metadata['modelExecuted'] = extra.pop('modelExecuted')
        if 'refinement' in extra:
            metadata['refinement'] = extra.pop('refinement')
        return {**extra, 'metadata': metadata}, result


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in (*BACKGROUND_MODELS, 'efficientsam-ti', REMOVAL_MODEL) or len(sys.argv) != (4 if sys.argv[1] == 'efficientsam-ti' else 3):
        return 1
    feature = sys.argv[1]
    inference = Inference(feature, sys.argv[2:])
    previous_id = 0
    while True:
        line = sys.stdin.buffer.readline(MAX_HEADER_BYTES + 1)
        if not line:
            return 0
        request = None
        try:
            if len(line) > MAX_HEADER_BYTES or not line.endswith(b'\n'):
                return 1
            request = json.loads(line)
            operations = ('probe', 'generate') if feature == REMOVAL_MODEL else ('probe', 'run', 'cutout') if feature in BACKGROUND_MODELS else ('probe', 'prepare', 'select')
            if not isinstance(request, dict) or request.get('version') != 2 or type(request.get('id')) is not int or request['id'] <= previous_id or request.get('operation') not in operations:
                return 1
            previous_id = request['id']
            count = request.get('payloadLength')
            limit = 2 * SELECTION_MAX_PNG_BYTES if feature == REMOVAL_MODEL else MAX_PNG_BYTES if feature in BACKGROUND_MODELS and request['operation'] != 'cutout' else SELECTION_MAX_PNG_BYTES
            if type(count) is not int or count < 0 or count > limit or (request['operation'] in ('probe', 'select') and count != 0):
                return 1
            payload = sys.stdin.buffer.read(count)
            if len(payload) != count:
                return 1
            values, result = inference.execute(request, payload)
            response = {'ok': True, **values}
        except WorkerError as error:
            response, result = {'ok': False, 'code': error.code, 'message': error.message}, b''
        except Exception:
            response, result = {'ok': False, 'code': 'RUNTIME', 'message': 'The configured local inference runtime failed.'}, b''
        if request is None:
            return 1
        response.update({'version': 2, 'id': request['id'], 'operation': request['operation'], 'payloadLength': len(result)})
        sys.stdout.buffer.write(json.dumps(response, separators=(',', ':'), allow_nan=False).encode('ascii') + b'\n' + result)
        sys.stdout.buffer.flush()
        del payload, result
        if not response['ok']:
            # Wait for the parent to close the process, preserving response/close ordering.
            sys.stdin.buffer.read(1)
            return 1


if __name__ == '__main__':
    sys.exit(main())
