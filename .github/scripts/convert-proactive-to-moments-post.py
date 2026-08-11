from pathlib import Path

path = Path('packages/server/src/core/types.ts')
text = path.read_text(encoding='utf-8')
old = "  | 'thought.updated' | 'world.updated';"
new = "  | 'thought.updated' | 'world.updated' | 'moment.created';"
if old not in text:
    raise RuntimeError('StreamEventType tail not found')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
