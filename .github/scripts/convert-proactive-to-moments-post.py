from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding='utf-8')
    if old not in text:
        raise RuntimeError(f'expected block not found in {path}: {old!r}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


path = Path('packages/server/src/core/types.ts')
text = path.read_text(encoding='utf-8')
old = "  | 'thought.updated' | 'world.updated';"
new = "  | 'thought.updated' | 'world.updated' | 'moment.created';"
if old not in text:
    raise RuntimeError('StreamEventType tail not found')
path.write_text(text.replace(old, new, 1), encoding='utf-8')

replace(
    'packages/web/src/lib/features.ts',
    "  momentId: string | null;\n  sendSuccess: boolean;",
    "  momentId?: string | null;\n  sendSuccess: boolean;"
)

# The feature changes product semantics, so the existing UI tests must assert
# the new user-facing language rather than preserving obsolete chat wording.
replace('packages/web/src/lib/lifeObservation.test.ts', "title: '主动联系尝试', detail: '没有打扰你'", "title: '朋友圈发布尝试', detail: '暂未发布'")
replace('packages/web/src/lib/lifeObservation.test.ts', "{ title: '分享读书心得', detail: '已经发送' }", "{ title: '分享读书心得', detail: '已发布到朋友圈' }")
replace('packages/web/src/lib/lifeObservation.test.ts', "{ title: '分享读书心得', detail: '发送失败' }", "{ title: '分享读书心得', detail: '发布失败' }")

replace('packages/web/src/lib/lifeView.test.ts', ".toContain('还没有做完');", ".toContain('还没有值得发布的新动态');")
replace('packages/web/src/lib/lifeView.test.ts', "expect(proactiveReasonText('compose_failed')).toBe('主动消息生成失败');", "expect(proactiveReasonText('compose_failed')).toBe('朋友圈文案生成失败');")
replace('packages/web/src/lib/lifeView.test.ts', "expect(proactiveReasonText('empty_text')).toBe('模型没有生成可发送文字');", "expect(proactiveReasonText('empty_text')).toBe('模型没有生成可发布文字');")
replace('packages/web/src/lib/lifeView.test.ts', "expect(proactiveReasonText('media_failed')).toBe('附加媒体准备失败');", "expect(proactiveReasonText('media_failed')).toBe('动态图片准备失败');")
replace('packages/web/src/lib/lifeView.test.ts', "expect(proactiveReasonText('message_persist_failed: database busy')).toBe('消息保存失败');", "expect(proactiveReasonText('moment_persist_failed: database busy')).toBe('动态保存失败');")

replace('packages/web/src/components/life/LifeObservationDetails.test.tsx', "expect(secondary?.textContent).toContain('联系边界');", "expect(secondary?.textContent).toContain('朋友圈发布');")
replace('packages/web/src/components/life/LifeObservationPanel.test.tsx', "expect(secondary.textContent).toContain('联系边界');", "expect(secondary.textContent).toContain('朋友圈发布');")
