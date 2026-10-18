const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const python = process.env.PAINT_AI_PROTOCOL_PYTHON;
const worker = path.join(__dirname, 'generative-worker.py');
const prelude = String.raw`
import contextlib, io, json, pathlib, sys, types
scope = {'__name__': 'worker_test'}
exec(compile(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'), sys.argv[1], 'exec'), scope)
base = dict(version=2, id=1, operation='generate', mode='create', width=64, height=64,
            targetToken='doc-layer', seed=42, prompt='boat', negativePrompt='', steps=20,
            strength=1, guidance=7.5, sourceLength=0, maskLength=0, payloadLength=0)
`;
function run(code) {
  return execFileSync(python, ['-I', '-B', '-c', prelude + code, worker], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
}

test('removal producer validates inputs and separates upstream support from exact fractional RGBA ownership', { skip: !python && 'Set PAINT_AI_PROTOCOL_PYTHON for model-free Pillow/NumPy checks.' }, () => {
  assert.equal(run(String.raw`
import numpy as np
from PIL import Image, ImageFilter
local={'__name__':'removal_test'}
filename=pathlib.Path(sys.argv[1]).with_name('local-ai-worker.py')
exec(compile(filename.read_text(),str(filename),'exec'),local)
def png(image):
    output=io.BytesIO(); image.save(output,format='PNG'); return output.getvalue()
rgba=np.zeros((64,64,4),np.uint8)+np.array([200,30,40,255],np.uint8)
rgba[30,30]=[100,60,20,128];rgba[0,40]=[17,18,19,0]
ownership=np.zeros((64,64),np.uint8); ownership[:12,:12]=255;ownership[20:44,20:44]=255
ownership[23:27,23:27]=0;ownership[30,30]=128
source,mask=Image.fromarray(rgba),Image.fromarray(ownership)
source_bytes,mask_bytes=png(source),png(mask)
request=dict(mode='erase',width=64,height=64,targetToken='doc-layer',seed=42,prompt='',negativePrompt='',sourceLength=len(source_bytes),maskLength=len(mask_bytes))
decoded_source,decoded_mask=local['removal_inputs'](request,source_bytes+mask_bytes)
for patch,payload in [(dict(prompt='wall'),source_bytes+mask_bytes),(dict(negativePrompt=' '),source_bytes+mask_bytes),
                      (dict(width=65),source_bytes+mask_bytes),(dict(sourceLength=True),source_bytes+mask_bytes),
                      (dict(seed=-1),source_bytes+mask_bytes),(dict(targetToken='../foreign'),source_bytes+mask_bytes),
                      (dict(maskLength=len(mask_bytes)+1),source_bytes+mask_bytes+b'x')]:
    try: local['removal_inputs'](dict(request,**patch),payload);raise AssertionError(patch)
    except local['WorkerError'] as error: assert error.code=='INPUT'
for value in (0,255):
    whole=png(Image.new('L',(64,64),value))
    try:local['removal_inputs'](dict(request,maskLength=len(whole)),source_bytes+whole);raise AssertionError(value)
    except local['WorkerError'] as error:assert error.code=='INPUT'
class FakeSession:
    def run(self, names, feed):
        assert names is None
        assert feed['image'].dtype==np.uint8 and feed['image'].shape==(1,3,64,64)
        keep=feed['mask'][0,0]
        expected=255-np.asarray(mask.point(lambda v:255 if v else 0).filter(ImageFilter.MaxFilter(7)))
        assert np.array_equal(keep,expected), 'wrong polarity or conditioning footprint'
        # The graph maximum radius1 plus Gaussian radius2 can only see zero
        # keep-mask within every selected original pixel, even at document edge.
        padded=np.pad(keep,1,constant_values=0)
        restored=np.maximum.reduce([padded[y:y+64,x:x+64] for y in range(3) for x in range(3)])
        padded=np.pad(restored,2,mode='reflect')
        support=np.maximum.reduce([padded[y:y+64,x:x+64] for y in range(5) for x in range(5)])
        assert np.all(support[ownership>0]==0), 'old selected object restored by graph boundary blend'
        output=np.zeros((1,3,64,64),np.uint8); output[:,0]=20;output[:,1]=180;output[:,2]=60
        return [output]
encoded=local['remove_object'](FakeSession(),decoded_source,decoded_mask,np,Image)
actual=np.asarray(Image.open(io.BytesIO(encoded)))
assert np.array_equal(actual[ownership==0],rgba[ownership==0]), 'outside or enclosed-hole pixels changed'
assert np.array_equal(actual[:,:,3],rgba[:,:,3]), 'existing alpha changed'
assert tuple(actual[30,30])==(60,120,40,128), 'fractional composition applied more than once'
assert np.all(actual[ownership==255,:3]==[20,180,60]), 'old object retained at selected document edge'
class BadSession:
    def run(self,*args):return [np.zeros((1,3,64,64),np.float32)]
try:local['remove_object'](BadSession(),source,mask,np,Image);raise AssertionError('dtype')
except local['WorkerError'] as error:assert error.code=='RUNTIME'
assert 'onnxruntime' not in sys.modules and 'torch' not in sys.modules
print('removal-valid')
`).trim(), 'removal-valid');
});

test('Python generation boundary validates controls and rejects malformed frames before importing a model', { skip: !python && 'Set PAINT_AI_PROTOCOL_PYTHON to an existing Python for model-free checks.' }, () => {
  assert.equal(run(String.raw`
scope['validate'](base)
scope['validate'](dict(base,steps=1))
try:
    scope['validate'](dict(base,mode='fill',steps=1,sourceLength=33,maskLength=33,payloadLength=66))
    raise AssertionError('excluded mode')
except scope['WorkerError']:pass
for patch in [dict(width=65), dict(seed=-1), dict(steps=0), dict(steps=51), dict(strength=.5), dict(guidance=float('nan')),
              dict(prompt=''), dict(prompt='a'*1537), dict(negativePrompt='é'*257), dict(mode='erase'), dict(mode='fill'),
              dict(mode='cocreate'), dict(mode='reimagine'), dict(sourceLength=5), dict(targetToken='../foreign')]:
    try:
        scope['validate'](dict(base, **patch))
        raise AssertionError(patch)
    except scope['WorkerError'] as error:
        assert error.code == 'INPUT'
calls = []
class FakeInference:
    def __init__(self, model_path, accelerator='auto', model='sdxl-base'): pass
    def close(self): calls.append('closed')
    def execute(self, header, payload, progress):
        calls.append(header['id'])
        progress('denoise', 1, 1)
        return {'metadata': {}}, b'PNG'
scope['Inference'] = FakeInference
class Stream:
    def __init__(self, data=b''): self.buffer = io.BytesIO(data)
original = (sys.stdin, sys.stdout, sys.argv)
try:
    sys.argv = ['worker', 'sdxl-base', '/model']
    sys.stdin = Stream((json.dumps(base)+'\n'+json.dumps(base)+'\n').encode())
    output = Stream(); sys.stdout = output
    assert scope['main']() == 2
    assert calls == [1, 'closed'], 'replayed request must not execute and owner must close'
    encoded = output.buffer.getvalue()
    progress, final = encoded.split(b'\n', 2)[:2]
    assert json.loads(progress)['event'] == 'progress'
    assert json.loads(final)['payloadLength'] == 3
    assert encoded.endswith(b'PNG')
finally:
    sys.stdin, sys.stdout, sys.argv = original
assert 'torch' not in sys.modules and 'diffusers' not in sys.modules
print('validated')
`).trim(), 'validated');
});

test('selected generation accelerator cannot silently change to CPU or CUDA', { skip: !python && 'Set PAINT_AI_PROTOCOL_PYTHON to an existing Python.' }, () => {
  assert.equal(run(String.raw`
choose = scope['choose_accelerator']
assert choose('cpu', True) is False and choose('cpu', False) is False
assert choose('cuda', True) is True
assert choose('auto', True) is True and choose('auto', False) is False
try:
    choose('cuda', False)
    raise AssertionError('CUDA selection silently changed')
except scope['WorkerError'] as error:
    assert error.code == 'RUNTIME' and 'CUDA profile requires' in error.message
assert 'torch' not in sys.modules
print('accelerator')
`).trim(), 'accelerator');
});

test('Tensor range owner rejects malformed checkpoints and closed or foreign reads without importing a model', { skip: !python && 'Set PAINT_AI_PROTOCOL_PYTHON to an existing Python.' }, () => {
  assert.equal(run(String.raw`
"""Model-free malformed checkpoint coverage for the proposed range owner."""
import json
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
TensorRangeWeights = scope['TensorRangeWeights']

valid={'x':dict(dtype='F16',shape=[2],data_offsets=[0,4])}
expected={'x':SimpleNamespace(shape=(2,),dtype='torch.float16')}
cases=[b'{"x":{},"x":{}}',b'{"x":{"dtype":"F16","dtype":"I64","shape":[2],"data_offsets":[0,4]}}',
       {'x':dict(dtype='F32',shape=[1],data_offsets=[0,4])},
       {'x':dict(dtype='F16',shape=[True],data_offsets=[0,4])},
       {'x':dict(dtype='F16',shape=[3],data_offsets=[0,4])},
       {'x':dict(dtype='F16',shape=[2],data_offsets=[-1,3])},
       {'x':dict(dtype='F16',shape=[2],data_offsets=[1,5])},
       {'x':dict(dtype='F16',shape=[2],data_offsets=[0,4]),'y':dict(dtype='F16',shape=[1],data_offsets=[2,4])},
       {'x':dict(dtype='F16',shape=[1],data_offsets=[2,4])},
       {'x':dict(dtype='F16',shape=[1],data_offsets=[0,2])},
       {'x':dict(dtype='F16',shape=[1],data_offsets=[0,2],unknown=True)},
       dict(valid,__metadata__={'bad':False}),{},[]]
with tempfile.TemporaryDirectory() as directory:
    path=Path(directory)/'fixture.safetensors'
    def write(header,payload=b'\0'*4):
        encoded=header if isinstance(header,bytes) else json.dumps(header).encode()
        path.write_bytes(struct.pack('<Q',len(encoded))+encoded+payload)
    for case in cases:
        write(case)
        try: TensorRangeWeights(path,expected,None)
        except (ValueError,TypeError): pass
        else: raise AssertionError(case)
    for data in [b'',b'123',struct.pack('<Q',2**32),struct.pack('<Q',100)+b'{}']:
        path.write_bytes(data)
        try: TensorRangeWeights(path,expected,None)
        except ValueError: pass
        else: raise AssertionError('Invalid header accepted')
    write(valid)
    owner=TensorRangeWeights(path,expected,None)
    assert list(owner)==['x'] and list(owner.keys())==['x']
    assert 'x' in owner and 'foreign' not in owner, 'membership must not allocate a tensor'
    owner.close();owner.close()
    try: owner['x']
    except ValueError: pass
    else: raise AssertionError('Closed owner accepted read')
    try: owner['foreign']
    except KeyError: pass
    else: raise AssertionError('Foreign tensor accepted')
print('range-boundary')

`).trim(), 'range-boundary');
});

test('sticker matte worker applies predicted alpha without destroying original color or transparency', { skip: !python && 'Set PAINT_AI_PROTOCOL_PYTHON to an existing Python with Pillow and NumPy for model-free matte checks.' }, () => {
  const output = run(String.raw`
import numpy as np
from PIL import Image
segmentation = {'__name__': 'segmentation_test'}
filename = pathlib.Path(sys.argv[1]).with_name('local-ai-worker.py')
exec(compile(filename.read_text(encoding='utf-8'), str(filename), 'exec'), segmentation)
class Session:
    def get_outputs(self): return [types.SimpleNamespace(name='mask')]
    def get_inputs(self): return [types.SimpleNamespace(name='image')]
    def run(self, names, inputs):
        assert inputs['image'].shape == (1, 3, 320, 320)
        return [np.broadcast_to(np.linspace(0, 1, 320, dtype=np.float32), (1, 1, 320, 320))]
inference = segmentation['Inference']('u2netp', [])
inference.np, inference.Image = np, Image
inference.sessions = {'model': Session()}
inference.metadata = {'model': 'u2netp'}
source = Image.new('RGBA', (64, 64), (90, 50, 20, 128))
source.putpixel((63, 63), (20, 80, 200, 0))
encoded = io.BytesIO(); source.save(encoded, format='PNG')
metadata, output = inference.execute(dict(operation='cutout', width=64, height=64), encoded.getvalue())
result = Image.open(io.BytesIO(output))
assert result.mode == 'RGBA'
assert result.getpixel((63, 63)) == (20, 80, 200, 0)
assert result.getpixel((63, 0))[:3] == (90, 50, 20)
assert result.getpixel((0, 0))[3] < result.getpixel((63, 0))[3] <= 128
assert metadata['metadata']['rawMin'] == 0 and metadata['metadata']['rawMax'] == 1
# A larger sticker exposes interpolation echoes that a downsampled ramp cannot.
# Include genuine disconnected low-alpha ink so cleanup cannot simply threshold
# the matte or retain only its largest component.
prediction = np.zeros((320, 320), dtype=np.float32)
prediction[80:240, 100:220] = 1
prediction[40:280, 40] = 3 / 255
prediction[40:280, 280] = 3 / 255
inference.sessions['model'].run = lambda names, inputs: [prediction[None, None]]
source = Image.new('RGBA', (1024, 1024), (90, 50, 20, 255))
source.putpixel((0, 0), (20, 80, 200, 0))
for x, alpha in [(510, 7), (511, 128), (512, 255)]:
    source.putpixel((x, 512), (255, 255, 255, alpha))
encoded = io.BytesIO(); source.save(encoded, format='PNG')
metadata, output = inference.execute(dict(operation='cutout', width=1024, height=1024), encoded.getvalue())
result = np.asarray(Image.open(io.BytesIO(output)))
original = np.asarray(source)
# Independent local-support oracle: only the four source pixels surrounding
# each destination center can contribute. Ringing outside that support is not
# foreground confidence and must not introduce detached alpha streaks.
coordinate = (np.arange(1024) + .5) * 320 / 1024 - .5
low = np.floor(coordinate).astype(int)
high = np.clip(low + 1, 0, 319); low = np.clip(low, 0, 319)
support = np.zeros((1024, 1024), dtype=bool)
for ys in (low, high):
    for xs in (low, high):
        support |= prediction[ys[:, None], xs[None, :]] > 0
assert not result[:, :, 3][~support].any(), 'Alpha interpolation created foreground beyond its source support.'
assert result[512, 129, 3] == result[512, 897, 3] == 3, 'Genuine disconnected low-alpha strokes were lost.'
assert not result[:, 160:300, 3].any(), 'Separate ink and subject were joined.'
assert np.array_equal(result[:, :, :3], original[:, :, :3]), 'Matte processing changed original RGB.'
assert np.all(result[:, :, 3] <= original[:, :, 3])
for x in (510, 511, 512):
    assert np.array_equal(result[512, x], original[512, x]), 'White interior or source alpha was changed.'
assert metadata['metadata']['matte']['method'] == 'model-saliency'
assert 'onnxruntime' not in sys.modules and 'torch' not in sys.modules
print('matted')
`);
  assert.equal(output.trim(), 'matted');
});

test('object exclusions use positive decoder queries, subtract overlap and retain the embedding for empty-result retry', { skip: !python && 'Set PAINT_AI_PROTOCOL_PYTHON to an existing Python with NumPy.' }, () => {
  const output = run(String.raw`
import numpy as np
segmentation = {'__name__': 'segmentation_test'}
filename = pathlib.Path(sys.argv[1]).with_name('local-ai-worker.py')
exec(compile(filename.read_text(encoding='utf-8'), str(filename), 'exec'), segmentation)
queries = []
class Session:
    def run(self, names, inputs):
        points = inputs['batched_point_coords'][0, 0]
        labels = inputs['batched_point_labels'][0, 0]
        assert all(value == 1 for value in labels), 'unsupported zero label reached EfficientSAM'
        queries.append(points.tolist())
        mask = np.zeros((16, 32), dtype=bool)
        for x, y in points:
            if x < 16: mask[2:14, 2:14] = True
            else: mask[2:14, 18:30] = True
        logits = np.broadcast_to(np.where(mask, 1, -1).astype(np.float32), (1, 1, 3, 16, 32))
        return logits, np.asarray([[[.1, .9, .5]]], dtype=np.float32), np.zeros((1, 3, 256, 256), dtype=np.float32)
inference = segmentation['Inference']('efficientsam-ti', [])
inference.np, inference.Image = np, None
inference.sessions = {'decoder': Session()}
inference.embedding = np.zeros((1, 256, 64, 64), dtype=np.float32)
inference.size = (32, 16); inference.metadata = {'model': 'efficientsam-ti'}
embedding = inference.embedding
metadata, mask = inference.execute(dict(operation='select', coords=[[4, 4], [20, 4], [20, 4]], labels=[1, 1, 0]), b'')
pixels = np.frombuffer(mask, dtype=np.uint8).reshape(3, 16, 32)
assert all(pixels[index, 4, 4] == 1 and pixels[index, 4, 20] == 0 for index in range(3))
assert metadata['metadata']['refinement']['method'] == 'object-mask-subtraction'
assert metadata['metadata']['refinement']['excludedObjects'] == 1
metadata, mask = inference.execute(dict(operation='select', coords=[[4, 4], [4, 4]], labels=[1, 0]), b'')
assert not any(mask) and metadata['metadata']['refinement']['empty']
assert inference.embedding is embedding
metadata, mask = inference.execute(dict(operation='select', coords=[[4, 4]], labels=[1]), b'')
assert any(mask) and inference.embedding is embedding
assert len(queries) == 5
print('excluded')
`);
  assert.equal(output.trim(), 'excluded');
});

test('flat drawing correction removes connected colored paper while preserving enclosed interiors and antialiased ink', { skip: !python && 'Set PAINT_AI_PROTOCOL_PYTHON to an existing Python with Pillow and NumPy.' }, () => {
  const output = run(String.raw`
import numpy as np
from PIL import Image, ImageDraw
segmentation = {'__name__': 'segmentation_test'}
filename = pathlib.Path(sys.argv[1]).with_name('local-ai-worker.py')
exec(compile(filename.read_text(encoding='utf-8'), str(filename), 'exec'), segmentation)
matte = segmentation['flat_drawing_matte']
for paper in [(255,255,255), (238,224,174), (38,92,123)]:
    drawing = Image.new('RGB', (128,96), paper)
    pen = ImageDraw.Draw(drawing)
    pen.rectangle((12,12,48,50), fill='white', outline='black', width=2)
    pen.line((60,20,112,74), fill=(12,12,12), width=1)
    result, info = matte(drawing, np, Image)
    assert result.getpixel((0,0)) == 0
    assert result.getpixel((30,30)) == 255, 'enclosed white interior erased'
    assert result.getpixel((60,20)) == 255
    assert info['paperRgb'] == list(paper) and info['unmixEdges']
large = Image.new('RGBA', (512,384), (0,0,0,0))
pen = ImageDraw.Draw(large)
for y in [40,80,120,160,200,240,280]:
    pen.line((48,y,452,y+36), fill=(20,35,50,255), width=4)
antialias = Image.alpha_composite(Image.new('RGBA',(128,96),(242,230,190,255)), large.resize((128,96), Image.Resampling.LANCZOS)).convert('RGB')
result = matte(antialias, np, Image)
assert result is not None, 'antialiased flat ink was not recognized'
pixels = np.asarray(antialias)
ink = np.max(np.abs(pixels.astype(np.int16)-[242,230,190]),axis=2)>2
assert np.all(np.asarray(result[0])[ink] > 0), 'antialiased ink lost'
assert np.asarray(result[0])[0,0] == 0
alpha = np.asarray(result[0], dtype=np.float32)/255
partial = (alpha>0)&(alpha<1)
assert partial.any(), 'antialias opacity was not recovered'
recovered = pixels.astype(np.float32).copy()
recovered[partial] = np.clip((recovered[partial]-(1-alpha[partial,None])*[242,230,190])/alpha[partial,None],0,255)
# Recomposition on original paper should match source within quantization.
recomposed = recovered*alpha[:,:,None]+(1-alpha[:,:,None])*[242,230,190]
assert np.max(np.abs(recomposed[ink]-pixels[ink])) <= 3, ('recomposition',float(np.max(np.abs(recomposed[ink]-pixels[ink]))))
# Actual recovered ink stays dark on a contrasting background, without paper.
assert np.median(recovered[partial], axis=0).max() < 90, ('recovered ink',np.median(recovered[partial],axis=0).tolist())
# A flat border alone must never qualify a textured photographic subject.
rng = np.random.default_rng(1701)
pixels = np.full((128,128,3), 255, dtype=np.uint8)
pixels[24:104,24:104] = rng.integers(0,240,(80,80,3),dtype=np.uint8)
assert matte(Image.fromarray(pixels), np, Image) is None
# A soft gradient is not flat artwork, even with a uniform paper border.
pixels = np.full((128,128,3), 255, dtype=np.uint8)
gradient = np.linspace(20,220,80,dtype=np.uint8)
pixels[24:104,24:104] = gradient[None,:,None]
assert matte(Image.fromarray(pixels), np, Image) is None
assert 'onnxruntime' not in sys.modules
print('flat-drawing')
`);
  assert.equal(output.trim(), 'flat-drawing');
});


test('bounded coloring merge preserves base tensors and resets operation scope after failure', { skip: !python && 'Set PAINT_AI_PROTOCOL_PYTHON for model-free NumPy checks.' }, () => {
  assert.equal(run(String.raw`
import numpy as np
class Array:
    def __init__(self,data):self.data=np.asarray(data)
    @property
    def shape(self):return self.data.shape
    @property
    def dtype(self):return self.data.dtype
    def clone(self):return Array(self.data.copy())
    def float(self):return Array(self.data.astype(np.float32))
    def to(self,dtype):return Array(self.data.astype(dtype))
    def __getitem__(self,key):return Array(self.data[key])
    def __setitem__(self,key,value):self.data[key]=value.data
    def __matmul__(self,other):return Array(self.data@other.data)
    def __mul__(self,value):return Array(self.data*value)
    def __add__(self,other):return Array(self.data+other.data)
base_values=np.arange(630,dtype=np.float32).reshape(210,3)
down=np.array([[1,2,3],[4,5,6]],np.float32)
up=np.arange(420,dtype=np.float32).reshape(210,2)
base=Array(base_values.copy())
merged=scope['merge_rows'](base,Array(down),Array(up),.5)
assert np.array_equal(merged.data,base_values+(up@down)*.5)
assert np.array_equal(base.data,base_values), 'base changed during adapter application'
class Adapter:
    groups={'leaf':('down','up',.5)}
    digest='fixture'
    def tensor(self,key,torch):return Array(down if key=='down' else up)
weights=scope['ColoringWeights']({'leaf':base},Adapter(),None)
for mode in ('create','sticker'):
    with weights.for_mode(mode) as metadata:
        assert weights['leaf'] is base and metadata=={'adapter':None}
try:
    with weights.for_mode('coloring') as metadata:
        assert np.array_equal(weights['leaf'].data,merged.data)
        assert metadata['adapterScale']==1
        try:
            with weights.for_mode('coloring'):pass
            raise AssertionError('overlap')
        except ValueError:pass
        raise RuntimeError('simulated inference failure')
except RuntimeError:pass
assert weights.scale==0 and not weights.entered and weights['leaf'] is base
with weights.for_mode('coloring'):
    assert np.array_equal(weights['leaf'].data,merged.data), 'retry accumulates adapter twice'
assert weights.scale==0 and np.array_equal(base.data,base_values)
assert 'torch' not in sys.modules
print('adapter-owner')
`).trim(), 'adapter-owner');
});
