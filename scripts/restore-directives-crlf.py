from pathlib import Path

path = Path('packages/server/src/core/directives.ts')
text = path.read_bytes().decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')
path.write_bytes(text.replace('\n', '\r\n').encode('utf-8'))
