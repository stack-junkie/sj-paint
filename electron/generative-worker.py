"""Offline SDXL worker, one process owns one pipeline until its parent releases it.

Stdout is exclusively bounded protocol v2. Model acquisition and document edits
belong to the main process and editor respectively. Cancellation kills this owned
process, including CPU offload state; no child processes are started here.
"""
import io
import hashlib
from contextlib import contextmanager, nullcontext
from types import SimpleNamespace
from collections.abc import Mapping
import json
import math
import os
import re
import struct
import sys
import time

MAX_HEADER = 4096
MAX_PNG = 8 * 1024 * 1024
BASE_REVISION = '462165984030d82259a11f4367a4eed129e94a7b'
ADAPTER_REVISION = '0e67e0de2b603db085e525e7f6194b24dc60033d'
ADAPTER_SHA256 = '94eb17068a45df06a9e6ab0bcbbd5c381e03f09320da46839c1ed0cee733af31'
MODES = ('create', 'sticker', 'coloring')


class WorkerError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def validate(header):
    if header.get('operation') == 'probe':
        if header.get('payloadLength') != 0:
            raise WorkerError('INPUT', 'A readiness probe has no image payload.')
        return
    if header.get('operation') != 'generate':
        raise WorkerError('INPUT', 'Unsupported generation operation.')
    mode = header.get('mode')
    dimensions = (header.get('width'), header.get('height'))
    steps, strength, guidance = (header.get(key) for key in ('steps', 'strength', 'guidance'))
    if (mode not in MODES or not all(integer(v, 64, 1024) and v % 8 == 0 for v in dimensions)
            or not integer(header.get('seed'), 0, 0xffffffff) or not integer(steps, 1, 50)
            or type(strength) not in (int, float) or not math.isfinite(strength) or not 0 < strength <= 1
            or math.floor(steps * strength) < 1 or type(guidance) not in (int, float)
            or not math.isfinite(guidance) or not 1 <= guidance <= 20
            or not isinstance(header.get('targetToken'), str)
            or re.fullmatch(r'[A-Za-z0-9_-]{1,80}', header['targetToken']) is None):
        raise WorkerError('INPUT', 'Invalid generation dimensions, controls or target.')
    for key, limit in (('prompt', 1536), ('negativePrompt', 512)):
        value = header.get(key)
        if not isinstance(value, str) or len(value.encode('utf-8')) > limit:
            raise WorkerError('INPUT', 'Invalid generation prompt.')
    if not header['prompt'].strip():
        raise WorkerError('INPUT', 'Provide a generation prompt.')
    source, mask = header.get('sourceLength'), header.get('maskLength')
    if not integer(source, 0, MAX_PNG) or not integer(mask, 0, MAX_PNG):
        raise WorkerError('INPUT', 'Invalid generation payload sizes.')
    if source or mask or header.get('payloadLength') != 0:
        raise WorkerError('INPUT', 'This generation operation accepts no source or mask.')
    if strength != 1:
        raise WorkerError('INPUT', 'New image generation requires full generation strength.')


def choose_accelerator(requested, available):
    if requested not in ('auto', 'cpu', 'cuda'):
        raise WorkerError('INPUT', 'Unknown local generation accelerator.')
    if requested == 'cuda' and not available:
        raise WorkerError('RUNTIME', 'The installed CUDA profile requires an available CUDA device. Choose the CPU profile to use CPU generation.')
    return requested == 'cuda' or (requested == 'auto' and available)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate checkpoint metadata key')
        result[key] = value
    return result


class TensorRangeWeights(Mapping):
    # Current pinned fp16 checkpoints contain these formats only. Unknown
    # formats fail before any tensor allocation rather than being reinterpreted.
    FORMATS = {'F16': ('float16', 2), 'I64': ('int64', 8)}
    HEADER_LIMIT = 1024 * 1024

    def __init__(self, path, expected, torch):
        self.torch = torch
        self.source = open(path, 'rb', buffering=0)
        self.index = {}
        try:
            size = os.fstat(self.source.fileno()).st_size
            prefix = self.source.read(8)
            if len(prefix) != 8:
                raise ValueError('Truncated checkpoint prefix')
            length = struct.unpack('<Q', prefix)[0]
            if not 2 <= length <= self.HEADER_LIMIT or length > size - 8:
                raise ValueError('Invalid checkpoint header length')
            header_bytes = self.source.read(length)
            if len(header_bytes) != length or not header_bytes.startswith(b'{'):
                raise ValueError('Truncated checkpoint header')
            header = json.loads(header_bytes, object_pairs_hook=unique_object)
            if not isinstance(header, dict):
                raise ValueError('Invalid checkpoint metadata')
            metadata = header.pop('__metadata__', {})
            if not isinstance(metadata, dict) or any(not isinstance(v, str) for v in metadata.values()):
                raise ValueError('Invalid checkpoint user metadata')
            self.data_start, self.file_size = 8 + length, size
            spans = []
            for name, item in header.items():
                if not isinstance(item, dict) or set(item) != {'dtype', 'shape', 'data_offsets'}:
                    raise ValueError('Invalid tensor metadata')
                dtype, shape, offsets = item['dtype'], item['shape'], item['data_offsets']
                if not isinstance(dtype, str) or dtype not in self.FORMATS:
                    raise ValueError('Unsupported pinned checkpoint dtype')
                if not isinstance(shape, list) or len(shape) > 64 or any(type(v) is not int or not 0 <= v <= size for v in shape):
                    raise ValueError('Invalid tensor shape')
                if not isinstance(offsets, list) or len(offsets) != 2 or any(type(v) is not int for v in offsets):
                    raise ValueError('Invalid tensor offsets')
                start, end = offsets
                if not 0 <= start <= end <= size - self.data_start:
                    raise ValueError('Tensor outside checkpoint')
                if math.prod(shape) * self.FORMATS[dtype][1] != end - start:
                    raise ValueError('Tensor shape and byte length disagree')
                spans.append((start, end))
                self.index[name] = (dtype, shape, start, end)
            position = 0
            for start, end in sorted(spans):
                if start != position:
                    raise ValueError('Checkpoint tensor ranges overlap or contain holes')
                position = end
            if position != size - self.data_start:
                raise ValueError('Unclaimed checkpoint data')
            # State metadata is derived from the actual component architecture.
            # Extra checkpoint entries can be persistent buffers omitted by the
            # model version; all are still validated above, none are loaded.
            for name, parameter in expected.items():
                if name not in self.index or self.index[name][1] != list(parameter.shape):
                    raise ValueError('Checkpoint does not match model architecture')
                dtype = self.index[name][0]
                if str(parameter.dtype) not in ({'torch.float16', 'torch.float32'} if dtype == 'F16' else {'torch.int64'}):
                    raise ValueError('Checkpoint dtype does not match model architecture')
            self._keys = tuple(expected)
            self._names = frozenset(expected)
        except BaseException:
            self.close()
            raise

    def __len__(self):
        return len(self._keys)

    def __iter__(self):
        return iter(self._keys)

    def __contains__(self, name):
        # Mapping's default membership check calls __getitem__, which would
        # unnecessarily materialize a tensor when hooks only inspect keys.
        return name in self._names

    def __getitem__(self, name):
        if name not in self._names:
            raise KeyError(name)
        if self.source.closed:
            raise ValueError('Checkpoint owner is closed')
        if os.fstat(self.source.fileno()).st_size != self.file_size:
            raise ValueError('Checkpoint changed while owned')
        dtype, shape, start, end = self.index[name]
        result = self.torch.empty(end - start, dtype=self.torch.uint8, device='cpu')
        destination = memoryview(result.numpy()).cast('B')
        self.source.seek(self.data_start + start)
        done = 0
        while done < len(destination):
            amount = self.source.readinto(destination[done:])
            if not amount:
                raise ValueError('Checkpoint tensor is truncated')
            done += amount
        return result.view(getattr(self.torch, self.FORMATS[dtype][0])).reshape(shape)

    def close(self):
        self.source.close()

class ColoringIndex:
    def __init__(self, filename, base_shapes, layers_per_block=2, expected_digest=ADAPTER_SHA256):
        self.file = open(filename, 'rb', buffering=0)
        self.groups = {}
        try:
            self.size = os.fstat(self.file.fileno()).st_size
            if hashlib.file_digest(self.file, 'sha256').hexdigest() != expected_digest:
                raise ValueError('Adapter digest mismatch')
            self.digest = expected_digest
            self.file.seek(0)
            prefix = self.file.read(8)
            if len(prefix) != 8:
                raise ValueError('Truncated header prefix')
            length = struct.unpack('<Q', prefix)[0]
            if not 2 <= length <= 1048576 or length + 8 > self.size:
                raise ValueError('Invalid header length')
            header = json.loads(self.file.read(length), object_pairs_hook=unique_object)
            header.pop('__metadata__', None)
            self.start = length + 8
            spans = []
            for name, entry in header.items():
                if set(entry) != {'dtype', 'shape', 'data_offsets'} or entry['dtype'] != 'BF16':
                    raise ValueError('Unsupported adapter tensor metadata')
                shape, offsets = entry['shape'], entry['data_offsets']
                if not isinstance(shape, list) or len(shape) > 2 or any(type(v) is not int or v <= 0 for v in shape):
                    raise ValueError('Invalid adapter shape')
                if not isinstance(offsets, list) or len(offsets) != 2 or any(type(v) is not int for v in offsets):
                    raise ValueError('Invalid adapter offsets')
                low, high = offsets
                if not 0 <= low <= high <= self.size - self.start or high - low != math.prod(shape) * 2:
                    raise ValueError('Adapter range disagrees with shape')
                spans.append((low, high))
            end = 0
            for low, high in sorted(spans):
                if low != end:
                    raise ValueError('Adapter ranges overlap or contain holes')
                end = high
            if end != self.size - self.start:
                raise ValueError('Unclaimed adapter bytes')
            from diffusers.loaders.lora_conversion_utils import _maybe_map_sgm_blocks_to_diffusers, _convert_unet_lora_key
            mapped = _maybe_map_sgm_blocks_to_diffusers(dict(header), SimpleNamespace(layers_per_block=layers_per_block))
            consumed = set()
            for key, down in mapped.items():
                if not key.endswith('.lora_down.weight'):
                    continue
                stem = key.removesuffix('.lora_down.weight')
                up_key, alpha_key = stem + '.lora_up.weight', stem + '.alpha'
                if up_key not in mapped or alpha_key not in mapped:
                    raise ValueError('Incomplete adapter group')
                up, alpha = mapped[up_key], mapped[alpha_key]
                target = _convert_unet_lora_key(key).replace('.processor.', '.').replace('_lora.down.weight', '.weight').replace('.lora.down.weight', '.weight')
                if target.endswith('to_out.weight'):
                    target = target.replace('to_out.weight', 'to_out.0.weight')
                if target in self.groups or len(down['shape']) != 2 or len(up['shape']) != 2 or alpha['shape'] != []:
                    raise ValueError('Invalid adapter group shape or duplicate target')
                rank = down['shape'][0]
                if up['shape'][1] != rank or base_shapes.get(target) != [up['shape'][0], down['shape'][1]]:
                    raise ValueError('Adapter target shape mismatch')
                value = struct.unpack('<f', b'\x00\x00' + self.read(alpha))[0]
                if not math.isfinite(value) or value <= 0:
                    raise ValueError('Invalid adapter alpha')
                self.groups[target] = (down, up, value / rank)
                consumed.update((key, up_key, alpha_key))
            if consumed != set(mapped) or not consumed:
                raise ValueError('Unrecognized adapter entries')
        except BaseException:
            self.close()
            raise

    def read(self, entry):
        if self.file.closed or os.fstat(self.file.fileno()).st_size != self.size:
            raise ValueError('Adapter file is closed or changed')
        low, high = entry['data_offsets']
        self.file.seek(self.start + low)
        data = self.file.read(high - low)
        if len(data) != high - low:
            raise ValueError('Truncated adapter tensor')
        return data

    def tensor(self, entry, torch):
        # The owned bytearray avoids read-only-buffer aliasing. Only a rank-sized
        # factor is converted to float32; base matrices are never retained here.
        value = torch.frombuffer(bytearray(self.read(entry)), dtype=torch.bfloat16).reshape(entry['shape']).float()
        if not bool(torch.isfinite(value).all()):
            raise ValueError('Non-finite adapter values')
        return value

    def close(self):
        self.file.close()

def merge_rows(base, down, up, factor, rows=64):
    if not math.isfinite(factor) or not 0 <= factor <= 2 or type(rows) is not int or rows < 1 or rows > 64:
        raise ValueError('Invalid bounded adapter arithmetic')
    result = base.clone()
    for start in range(0, result.shape[0], rows):
        stop = min(start + rows, result.shape[0])
        delta = up[start:stop] @ down
        result[start:stop] = (result[start:stop].float() + delta * factor).to(dtype=result.dtype)
    return result

class ColoringWeights(Mapping):
    def __init__(self, base, adapter, torch):
        self.base, self.adapter, self.torch = base, adapter, torch
        self.scale, self.entered = 0, False
    def __len__(self):
        return len(self.base)
    def __iter__(self):
        return iter(self.base)
    def __contains__(self, key):
        return key in self.base
    def __getitem__(self, key):
        value = self.base[key]
        if self.scale and key in self.adapter.groups:
            down, up, factor = self.adapter.groups[key]
            value = merge_rows(value, self.adapter.tensor(down, self.torch), self.adapter.tensor(up, self.torch), factor * self.scale)
        return value
    @contextmanager
    def for_mode(self, mode, scale=1.0):
        if self.entered or mode not in MODES or not math.isfinite(scale) or not 0 <= scale <= 2:
            raise ValueError('Invalid or overlapping adapter mode')
        self.entered, self.scale = True, scale if mode == 'coloring' else 0
        try:
            yield {'adapter': 'ColoringBookRedmond-V2', 'adapterRevision': ADAPTER_REVISION,
                   'adapterSha256': self.adapter.digest, 'adapterScale': self.scale} if self.scale else {'adapter': None}
        finally:
            self.entered, self.scale = False, 0


class Inference:
    def __init__(self, model_path, accelerator='auto', model='sdxl-base'):
        self.model_path, self.pipeline = model_path, None
        self.model = model
        self.adapter_path = os.path.join(model_path, 'ColoringBookRedmond-ColoringBook-ColoringBookAF.safetensors') if model == 'sdxl-coloring' else None
        self.coloring_pipeline = self.coloring_weights = None
        self.accelerator = accelerator
        self.provider, self.runtime_version = None, None
        self.weights_backend = None
        self.weight_sources = []

    def initialize(self, progress):
        if self.pipeline is not None:
            return
        if not os.path.isabs(self.model_path):
            raise WorkerError('MODEL', 'The local model path must be absolute.')
        try:
            with open(os.path.join(self.model_path, 'model_index.json'), encoding='utf-8') as source:
                model_index = json.load(source)
            if model_index.get('_class_name') != 'StableDiffusionXLPipeline':
                raise ValueError('class')
        except Exception:
            raise WorkerError('MODEL', 'The configured SDXL model is unavailable or incompatible.') from None
        os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
        progress('loading', 0, 1)
        try:
            progress('torch-import', 0, 1)
            import torch
            progress('torch-import', 1, 1)
            progress('pipeline-import', 0, 1)
            from diffusers import StableDiffusionXLPipeline, DPMSolverMultistepScheduler, UNet2DConditionModel, AutoencoderKL
            from transformers import CLIPTextConfig, CLIPTextModel, CLIPTextModelWithProjection
            from accelerate import init_empty_weights, cpu_offload
            progress('pipeline-import', 1, 1)
            torch.set_num_threads(min(4, os.cpu_count() or 1))
            progress('cuda-check', 0, 1)
            cuda = choose_accelerator(self.accelerator, torch.cuda.is_available())
            progress('cuda-check', 1, 1)
            self.provider = 'cuda' if cuda else 'cpu'
            self.runtime_version = str(torch.__version__)
            progress('model-load', 0, 1)
            dtype = torch.float16 if cuda else torch.float32
            components = {}
            descriptors = (
                ('text_encoder', CLIPTextModel, 'model.fp16.safetensors'),
                ('text_encoder_2', CLIPTextModelWithProjection, 'model.fp16.safetensors'),
                ('unet', UNet2DConditionModel, 'diffusion_pytorch_model.fp16.safetensors'),
                ('vae', AutoencoderKL, 'diffusion_pytorch_model.fp16.safetensors'))
            # Construct architecture on meta, then let Accelerate own leaf
            # materialization. Original checkpoint handles retain no tensors and
            # never map whole files, including on Windows with limited commit.
            for name, component_class, filename in descriptors:
                folder = os.path.join(self.model_path, name)
                with init_empty_weights():
                    if name.startswith('text_encoder'):
                        component = component_class(CLIPTextConfig.from_pretrained(folder, local_files_only=True))
                    else:
                        component = component_class.from_config(component_class.load_config(folder, local_files_only=True))
                component.to(dtype=dtype).eval()
                weights = TensorRangeWeights(os.path.join(folder, filename), component.state_dict(), torch)
                self.weight_sources.append(weights)
                if name == 'unet' and self.adapter_path:
                    adapter = ColoringIndex(self.adapter_path, {key: list(value.shape) for key, value in component.state_dict().items()}, component.config.layers_per_block)
                    self.weight_sources.append(adapter)
                    weights = self.coloring_weights = ColoringWeights(weights, adapter, torch)
                cpu_offload(component, execution_device=torch.device('cuda:0' if cuda else 'cpu'),
                            state_dict=weights, offload_buffers=len(component._parameters) > 0)
                components[name] = component
            pipeline_class = StableDiffusionXLPipeline
            self.pipeline = pipeline_class.from_pretrained(
                self.model_path, local_files_only=True, add_watermarker=False,
                **components)
            if self.adapter_path:
                self.coloring_pipeline = StableDiffusionXLPipeline.from_pipe(self.pipeline, scheduler=DPMSolverMultistepScheduler.from_config(
                    self.pipeline.scheduler.config, algorithm_type='sde-dpmsolver++', solver_order=2, use_karras_sigmas=True))
                self.coloring_pipeline.set_progress_bar_config(disable=True)
            self.weights_backend = 'bounded-tensor-ranges'
            progress('model-load', 1, 1)
            self.pipeline.set_progress_bar_config(disable=True)
            self.pipeline.enable_vae_tiling()
            progress('loading', 1, 1)
        except WorkerError:
            self.close()
            raise
        except Exception:
            self.close()
            raise WorkerError('RUNTIME', 'The local SDXL runtime could not load the model. Check runtime setup and available memory.') from None

    def close(self):
        self.pipeline = self.coloring_pipeline = self.coloring_weights = None
        for source in self.weight_sources:
            source.close()
        self.weight_sources.clear()

    def metadata(self, started):
        return dict(model=self.model, configuredRevision=BASE_REVISION, provider=self.provider,
                    runtimeVersion=self.runtime_version, weightsBackend=self.weights_backend,
                    componentProfile='base-unet-shared-clip-fp16-fixed-vae',
                    elapsedMs=(time.monotonic() - started) * 1000)

    def execute(self, header, payload, progress):
        started = time.monotonic()
        if header['operation'] == 'probe':
            self.initialize(progress)
            return dict(metadata=self.metadata(started)), b''
        from PIL import Image, ImageOps
        size = (header['width'], header['height'])
        mode = header['mode']
        if mode not in MODES:
            raise WorkerError('INPUT', 'Unsupported generation operation.')
        if mode == 'coloring' and not self.adapter_path:
            raise WorkerError('MODEL', 'The managed coloring adapter is required.')
        self.initialize(progress)
        import torch
        prompt, negative = header['prompt'], header['negativePrompt']
        if mode == 'sticker':
            prompt = 'single isolated sticker subject, clean silhouette, plain white background, no text. ' + prompt
            negative = 'busy background, frame, watermark. ' + negative
        elif mode == 'coloring':
            prompt += ', Coloring Book, ColoringBookAF'
            negative = 'bad art, ugly, deformed, watermark, duplicated, colored, colorful, grey colors, grey' + (', ' + negative if negative else '')
        strength, steps = header['strength'], header['steps']

        def step_end(_pipeline, step, _timestep, callback_kwargs):
            progress('denoise', min(step + 1, steps), steps)
            return callback_kwargs

        selected_pipeline = self.coloring_pipeline if mode == 'coloring' else self.pipeline
        adapter_scope = self.coloring_weights.for_mode(mode) if self.coloring_weights else nullcontext({'adapter': None})
        progress('denoise', 0, steps)
        try:
            with torch.inference_mode(), adapter_scope as adapter_metadata:
                generator = torch.Generator(device='cpu').manual_seed(header['seed'])
                options = dict(prompt=prompt, negative_prompt=negative, guidance_scale=header['guidance'],
                    num_inference_steps=header['steps'], generator=generator, callback_on_step_end=step_end)
                options.update(width=size[0], height=size[1])
                result = selected_pipeline(**options).images[0].convert('RGBA')
        except WorkerError:
            raise
        except Exception:
            raise WorkerError('RUNTIME', 'SDXL generation failed. Try a smaller image or check available runtime memory.') from None
        progress('encode', 0, 1)
        if mode == 'coloring':
            result = ImageOps.grayscale(result).convert('RGBA')
        # The backend releases diffusion before its separate sticker matte pass.
        output = io.BytesIO()
        result.save(output, format='PNG')
        encoded = output.getvalue()
        if len(encoded) > MAX_PNG:
            raise WorkerError('RUNTIME', 'The generated PNG exceeds the output bound.')
        progress('encode', 1, 1)
        return dict(width=size[0], height=size[1], mode=mode, seed=header['seed'],
                    targetToken=header['targetToken'], metadata=dict(self.metadata(started),
                    requestedStrength=header['strength'], effectiveStrength=strength, pipelineKind=type(selected_pipeline).__name__,
                    scheduler=type(selected_pipeline.scheduler).__name__, **adapter_metadata)), encoded


def send(header, payload=b''):
    encoded = (json.dumps(dict(header, payloadLength=len(payload)), separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
    if len(encoded) > MAX_HEADER:
        raise RuntimeError('Output header exceeds protocol bound')
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def main():
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ('sdxl-base', 'sdxl-coloring') or (len(sys.argv) >= 4 and sys.argv[3] not in ('auto', 'cpu', 'cuda')):
        return 2
    inference = Inference(sys.argv[2], sys.argv[3] if len(sys.argv) >= 4 else 'auto', sys.argv[1])
    try:
        return serve(inference)
    finally:
        inference.close()


def serve(inference):
    previous_id = 0
    while True:
        raw = sys.stdin.buffer.readline(MAX_HEADER + 1)
        if not raw:
            return 0
        if len(raw) > MAX_HEADER or not raw.endswith(b'\n'):
            return 2
        try:
            header = json.loads(raw)
            if (not isinstance(header, dict) or header.get('version') != 2
                    or not integer(header.get('id'), previous_id + 1, 9007199254740991)
                    or not integer(header.get('payloadLength'), 0, MAX_PNG * 2)):
                return 2
            envelope = dict(version=2, id=header['id'], operation=header.get('operation'))
            previous_id = header['id']
            validate(header)
        except WorkerError as error:
            send(dict(envelope, ok=False, code=error.code, message=error.message))
            return 2  # Do not reinterpret an invalid frame's payload as another command.
        except Exception:
            return 2
        payload = sys.stdin.buffer.read(header['payloadLength'])
        if len(payload) != header['payloadLength']:
            return 2

        def progress(stage, completed, total):
            send(dict(envelope, event='progress', progress=dict(stage=stage, completed=completed, total=total)))

        try:
            fields, output = inference.execute(header, payload, progress)
            send(dict(envelope, ok=True, **fields), output)
        except WorkerError as error:
            send(dict(envelope, ok=False, code=error.code, message=error.message))
        except Exception:
            send(dict(envelope, ok=False, code='RUNTIME', message='The local generation runtime failed. Check its managed setup.'))


if __name__ == '__main__':
    sys.exit(main())
