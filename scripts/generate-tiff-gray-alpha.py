"""Original grayscale-alpha fixtures encoded and independently decoded by Pillow/libtiff."""
import base64
import hashlib
import io
import json
from pathlib import Path
import PIL
from PIL import Image, features

def digest(data):
    return hashlib.sha256(data).hexdigest()
fixtures = []
for orientation in range(1, 9):
    compression = ['raw', 'packbits', 'tiff_lzw', 'tiff_adobe_deflate'][(orientation-1) % 4]
    predictor = 2 if compression in ('tiff_lzw', 'tiff_adobe_deflate') else 1
    width, height = 7, 5
    data = bytes(component for i in range(width*height) for component in ((i*37+180)%256, [0,1,64,127,128,254,255][i%7]))
    original = Image.frombytes('LA', (width,height), data)
    tags = {274: orientation, 278: 2}
    if predictor == 2: tags[317] = 2
    stream=io.BytesIO(); original.save(stream,format='TIFF',compression=compression,tiffinfo=tags);encoded=stream.getvalue()
    with Image.open(io.BytesIO(encoded)) as image:
        stored={'photometric':image.tag_v2[262], 'bits':list(image.tag_v2[258]), 'samples':image.tag_v2[277], 'alpha':list(image.tag_v2[338]), 'compression':image.tag_v2[259], 'predictor':image.tag_v2.get(317,1), 'orientation':image.tag_v2.get(274,1), 'strips':len(image.tag_v2[273])}
        assert stored['photometric']==1 and stored['bits']==[8,8] and stored['samples']==2 and stored['alpha']==[2]
        assert stored['strips']==3 and stored['predictor']==predictor
        image.load();rgba=image.convert('RGBA').tobytes()
        fixtures.append({'name':f'gray-alpha-{compression}-orientation-{orientation}', 'stored':stored, 'width':image.width, 'height':image.height, 'encodedSha256':digest(encoded), 'rgbaSha256':digest(rgba), 'encodedBase64':base64.b64encode(encoded).decode(), 'rgbaBase64':base64.b64encode(rgba).decode()})
result={'provenance':{'pillow':PIL.__version__,'libtiff':features.version('libtiff'),'generatorSha256':digest(Path(__file__).read_text(encoding='utf-8').encode('utf-8')),'generatorHashEncoding':'UTF-8 with LF newlines','description':'Original LA pixels, including nonzero gray beneath zero alpha. Pillow independently encodes and decodes BlackIsZero/unassociated-alpha TIFF. No native Paint equivalence claim.'},'fixtures':fixtures}
path=Path(__file__).parent/'fixtures'/'tiff-gray-alpha.json';path.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8');print(json.dumps({'fixtures':len(fixtures),'provenance':result['provenance']}))
