from pathlib import Path

path = Path('packages/server/src/core/types.ts')
text = path.read_text(encoding='utf-8')
old = "  | 'thought.updated' | 'world.updated';"
new = "  | 'thought.updated' | 'world.updated' | 'moment.created';"
if old not in text:
    raise RuntimeError('StreamEventType tail not found')
path.write_text(text.replace(old, new, 1), encoding='utf-8')

features = Path('packages/web/src/lib/features.ts')
text = features.read_text(encoding='utf-8')
old = "  momentId: string | null;\n  sendSuccess: boolean;"
new = "  momentId?: string | null;\n  sendSuccess: boolean;"
if old not in text:
    raise RuntimeError('ProactiveAttempt momentId field not found')
features.write_text(text.replace(old, new, 1), encoding='utf-8')
