# Web Warm Light and Dark Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将聊天、图库和管理中心统一为“暖调陪伴感”的系统亮/暗主题，同时守住文字对比度、焦点可见性、响应式布局和减少动画偏好。

**Architecture:** `styles.css` 的语义 token 是唯一主题源，通过 `prefers-color-scheme` 切换亮暗值；聊天、图库、弹层和管理中心只消费语义 token，不自行复制浅色常量。暖白到淡薰衣草背景、柔和紫色发出气泡、暖白接收气泡、半透明顶栏/输入区和轻量贴纸承托面构成统一视觉；暗色保持暖黑紫而非纯黑霓虹。所有动画都受既有 `prefers-reduced-motion` 约束，虚拟消息行不添加全局入场动画。

**Tech Stack:** CSS Custom Properties、`prefers-color-scheme`、`prefers-reduced-motion`、React 19、Vitest 4 源码契约测试、Playwright 1.62

---

## 实施顺序与边界

本计划是三片交付中的第 3 片。开始前必须已经完成：

1. `2026-08-06-web-route-session.md`
2. `2026-08-06-web-stream-media-stability.md`

本片不增加主题切换按钮，不下载 Web Font，不改变 900px 桌面聊天宽度，不给 `.msg-row` 添加挂载动画，也不重做信息架构。图片查看器继续使用固定近黑背景和白色 chrome，因为它是照片观看环境，不属于页面主题表面。

## 已确认的视觉规则

- 亮色：暖白到淡薰衣草背景，暖白接收气泡，沉稳紫色发送气泡。
- 暗色：暖黑紫背景与深紫灰表面，不使用 OLED 纯黑或高饱和赛博霓虹。
- 顶栏和输入区：半透明表面、轻边框、适量 blur；不牺牲文字对比度。
- 气泡：接收/发送分别保留不同起始角，依靠形状和颜色共同区分方向。
- 贴纸：透明素材下有极轻的主题承托面，不画厚重卡片。
- 动效：保留 typing、skeleton、图片 placeholder shimmer；减少动画偏好下近乎静止。
- 字体：继续使用系统中文字体栈，避免字体网络请求影响首屏。
- 响应式：聊天桌面最大宽度仍为 900px；375×812、844×390、1280×860 无横向溢出。

## 文件职责映射

- 新增 `packages/web/src/styles.theme.test.ts`：主题 token、WCAG 对比度、关键表面与动效边界。
- 修改 `packages/web/src/styles.css`：亮/暗 token、背景、气泡、玻璃表面、焦点、shimmer。
- 修改 `packages/web/src/components/styleTokens.test.ts`：图库、弹层、增强样式和管理中心不得复制主题颜色。
- 修改 `packages/web/src/components/overlays.css`：图库与通知弹层使用共享 token，保留固定图片查看器配色。
- 修改 `packages/web/src/components/FeatureEnhancements.css`：展开压缩 CSS 并全部改为语义 token。
- 修改 `packages/web/src/components/AdminPanel.css`：admin token 映射到共享主题，清理硬编码浅色表面和旧蓝色强调色。
- 新增 `e2e/theme.e2e.ts`：真实浏览器的 color-scheme、reduced-motion、三种 viewport 与三类页面检查。
- 修改 `docs/LIMITATIONS.md`：记录系统主题支持与没有手动切换器的边界。

## Task 0: 固定第 2 片后的基线

- [ ] 检查分支与工作区：

```powershell
git status --short --branch
```

预期：位于 `codex/web-performance-ui-refactor`；前两片已提交，没有未解释的产品代码改动。

- [ ] 运行前端基线：

```powershell
npm.cmd test -w @sooya/web
npm.cmd run typecheck -w @sooya/web
npm.cmd run build -w @sooya/web
```

预期：测试、类型检查、构建全部通过。

## Task 1: 先建立主题与对比度契约

**Files:**

- Create: `packages/web/src/styles.theme.test.ts`
- Modify: `packages/web/src/components/styleTokens.test.ts`

- [ ] 新增 `packages/web/src/styles.theme.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

function marked(name: 'light' | 'dark'): string {
  const start = `/* theme:${name}:start */`;
  const end = `/* theme:${name}:end */`;
  const from = CSS.indexOf(start);
  const to = CSS.indexOf(end);
  if (from < 0 || to <= from) throw new Error(`missing ${name} theme markers`);
  return CSS.slice(from + start.length, to);
}

function hexTokens(source: string): Record<string, string> {
  return Object.fromEntries(
    [...source.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\b/gi)]
      .map((match) => [match[1]!, match[2]!.toLowerCase()])
  );
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

const required = [
  '--bg', '--panel', '--panel-alt', '--surface-raised', '--surface-hover',
  '--ink', '--ink-soft', '--ink-meta', '--line', '--accent', '--accent-deep',
  '--mine-start', '--mine-end', '--mine-ink', '--theirs', '--theirs-border',
  '--danger-ink', '--shimmer-base', '--shimmer-highlight'
];

describe('warm system theme', () => {
  it.each(['light', 'dark'] as const)('%s palette defines every semantic token', (mode) => {
    const source = marked(mode);
    const tokens = hexTokens(source);
    for (const name of required) expect(tokens[name], `${mode} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(['light', 'dark'] as const)('%s normal text and outgoing bubbles meet WCAG AA', (mode) => {
    const tokens = hexTokens(marked(mode));
    for (const [foreground, background] of [
      ['--ink', '--bg'],
      ['--ink-soft', '--bg'],
      ['--ink-meta', '--panel'],
      ['--accent-deep', '--panel'],
      ['--danger-ink', '--panel'],
      ['--ink', '--theirs'],
      ['--mine-ink', '--mine-start'],
      ['--mine-ink', '--mine-end']
    ] as const) {
      expect(contrast(tokens[foreground]!, tokens[background]!), `${mode} ${foreground} on ${background}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(['light', 'dark'] as const)('%s focus accent has a 3:1 non-text contrast', (mode) => {
    const tokens = hexTokens(marked(mode));
    expect(contrast(tokens['--accent']!, tokens['--panel']!)).toBeGreaterThanOrEqual(3);
  });

  it('uses the system scheme, keeps the desktop width and never animates every mounted row', () => {
    expect(marked('light')).toContain('color-scheme: light dark');
    expect(CSS).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(CSS).toMatch(/\.app\s*\{[^}]*max-width:\s*900px;/s);
    expect(CSS).not.toMatch(/\.msg-row\s*\{[^}]*animation\s*:/s);
    expect(CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-duration:\s*0\.01ms\s*!important/);
  });

  it('routes key chat surfaces through semantic tokens', () => {
    expect(CSS).toMatch(/\.topbar\s*\{[^}]*background:\s*var\(--surface-glass\)/s);
    expect(CSS).toMatch(/\.composer\s*\{[^}]*background:\s*var\(--surface-glass\)/s);
    expect(CSS).toMatch(/\.bubble-text\.theirs\s*\{[^}]*background:\s*var\(--theirs\)/s);
    expect(CSS).toMatch(/\.bubble-text\.mine\s*\{[^}]*background:\s*var\(--mine\)/s);
    expect(CSS).toMatch(/\.sticker-part\s*\{[^}]*background:\s*var\(--sticker-surface\)/s);
    expect(CSS).toMatch(/\.image-part-placeholder\s*\{[^}]*var\(--shimmer-base\)[^}]*var\(--shimmer-highlight\)/s);
  });
});
```

- [ ] 扩展 `packages/web/src/components/styleTokens.test.ts` 的文件读取：

```ts
const FEATURE = read('./FeatureEnhancements.css');
const ADMIN = read('./AdminPanel.css');
```

在现有 `describe('shared colour tokens', ...)` 追加：

```ts
  it('keeps enhanced chat/gallery surfaces free of literal colours', () => {
    expect(FEATURE).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });

  it('themes gallery and notification surfaces while preserving fixed viewer chrome', () => {
    const themedOverlays = OVERLAYS.slice(OVERLAYS.indexOf('.gallery-page'));
    expect(themedOverlays).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });

  it('does not leave hard-coded light cards or the retired admin blue palette', () => {
    expect(ADMIN).not.toMatch(/background:\s*(?:#fff(?:fff)?\b|rgba\(255,\s*255,\s*255,\s*0\.9[47]\))/i);
    expect(ADMIN).not.toMatch(/#398fe6|#2377ca|#1b5fa5|#eaf4ff|#4c5fd7|#7a8cff/i);
  });
```

- [ ] 运行新测试并确认因主题标记、暗色 token 和旧浅色常量尚不存在/尚未清理而失败：

```powershell
npm.cmd test -w @sooya/web -- src/styles.theme.test.ts src/components/styleTokens.test.ts
```

## Task 2: 建立暖调亮/暗语义 token

**Files:**

- Modify: `packages/web/src/styles.css`
- Test: `packages/web/src/styles.theme.test.ts`

- [ ] 用以下亮色块替换 `styles.css` 文件开头的 `:root`。保留注释标记，测试依赖它们定位 palette：

```css
/* SOOYA — warm companion theme; original design, no third-party assets. */

/* theme:light:start */
:root {
  color-scheme: light dark;
  --bg: #f8f3f8;
  --bg-deep: #eee5f1;
  --bg-glow: #f3e6f5;
  --panel: #fffafc;
  --panel-alt: #f4edf5;
  --surface-raised: #fffafc;
  --surface-hover: #efe6f1;
  --surface-glass: rgba(255, 250, 252, 0.86);
  --ink: #302734;
  --ink-soft: #665b69;
  --ink-faint: #9a8e9e;
  --ink-meta: #6d626f;
  --line: #e2d7e4;
  --line-strong: #cdbed1;
  --accent: #7653a0;
  --accent-deep: #69438f;
  --accent-ink: #fffafc;
  --accent-tint: rgba(118, 83, 160, 0.12);
  --accent-line: rgba(118, 83, 160, 0.34);
  --mine-start: #68468f;
  --mine-end: #7653a0;
  --mine: linear-gradient(135deg, var(--mine-start), var(--mine-end));
  --mine-ink: #fffafc;
  --theirs: #fffafc;
  --theirs-border: #e2d7e4;
  --grad: linear-gradient(135deg, var(--mine-start), var(--mine-end));
  --grad-soft: linear-gradient(135deg, #f2e8f5, #ece7f4);
  --sticker-surface: rgba(118, 83, 160, 0.08);
  --focus-ring: rgba(118, 83, 160, 0.28);
  --success: #16765a;
  --warning: #8a5300;
  --warning-soft: #fff4df;
  --danger: #b82d43;
  --danger-ink: #b82d43;
  --danger-soft: #fff0f2;
  --shimmer-base: #e8dfe9;
  --shimmer-highlight: #fffafc;
  --radius-lg: 18px;
  --radius-sm: 10px;
  --shadow-soft: 0 2px 7px rgba(63, 43, 68, 0.08), 0 14px 30px -16px rgba(63, 43, 68, 0.24);
  --shadow-raised: 0 12px 36px -16px rgba(49, 32, 55, 0.34);
  --topbar-h: 56px;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei',
    'Helvetica Neue', Arial, sans-serif;
}
/* theme:light:end */
```

- [ ] 紧跟亮色块新增系统暗色覆盖：

```css
/* theme:dark:start */
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b171d;
    --bg-deep: #241d27;
    --bg-glow: #33253a;
    --panel: #262029;
    --panel-alt: #302735;
    --surface-raised: #2d2631;
    --surface-hover: #392f3d;
    --surface-glass: rgba(38, 32, 41, 0.86);
    --ink: #f4edf5;
    --ink-soft: #cec2d1;
    --ink-faint: #817486;
    --ink-meta: #b6a8ba;
    --line: #493d4d;
    --line-strong: #65566a;
    --accent: #cdb0ee;
    --accent-deep: #dec8f6;
    --accent-ink: #fffafc;
    --accent-tint: rgba(205, 176, 238, 0.14);
    --accent-line: rgba(205, 176, 238, 0.38);
    --mine-start: #68468f;
    --mine-end: #7653a0;
    --mine-ink: #fffafc;
    --theirs: #2d2631;
    --theirs-border: #4b3f4f;
    --grad-soft: linear-gradient(135deg, #34283a, #302b3e);
    --sticker-surface: rgba(205, 176, 238, 0.10);
    --focus-ring: rgba(205, 176, 238, 0.28);
    --success: #70d3ad;
    --warning: #f0c276;
    --warning-soft: #3a3022;
    --danger: #df6679;
    --danger-ink: #ffb5c0;
    --danger-soft: #3a2229;
    --shimmer-base: #302735;
    --shimmer-highlight: #493b4e;
    --shadow-soft: 0 2px 8px rgba(0, 0, 0, 0.22), 0 16px 34px -18px rgba(0, 0, 0, 0.72);
    --shadow-raised: 0 18px 46px -18px rgba(0, 0, 0, 0.76);
  }
}
/* theme:dark:end */
```

暗色没有重写 `--mine` 和 `--grad`，它们仍引用暗色块覆盖后的 `--mine-start/end`；两个端点保持沉稳深紫，保证白字 4.5:1 以上。

- [ ] 运行 palette 测试：

```powershell
npm.cmd test -w @sooya/web -- src/styles.theme.test.ts
```

预期：token 完整性与所有对比度测试通过；关键表面测试仍会失败，直到 Task 3。

- [ ] 提交 token 基础：

```powershell
git add packages/web/src/styles.css packages/web/src/styles.theme.test.ts packages/web/src/components/styleTokens.test.ts
git commit -m "feat(web): define warm system theme tokens"
```

## Task 3: 把聊天主界面接到主题并保持低动效

**Files:**

- Modify: `packages/web/src/styles.css`
- Test: `packages/web/src/styles.theme.test.ts`

- [ ] 把页面背景和 900px app 表面改为层叠暖调背景；宽度值不变：

```css
body {
  font-family: var(--font);
  background:
    radial-gradient(circle at 12% -12%, var(--bg-glow), transparent 34rem),
    linear-gradient(180deg, var(--bg-deep), var(--bg));
  color: var(--ink);
  font-size: 15px;
  line-height: 1.5;
  overscroll-behavior-y: none;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  max-width: 900px;
  margin: 0 auto;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  position: relative;
}
```

- [ ] 顶栏、输入区、历史工具、通知/更新提示统一表面：

```css
.topbar {
  background: var(--surface-glass);
  backdrop-filter: saturate(140%) blur(16px);
  border-bottom: 1px solid var(--line);
}

.composer {
  background: var(--surface-glass);
  backdrop-filter: saturate(140%) blur(16px);
  border-top: 1px solid var(--line);
}

.topbar-admin-entry {
  border-color: var(--line-strong);
  background: var(--surface-raised);
  color: var(--accent-deep);
}

.topbar-admin-entry:hover,
.topbar-admin-entry:focus-visible,
.history-tool-button:hover {
  border-color: var(--accent);
  background: var(--surface-hover);
  color: var(--accent-deep);
}

.history-tools,
.sw-update {
  background: var(--surface-glass);
  border-color: var(--accent-line);
  box-shadow: var(--shadow-raised);
  backdrop-filter: blur(16px);
}
```

删除这些 selector 中的 `#fff`、白色 rgba、旧蓝灰 border/color 和硬编码 shadow。

- [ ] 更新气泡形状与方向，不改变布局宽度：

```css
.bubble-text.theirs {
  background: var(--theirs);
  color: var(--ink);
  border: 1px solid var(--theirs-border);
  border-radius: 7px 18px 18px 18px;
}

.bubble-text.mine {
  background: var(--mine);
  color: var(--mine-ink);
  border: 1px solid transparent;
  border-radius: 18px 7px 18px 18px;
}

.bubble-note {
  background: var(--warning-soft);
  color: var(--warning);
  border: 1px solid color-mix(in srgb, var(--warning) 32%, transparent);
}

.system-row span {
  background: var(--surface-hover);
  color: var(--ink-meta);
}

.sticker-part {
  width: 108px;
  height: 108px;
  padding: 5px;
  object-fit: contain;
  display: block;
  border-radius: 20px;
  background: var(--sticker-surface);
  filter: drop-shadow(0 8px 14px color-mix(in srgb, var(--ink) 12%, transparent));
}
```

发送/接收方向仍由 `.mine` / `.theirs` 和左右布局共同表达；不新增伪元素尾巴，避免窄屏和连续气泡出现断裂。

- [ ] 把所有交互焦点统一为可见 token：

```css
:where(button, a, input, textarea, select):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.composer-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus-ring);
}
```

保留组件更具体的 focus 样式，但不得用 `outline: none` 而不提供等价可见 ring。

- [ ] 将 Task 2 产生的图片 placeholder 接入 shimmer：

```css
.image-part-placeholder {
  background: linear-gradient(
    100deg,
    var(--shimmer-base) 20%,
    var(--shimmer-highlight) 42%,
    var(--shimmer-base) 64%
  );
  background-size: 220% 100%;
  animation: skeleton-shimmer 1.4s ease-in-out infinite;
}
```

将 `.avatar-skeleton`、`.message-skeleton` 和 skeleton 内条的硬编码白色 rgba 改为 `--shimmer-base` / `--shimmer-highlight`。

- [ ] 把以下语义类别的剩余硬编码颜色逐一换成 token：

| 类别 | 使用 token |
|---|---|
| 状态成功点 | `--success` |
| 连接中点 | `--warning` |
| 失败文字/背景/边框 | `--danger-ink` / `--danger-soft` / `--danger` |
| hover、system、速度按钮底 | `--surface-hover` |
| 菜单/历史/引用底 | `--surface-raised` 或 `--surface-glass` |
| 菜单次要文字、时间 | `--ink-meta` |
| 主按钮字 | `--accent-ink` |
| 紫色高亮/引用线 | `--accent-tint` / `--accent-line` |
| toast 上的关闭字 | `color-mix(in srgb, var(--accent-ink) 72%, transparent)` |

特别删除 `#fde68a` 搜索高亮，改为：

```css
.history-tools mark {
  background: var(--warning-soft);
  color: var(--ink);
}
```

- [ ] 保留并加强 reduced-motion 规则，不隐藏状态变化：

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

不得新增 `.msg-row { animation: ... }`；虚拟列表复用/重挂载行时会重复播放。

- [ ] 运行主题、overlay stacking 与完整组件样式测试：

```powershell
npm.cmd test -w @sooya/web -- src/styles.theme.test.ts src/styles.overlayStacking.test.ts src/components/styleTokens.test.ts
```

预期：root、关键聊天表面、900px、无全局行动画和 overlay 层级全部通过。

- [ ] 提交聊天视觉系统：

```powershell
git add packages/web/src/styles.css
git commit -m "feat(web): apply warm companion chat surfaces"
```

## Task 4: 统一图库、弹层与增强样式

**Files:**

- Modify: `packages/web/src/components/overlays.css`
- Modify: `packages/web/src/components/FeatureEnhancements.css`
- Modify: `packages/web/src/components/styleTokens.test.ts`

- [ ] 保留 `overlays.css` 从 `.image-viewer` 到 `.image-viewer-hint` 的固定近黑/白色观看器配色；只把 `.image-part:disabled` 补为等待光标：

```css
.image-part:disabled {
  cursor: wait;
}
```

- [ ] 从 `.gallery-page` 开始把页面表面全部改为共享 token：

```css
.gallery-page {
  min-height: 100dvh;
  padding: calc(18px + env(safe-area-inset-top)) 18px calc(28px + env(safe-area-inset-bottom));
  background:
    radial-gradient(circle at 14% -10%, var(--bg-glow), transparent 32rem),
    var(--bg);
  color: var(--ink);
}

.gallery-header button,
.gallery-item-actions button,
.gallery-login button {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 9px 13px;
  background: var(--surface-raised);
  color: var(--ink);
  box-shadow: var(--shadow-soft);
}

.gallery-item,
.gallery-login {
  background: var(--surface-raised);
  border-color: var(--line);
  box-shadow: var(--shadow-soft);
}

.gallery-thumb { background: var(--shimmer-base); }
.gallery-item small,
.gallery-loading-more { color: var(--ink-meta); }
.gallery-login input { background: var(--panel); color: var(--ink); }
```

- [ ] 把 `.notification-optin` 改为主题玻璃表面，按钮使用可读 gradient：

在现有 `.notification-optin` 规则内只替换下列 declarations，原有
`position: absolute`、`z-index: 80`、top/right、尺寸、padding 与 flex 布局原样保留：

```css
  border: 1px solid var(--accent-line);
  background: var(--surface-glass);
  box-shadow: var(--shadow-raised);
  color: var(--ink);
  backdrop-filter: blur(16px);
```

把现有 `.notification-optin button` 规则中的 background/color 改为：

```css
.notification-optin button {
  background: var(--grad);
  color: var(--accent-ink);
}
```

不得改成 `position: fixed`，不得降低其与 `.sw-update` 的既有层级契约。

- [ ] 将 `FeatureEnhancements.css` 从 8 行压缩格式展开，并完整替换为以下 token 化版本：

```css
.gallery-toolbar,
.gallery-batchbar {
  max-width: 1120px;
  margin: 0 auto 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-raised);
  box-shadow: var(--shadow-soft);
}

.gallery-toolbar input[type='search'] { flex: 1 1 260px; }

.gallery-toolbar input,
.gallery-toolbar select,
.gallery-toolbar button,
.gallery-batchbar button {
  min-height: 38px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  padding: 7px 10px;
  background: var(--panel);
  color: var(--ink);
}

.gallery-toolbar label { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.gallery-batchbar span { font-weight: 700; color: var(--accent-deep); }
.gallery-item-actions { flex-wrap: wrap; }
.gallery-item-actions button { flex: 1 1 auto; padding: 7px 8px; font-size: 12px; }
.notification-optin small { display: block; color: var(--ink-soft); }
.notification-optin button:disabled { opacity: 0.6; }

.message-menu-button {
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.64;
  padding: 0 4px;
}

.message-action-menu {
  width: 210px;
  display: grid;
  gap: 2px;
  padding: 7px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-glass);
  box-shadow: var(--shadow-raised);
  backdrop-filter: blur(16px);
}

.message-action-menu button {
  border: 0;
  border-radius: 9px;
  padding: 10px 12px;
  background: transparent;
  text-align: left;
  color: var(--ink);
}

.message-action-menu button:hover,
.message-action-menu button:focus-visible { background: var(--surface-hover); }
.message-action-menu button.danger { color: var(--danger-ink); }

.message-reply-preview {
  max-width: 330px;
  margin: 0 0 4px;
  padding: 5px 9px;
  border-left: 3px solid var(--accent);
  border-radius: 7px;
  background: var(--surface-hover);
  font-size: 11px;
  color: var(--ink-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-quote {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 auto;
  padding: 8px 14px;
  width: min(100%, 760px);
  border-top: 1px solid var(--line);
  background: var(--surface-glass);
  color: var(--ink);
  font-size: 12px;
}

.composer-quote div { min-width: 0; display: flex; gap: 8px; }
.composer-quote span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-meta); }
.composer-quote button { border: 0; background: transparent; font-size: 22px; color: var(--ink-soft); }
.image-viewer-current { transform-origin: center center; }
.image-viewer-actions { max-width: calc(100vw - 24px); flex-wrap: wrap; justify-content: flex-end; }
.admin-form-card audio { width: 100%; margin-top: 8px; }
.admin-form-card img { display: block; margin: 10px 0; }
.admin-list-row input,
.admin-list-row select { min-width: 0; }
.admin-sidebar-footer { display: grid; gap: 7px; }
.admin-side-action { display: block; text-decoration: none; }

@media (max-width: 640px) {
  .gallery-toolbar,
  .gallery-batchbar { align-items: stretch; }
  .gallery-toolbar > * { flex: 1 1 44%; }
  .gallery-toolbar input[type='search'] { flex-basis: 100%; }
  .message-action-menu { width: min(78vw, 240px); }
  .composer-quote { width: 100%; }
  .admin-summary { grid-template-columns: 1fr; }
  .image-viewer-action { font-size: 12px; min-width: 42px; padding: 0 9px; }
}
```

- [ ] 运行共享 token 与层级测试：

```powershell
npm.cmd test -w @sooya/web -- src/components/styleTokens.test.ts src/styles.overlayStacking.test.ts
```

预期：`FeatureEnhancements.css` 没有 hex/rgb literal；`overlays.css` 从 `.gallery-page` 起没有 literal；图片查看器和 update prompt 层级仍通过。

- [ ] 提交图库与弹层：

```powershell
git add packages/web/src/components/overlays.css packages/web/src/components/FeatureEnhancements.css packages/web/src/components/styleTokens.test.ts
git commit -m "feat(web): theme gallery and overlay surfaces"
```

## Task 5: 将管理中心映射到同一视觉系统

**Files:**

- Modify: `packages/web/src/components/AdminPanel.css`
- Test: `packages/web/src/components/styleTokens.test.ts`

- [ ] 用共享 token 替换 `.admin-v2` 顶部的旧蓝色 palette；保留 admin 别名以避免重写全部 selector：

```css
.admin-v2 {
  --admin-bg: var(--bg);
  --admin-surface: var(--surface-raised);
  --admin-surface-soft: var(--panel-alt);
  --admin-line: var(--line);
  --admin-line-strong: var(--line-strong);
  --admin-text: var(--ink);
  --admin-muted: var(--ink-soft);
  --admin-faint: var(--ink-faint);
  --admin-primary: var(--mine-end);
  --admin-primary-deep: var(--mine-start);
  --admin-primary-deeper: var(--accent-deep);
  --admin-primary-soft: var(--accent-tint);
  --admin-success: var(--success);
  --admin-warning: var(--warning);
  --admin-warning-soft: var(--warning-soft);
  --admin-danger: var(--danger-ink);
  --admin-danger-soft: var(--danger-soft);
  --admin-on-primary: var(--accent-ink);
  --admin-focus-ring: var(--focus-ring);
  --admin-grad: var(--grad);
  --admin-grad-soft: var(--grad-soft);
  --admin-sidebar-start: #2a2030;
  --admin-sidebar-end: #392946;
  --admin-sidebar-text: #f5edf6;
  --admin-sidebar-muted: #cbbcd0;
  --admin-sidebar-faint: #9c8ea2;
  --admin-radius: 16px;
  --admin-sh-1: var(--shadow-soft);
  --admin-sh-2: var(--shadow-raised);
  width: 100%;
  max-width: none;
  min-height: 100dvh;
  margin: 0;
  padding: 0;
  color: var(--admin-text);
  background: var(--admin-bg);
}
```

侧栏在两个系统主题中都保持暖深紫，因此其四个 `--admin-sidebar-*` 是局部固定配色；页面卡片、表单和文字必须随 root 切换。

- [ ] 将侧栏 selector 精确改用局部 token：

| Selector | 替换 |
|---|---|
| `.admin-sidebar` | gradient 改为 `var(--admin-sidebar-start/end)` |
| `.admin-brand-mark`, active nav, `.admin-primary` 文字 | `var(--admin-on-primary)` |
| `.admin-brand-copy strong`, hover nav/action | `var(--admin-sidebar-text)` |
| 普通 nav/action | `var(--admin-sidebar-muted)` |
| group label、nav small | `var(--admin-sidebar-faint)` |
| active nav small | `color-mix(in srgb, var(--admin-on-primary) 76%, transparent)` |
| sidebar alpha border/background | 保留白色低 alpha；它们只叠在固定深侧栏上 |

- [ ] 将所有主内容硬编码浅色表面按下表替换；不要全局盲替 `#fff`，图片查看/侧栏文字需保留语义：

| 现有用途 / selector | 新值 |
|---|---|
| `.admin-side-action:hover`, form input/select/textarea、普通 button、loading/error card、mobile tab、preset row | `background: var(--admin-surface)` |
| `.admin-lock-card`, `.admin-mobile-header` | `background: var(--surface-glass)` |
| preset form/action | `background: var(--admin-surface-soft)` |
| 所有 `#edf0f4`, `#e6e9f0`, `#dfe3ec`, `#d9e4ef` 分隔/边框 | `var(--admin-line)` 或 `var(--admin-line-strong)` |
| 所有 `#526174`, `#536074`, `#475467`, `#596579`, `#5e6a7d`, `#6b7688`, `#78839a`, `#57617a` 内容文字 | `var(--admin-muted)`；正文信息用 `var(--admin-text)` |
| `#75afe8`, `#7a8cff` focus/active border | `var(--admin-primary)` |
| 蓝色 focus rgba | `var(--admin-focus-ring)` |
| `#fff9e9` / `#7a4e08` / `#f0dda7` inline warning | `var(--admin-warning-soft)` / `var(--admin-warning)` / `color-mix(in srgb, var(--admin-warning) 32%, transparent)` |
| `#fff1f2`, `#f0c4c7`, `#b42318`, `#b4342c` danger | `--admin-danger-soft` / `--admin-danger` |
| `#4c5fd7`, `#4a49b8` summary/eyebrow/preset accent | `--admin-primary-deep` |
| 硬编码蓝色/靛蓝 shadow | `var(--admin-sh-1)` / `var(--admin-sh-2)` 或 `color-mix(in srgb, var(--admin-primary) 32%, transparent)` |
| life progress 紫绿 | `linear-gradient(90deg, var(--admin-primary), var(--admin-success))` |

- [ ] 更新关键控件的完整规则，确保暗色 input 和按钮不会残留白底：

```css
.admin-v2 .admin-form-card input,
.admin-v2 .admin-form-card textarea,
.admin-v2 .admin-form-card select,
.admin-v2 .admin-lock-card input {
  color: var(--admin-text);
  background: var(--admin-surface);
  border-color: var(--admin-line-strong);
}

.admin-v2 .admin-form-card input:focus,
.admin-v2 .admin-form-card textarea:focus,
.admin-v2 .admin-form-card select:focus,
.admin-v2 .admin-lock-card input:focus {
  border-color: var(--admin-primary);
  box-shadow: 0 0 0 3px var(--admin-focus-ring);
}

.admin-v2 .admin-actions button:not(.admin-danger),
.admin-v2 .admin-card-heading > button,
.admin-primary,
.admin-v2 .admin-lock-card button,
.admin-v2 .admin-error button {
  color: var(--admin-on-primary);
  background: var(--admin-grad);
  border-color: transparent;
}

.admin-v2 .admin-lock-card,
.admin-mobile-header {
  background: var(--surface-glass);
  border-color: var(--admin-line);
  box-shadow: var(--admin-sh-2);
  backdrop-filter: blur(16px);
}
```

- [ ] 删除或改写仍描述“calm blue”“old violet-blue”的过期 CSS 注释。运行以下搜索，结果只允许出现在 `.admin-v2` 的固定暖深侧栏 token 中，不允许出现旧蓝 palette：

```powershell
rg -n "#398fe6|#2377ca|#1b5fa5|#eaf4ff|#4c5fd7|#7a8cff|calm blue|violet-blue" packages/web/src/components/AdminPanel.css
```

预期：无输出。

- [ ] 搜索硬编码浅色卡片：

```powershell
rg -n "background:\s*(#fff|#ffffff|rgba\(255,\s*255,\s*255,\s*0\.9[47]\))" packages/web/src/components/AdminPanel.css
```

预期：无输出。

- [ ] 运行 token、后台组件和类型回归：

```powershell
npm.cmd test -w @sooya/web -- src/components/styleTokens.test.ts src/components/adminConsole.test.ts
npm.cmd run typecheck -w @sooya/web
```

预期：旧蓝 palette 与浅色卡片检查通过，后台静态功能契约与类型检查仍通过。

- [ ] 提交管理中心主题：

```powershell
git add packages/web/src/components/AdminPanel.css
git commit -m "feat(web): align admin console with warm system theme"
```

## Task 6: 真实浏览器验证系统主题、视口与减少动画

**Files:**

- Create: `e2e/theme.e2e.ts`
- Modify: `docs/LIMITATIONS.md`

- [ ] 新增 `e2e/theme.e2e.ts`：

```ts
import { expect, test, type Page } from '@playwright/test';

const CHAT_TOKEN = 'e2e-chat-token';
const ADMIN_TOKEN = 'e2e-admin-token';

async function installTokens(page: Page): Promise<void> {
  await page.addInitScript(({ chat, admin }) => {
    localStorage.setItem('sooya.token', chat);
    localStorage.setItem('sooya.admin-token', admin);
  }, { chat: CHAT_TOKEN, admin: ADMIN_TOKEN });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport);
}

test.beforeEach(async ({ page }) => { await installTokens(page); });

test('follows the system light and warm-dark palettes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.getByTestId('scroller')).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()))
    .toBe('#f8f3f8');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()))
    .toBe('#1b171d');
  const dark = await page.evaluate(() => ({
    topbar: getComputedStyle(document.querySelector('.topbar')!).backgroundColor,
    composer: getComputedStyle(document.querySelector('.composer')!).backgroundColor,
    body: getComputedStyle(document.body).color
  }));
  expect(dark.topbar).not.toBe('rgb(255, 255, 255)');
  expect(dark.composer).not.toBe('rgb(255, 255, 255)');
  expect(dark.body).toBe('rgb(244, 237, 245)');
});

test('themes chat, gallery and admin without horizontal overflow', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 844, height: 390 },
    { width: 1280, height: 860 }
  ]) {
    await page.setViewportSize(viewport);

    await page.goto('/');
    await expect(page.getByTestId('scroller')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const appWidth = await page.locator('.app').evaluate((element) => element.getBoundingClientRect().width);
    expect(appWidth).toBeLessThanOrEqual(900);

    await page.goto('/gallery');
    await expect(page.locator('.gallery-page')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto('/admin/features');
    await expect(page.locator('.admin-v2')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test('reduces shimmer and transition motion without hiding loading surfaces', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/');
  const motion = await page.evaluate(() => {
    const placeholder = document.createElement('span');
    placeholder.className = 'image-part-placeholder';
    document.body.append(placeholder);
    const style = getComputedStyle(placeholder);
    const result = { duration: style.animationDuration, iterations: style.animationIterationCount };
    placeholder.remove();
    return result;
  });
  expect(motion.duration).toBe('0.01ms');
  expect(motion.iterations).toBe('1');
});
```

- [ ] 更新 `docs/LIMITATIONS.md` 的旧主题条目：

```md
- 前端会跟随系统浅色/深色偏好，聊天、图库与管理中心共享暖调主题；当前不提供应用内手动主题切换器。
```

- [ ] 先构建真实 E2E 静态产物，再运行 theme desktop 用例：

```powershell
npm.cmd run build
npm.cmd run test:e2e -- --project=desktop theme.e2e.ts
```

预期：亮/暗 token 热切换、三页面、三 viewport 和 reduced-motion 全部通过。

- [ ] 在真实 Chromium 中做视觉 QA，分别检查亮色与暗色：

1. 375×812：输入区 safe-area、长消息、图片占位、贴纸、消息菜单。
2. 844×390：横屏输入区、顶部工具、图库双列/多列切换、后台 mobile tabs。
3. 1280×860：聊天宽度严格不超过 900px，背景从聊天容器外仍有暖调层次；后台宽屏 sidebar 与卡片清晰。
4. 两种主题都检查 incoming/outgoing 形状、正常/hover/focus/disabled/error/loading 状态。
5. reduced motion 下确认 shimmer 与 highlight 不持续运动，但 loading 结构仍可见。

若发现需要改变已经确认的视觉规则，才回到用户做 UI 选择；单纯的对比度、溢出、错色直接按本计划修正。

- [ ] 提交 E2E 与文档：

```powershell
git add e2e/theme.e2e.ts docs/LIMITATIONS.md
git commit -m "test(web): cover warm light and dark themes"
```

## Task 7: 全量回归与最终自审

- [ ] 运行三个计划共同影响的全部验证：

```powershell
npm.cmd test -w @sooya/web
npm.cmd run typecheck -w @sooya/web
npm.cmd run build
npm.cmd run test:e2e -- --project=desktop chat.e2e.ts navigation.e2e.ts theme.e2e.ts
npm.cmd run test:e2e -- --project=mobile theme.e2e.ts
```

预期：全部测试、类型检查、构建和 desktop/mobile E2E 通过。

- [ ] 搜索视觉回归禁区：

```powershell
rg -n "\.msg-row\s*\{[^}]*animation|#398fe6|#2377ca|#1b5fa5|#eaf4ff|background:\s*rgba\(255,\s*255,\s*255,\s*0\.9[47]\)" packages/web/src
```

预期：无输出；图片查看器的固定黑/白 chrome 不在这些禁区内。

- [ ] 检查差异与最终工作区：

```powershell
git diff --check
git status --short
```

预期：无空白错误；完成最后提交后工作区为空。

## 完成标准

- 系统亮/暗偏好无需重载即可切换；聊天、图库和管理中心没有孤立浅色卡片。
- 普通文字达到 4.5:1；焦点强调达到 3:1；发送气泡两个 gradient 端点均保证白字 4.5:1。
- 视觉为暖白/薰衣草与暖黑紫，不出现旧冷蓝 palette 或赛博霓虹。
- 900px 桌面宽度不变，三种目标 viewport 无横向溢出。
- 不添加全局消息挂载动画；reduced-motion 同时覆盖元素和伪元素。
- 图片查看器保持固定近黑观看环境；其余主题表面只消费语义 token。
- 不新增运行时依赖、网络字体或手动主题状态。
