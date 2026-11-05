from pathlib import Path
import json, zipfile, hashlib
root=Path(__file__).resolve().parent.parent
manifest=json.loads((root/'manifest.json').read_text())
plugin_id=manifest['id']
assert plugin_id=='simple-memo'
files=['main.js','styles.css','manifest.json','README.md','README.zh-CN.md','LICENSE']
assert all((root/name).is_file() for name in files)
folder=root/'dist'; folder.mkdir(exist_ok=True)
output=folder/f"simple-memo-{manifest['version']}.zip"
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
    for name in files: archive.write(root/name,f'{plugin_id}/{name}')
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    for name in files: assert archive.read(f'{plugin_id}/{name}')==(root/name).read_bytes()
print(json.dumps({'zip':str(output),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))
