# Visual Time Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 SOOYA 在普通回复图片和主动图片中始终保留真实当前时间，并把与当前时段冲突的明确图片要求转换为不改写现实的回溯画面。

**Architecture:** 新建纯函数 `visual-time.ts`，一次性解析真实时钟、用户明确时段和主动事件时间，生成同时包含“现实当前时间”和“画面时间”的双时钟上下文。`Replier` 和 `ProactiveComposer` 分别在文本规划入口计算它，随后原样传给 `MediaDirector`、`ImageContinuityService`、最终图片提示词和有界元数据；回溯图片只生成媒体，不提交当天视觉连续性状态。

**Tech Stack:** TypeScript 5、Node.js 20、Vitest、Fastify 测试 harness、SQLite 媒体元数据。

---

## File map

- Create `packages/server/src/core/visual-time.ts`: 唯一的时段边界、显式时段识别、双时钟解析、提示词和元数据投影。
- Create `packages/server/test/visual-time.test.ts`: 纯函数边界和 13:17 回归测试。
- Modify `packages/server/src/core/context.ts`: 把同一份双时钟事实写入主模型上下文。
- Modify `packages/server/src/core/replier.ts`: 在回复规划阶段只解析一次时间，并把结果传到图片链路。
- Modify `packages/server/src/core/mediaDirector.ts`: 将双时钟作为结构化 continuity 数据传入导演，并强化 fallback prompt。
- Modify `packages/server/src/core/image-continuity.ts`: 在最终提示词层强制时间/光照，隔离回溯图片与当前 Life/穿搭状态。
- Modify `packages/server/src/core/proactive.ts`: 用事件发生时间作为主动图片的画面时间，用发布时钟作为当前时间。
- Modify `packages/server/test/image-continuity.test.ts`: 验证 stale 夜景覆盖、显式夜景回溯和回溯不提交。
- Modify `packages/server/test/media-director-continuity.test.ts`: 验证导演输入与 fallback 都包含双时钟。
- Modify `packages/server/test/daily-visual-continuity-integration.test.ts`: 覆盖普通回复的真实 13:17 复现和元数据。
- Modify `packages/server/test/proactive-composer.test.ts`: 覆盖主动事件时间、发布时钟和元数据。
- Modify `packages/server/test/reply-coordinator.test.ts`: 补齐新增的 `TextGenerationResult.visualTime` 测试夹具。

### Task 1: Pure visual-time resolver

**Files:**
- Create: `packages/server/src/core/visual-time.ts`
- Create: `packages/server/test/visual-time.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Create `packages/server/test/visual-time.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ensureVisualTimeReplyText,
  resolveVisualTime,
  visualDayPeriodOfHour,
  visualTimeMetadata
} from '../src/core/visual-time.js';

const AT_1317 = '2026-08-26T05:17:00.000Z';

describe('visual time', () => {
  it.each([
    [0, 'late-night'], [4, 'late-night'],
    [5, 'morning'], [10, 'morning'],
    [11, 'midday'], [13, 'midday'],
    [14, 'afternoon'], [17, 'afternoon'],
    [18, 'evening'], [23, 'evening']
  ] as const)('maps local hour %i to %s', (hour, expected) => {
    expect(visualDayPeriodOfHour(hour)).toBe(expected);
  });

  it('keeps an unspecified continuation at the real 13:17 clock', () => {
    expect(resolveVisualTime({
      now: AT_1317,
      timeZone: 'Asia/Shanghai',
      latestUserText: '再来一张'
    })).toEqual({
      timeZone: 'Asia/Shanghai',
      currentInstant: AT_1317,
      currentLocalDate: '2026-08-26',
      currentLocalTime: '13:17:00',
      currentDayPeriod: 'midday',
      mode: 'current',
      depictedLocalDate: '2026-08-26',
      depictedDayPeriod: 'midday',
      requestedDayPeriod: null
    });
  });

  it.each(['晚上睡觉的照片', '今晚睡觉那种', 'a sleeping photo at night'])('turns an explicit conflicting night scene into yesterday (%s)', (latestUserText) => {
    expect(resolveVisualTime({ now: AT_1317, timeZone: 'Asia/Shanghai', latestUserText })).toMatchObject({
      currentLocalDate: '2026-08-26',
      currentLocalTime: '13:17:00',
      currentDayPeriod: 'midday',
      mode: 'retrospective',
      depictedLocalDate: '2026-08-25',
      depictedDayPeriod: 'evening',
      requestedDayPeriod: 'evening'
    });
  });

  it('keeps a matching night request current', () => {
    expect(resolveVisualTime({
      now: '2026-08-26T12:30:00.000Z',
      timeZone: 'Asia/Shanghai',
      latestUserText: '拍一张晚上在家的照片'
    })).toMatchObject({ mode: 'current', currentDayPeriod: 'evening', depictedLocalDate: '2026-08-26' });
  });

  it('replaces non-past image copy with a deterministic retrospective acknowledgement', () => {
    const time = resolveVisualTime({
      now: AT_1317,
      timeZone: 'Asia/Shanghai',
      latestUserText: '发张晚上睡觉的照片'
    });
    expect(ensureVisualTimeReplyText('好呀，现在拍给你。', time, true)).toBe('现在还是中午，不过昨天倒是有一张这种。');
    expect(ensureVisualTimeReplyText('昨晚困得很早，倒是拍了一张。', time, true)).toBe('昨晚困得很早，倒是拍了一张。');
    expect(ensureVisualTimeReplyText('好呀，现在拍给你。', time, false)).toBe('好呀，现在拍给你。');
  });

  it('uses the actual historical event time for proactive media', () => {
    const resolved = resolveVisualTime({
      now: '2026-08-26T10:30:00.000Z',
      timeZone: 'Asia/Shanghai',
      eventAt: '2026-08-26T06:00:00.000Z'
    });
    expect(resolved).toMatchObject({
      currentDayPeriod: 'evening',
      mode: 'retrospective',
      depictedLocalDate: '2026-08-26',
      depictedDayPeriod: 'afternoon',
      requestedDayPeriod: null
    });
    expect(visualTimeMetadata(resolved)).toEqual({
      timeMode: 'retrospective',
      timeZone: 'Asia/Shanghai',
      currentInstant: '2026-08-26T10:30:00.000Z',
      currentDayPeriod: 'evening',
      depictedLocalDate: '2026-08-26',
      depictedDayPeriod: 'afternoon',
      requestedDayPeriod: null
    });
  });

  it('falls back conservatively when timezone formatting fails', () => {
    expect(resolveVisualTime({
      now: AT_1317,
      timeZone: 'Invalid/Zone',
      latestUserText: '发张晚上睡觉的照片'
    })).toMatchObject({
      timeZone: 'Invalid/Zone',
      currentInstant: AT_1317,
      mode: 'current',
      requestedDayPeriod: null
    });
  });
});
```

- [ ] **Step 2: Run the new test and confirm the expected red state**

Run:

```powershell
npm run test -w @sooya/server -- test/visual-time.test.ts
```

Expected: FAIL because `../src/core/visual-time.js` does not exist.

- [ ] **Step 3: Implement the pure resolver**

Create `packages/server/src/core/visual-time.ts`:

```ts
import { addDaysLocalDate, zonedParts } from '../util/time-zone.js';

export type VisualDayPeriod = 'late-night' | 'morning' | 'midday' | 'afternoon' | 'evening';

export interface VisualTimeContext {
  timeZone: string;
  currentInstant: string;
  currentLocalDate: string;
  currentLocalTime: string;
  currentDayPeriod: VisualDayPeriod;
  mode: 'current' | 'retrospective';
  depictedLocalDate: string;
  depictedDayPeriod: VisualDayPeriod;
  requestedDayPeriod: VisualDayPeriod | null;
}

export interface ResolveVisualTimeInput {
  now: string | Date;
  timeZone?: string | null;
  latestUserText?: string | null;
  eventAt?: string | Date | null;
}

const PERIOD_PATTERNS: ReadonlyArray<readonly [VisualDayPeriod, RegExp]> = [
  ['late-night', /凌晨|半夜|深夜|late[- ]?night|after midnight/iu],
  ['morning', /清晨|早晨|早上|上午|morning/iu],
  ['midday', /中午|午间|正午|noon|midday/iu],
  ['afternoon', /下午|午后|afternoon/iu],
  ['evening', /傍晚|晚上|今晚|夜里|夜晚|睡前|晚安|evening|tonight|at night|nighttime|bedtime/iu]
];
const EXPLICIT_PAST_RE = /昨天|昨日|昨晚|昨夜|yesterday|last night/iu;

function asValidDate(value: string | Date): Date | null {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localFields(at: Date, requestedZone: string): {
  timeZone: string;
  date: string;
  time: string;
  period: VisualDayPeriod;
  fallback: boolean;
} {
  try {
    const parts = zonedParts(at, requestedZone);
    return {
      timeZone: requestedZone,
      date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
      time: `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`,
      period: visualDayPeriodOfHour(parts.hour),
      fallback: false
    };
  } catch {
    const parts = zonedParts(at, 'UTC');
    return {
      timeZone: requestedZone,
      date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
      time: `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`,
      period: visualDayPeriodOfHour(parts.hour),
      fallback: true
    };
  }
}

export function visualDayPeriodOfHour(hour: number): VisualDayPeriod {
  if (hour < 5) return 'late-night';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

export function requestedVisualDayPeriod(text: string | null | undefined): VisualDayPeriod | null {
  const normalized = text?.normalize('NFKC').trim();
  if (!normalized) return null;
  return PERIOD_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
}

export function resolveVisualTime(input: ResolveVisualTimeInput): VisualTimeContext {
  const currentAt = asValidDate(input.now) ?? new Date();
  const current = localFields(currentAt, input.timeZone?.trim() || 'Asia/Shanghai');
  const base = {
    timeZone: current.timeZone,
    currentInstant: currentAt.toISOString(),
    currentLocalDate: current.date,
    currentLocalTime: current.time,
    currentDayPeriod: current.period
  };

  if (current.fallback) {
    return {
      ...base,
      mode: 'current',
      depictedLocalDate: current.date,
      depictedDayPeriod: current.period,
      requestedDayPeriod: null
    };
  }

  if (input.eventAt) {
    const eventAt = asValidDate(input.eventAt);
    if (eventAt && eventAt.getTime() <= currentAt.getTime()) {
      const event = localFields(eventAt, current.timeZone);
      const retrospective = event.date !== current.date || event.period !== current.period;
      return {
        ...base,
        mode: retrospective ? 'retrospective' : 'current',
        depictedLocalDate: retrospective ? event.date : current.date,
        depictedDayPeriod: retrospective ? event.period : current.period,
        requestedDayPeriod: null
      };
    }
  }

  const requested = requestedVisualDayPeriod(input.latestUserText);
  const explicitlyPast = EXPLICIT_PAST_RE.test(input.latestUserText ?? '');
  if (!requested || (requested === current.period && !explicitlyPast)) {
    return {
      ...base,
      mode: 'current',
      depictedLocalDate: current.date,
      depictedDayPeriod: current.period,
      requestedDayPeriod: requested
    };
  }

  return {
    ...base,
    mode: 'retrospective',
    depictedLocalDate: addDaysLocalDate(current.date, -1),
    depictedDayPeriod: requested,
    requestedDayPeriod: requested
  };
}

export function visualTimeReplyInstruction(value: VisualTimeContext): string {
  const current = `${value.currentLocalDate} ${value.currentLocalTime} (${value.currentDayPeriod}, ${value.timeZone})`;
  if (value.mode === 'current') {
    return `【视觉时间硬规则】真实当前时间是 ${current}。如果这轮生成图片，未明确指定其他时段的画面必须符合这个当前时段；不要从旧图片提示词继承冲突的时段或光照。`;
  }
  return `【视觉时间硬规则】真实当前时间仍是 ${current}，不可被用户的画面要求改写。如果这轮生成图片，用户要求的是 ${value.depictedLocalDate} 的 ${value.depictedDayPeriod} 回溯画面；正文必须自然使用过去式，例如“昨天倒是有一张这种”，不得声称画面正在当前发生。允许新生成回溯画面，但不得声称它是已存历史照片。`;
}

const PERIOD_LABELS: Record<VisualDayPeriod, string> = {
  'late-night': '凌晨',
  morning: '早上',
  midday: '中午',
  afternoon: '下午',
  evening: '晚上'
};
const RETROSPECTIVE_WORDING_RE = /昨天|昨日|昨晚|昨夜|之前|当时|那天|前一晚|yesterday|last night|earlier/iu;

export function ensureVisualTimeReplyText(text: string, value: VisualTimeContext, hasImage: boolean): string {
  if (!hasImage || value.mode !== 'retrospective' || RETROSPECTIVE_WORDING_RE.test(text)) return text;
  return `现在还是${PERIOD_LABELS[value.currentDayPeriod]}，不过昨天倒是有一张这种。`;
}

export function visualDayPeriodLighting(period: VisualDayPeriod): string {
  if (period === 'late-night') return 'deep-night darkness with plausible indoor or street lighting';
  if (period === 'morning') return 'natural morning daylight';
  if (period === 'midday') return 'clear natural midday daylight';
  if (period === 'afternoon') return 'natural afternoon daylight';
  return 'plausible evening or night lighting, never daylight presented as current';
}

export function visualTimeMetadata(value: VisualTimeContext): Record<string, string | null> {
  return {
    timeMode: value.mode,
    timeZone: value.timeZone,
    currentInstant: value.currentInstant,
    currentDayPeriod: value.currentDayPeriod,
    depictedLocalDate: value.depictedLocalDate,
    depictedDayPeriod: value.depictedDayPeriod,
    requestedDayPeriod: value.requestedDayPeriod
  };
}
```

- [ ] **Step 4: Run the resolver tests and confirm green**

Run:

```powershell
npm run test -w @sooya/server -- test/visual-time.test.ts
```

Expected: PASS, including all five half-open period boundaries and the 13:17 regression cases.

- [ ] **Step 5: Commit the resolver**

```powershell
git add -- packages/server/src/core/visual-time.ts packages/server/test/visual-time.test.ts
git commit -m "feat: resolve visual time context"
```

### Task 2: Main reply planning uses one immutable clock

**Files:**
- Modify: `packages/server/src/core/context.ts:1-15,66-83,271-278`
- Modify: `packages/server/src/core/replier.ts:18-95,155-225,500-518`
- Modify: `packages/server/test/reply-coordinator.test.ts:18-32`
- Create: `packages/server/test/replier-visual-time.test.ts`

- [ ] **Step 1: Write the failing reply-planning integration test**

Create `packages/server/test/replier-visual-time.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

describe('reply visual-time planning', () => {
  it('tells the main model that a requested night photo is retrospective without changing 13:17 reality', async () => {
    harness = await createHarness({
      clock: () => new Date('2026-08-26T05:17:00.000Z'),
      startWorkers: false,
      chat: { script: [['现在还是中午，不过昨晚倒是有一张这种。']] }
    });

    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: { clientMsgId: 'visual-time-plan-1', content: [{ type: 'text', text: '发张晚上睡觉的照片' }] }
    });

    expect(response.statusCode).toBe(200);
    const request = JSON.stringify(harness.state.chatCalls[0]!.body);
    expect(request).toContain('2026-08-26 13:17:00');
    expect(request).toContain('真实当前时间仍是');
    expect(request).toContain('2026-08-25');
    expect(request).toContain('昨天倒是有一张这种');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails on the missing visual-time instruction**

```powershell
npm run test -w @sooya/server -- test/replier-visual-time.test.ts
```

Expected: FAIL because the request contains the generic clock but not the retrospective hard rule or depicted date.

- [ ] **Step 3: Thread the resolver result through `ContextBuilder` and `TextGenerationResult`**

In `packages/server/src/core/context.ts`, remove the now-unused `formatZonedDateTime` import, import the type/helper, and extend `ContextOptions`:

```ts
import { visualTimeReplyInstruction, type VisualTimeContext } from './visual-time.js';

export interface ContextOptions {
  recentMessages: number;
  memoryLimit: number;
  allowVision: boolean;
  stickerCatalogue?: string;
  voiceMoods: string;
  capabilityNotes: string[];
  contextWindow: number;
  maxOutputTokens: number;
  batchMessageIds?: string[];
  visualTime: VisualTimeContext;
}
```

Replace the local-clock block in `ContextBuilder.build` with the same resolved clock plus a separate hard-rule block:

```ts
    const visualTime = opts.visualTime;
    tryAddSystemPart(
      systemParts,
      turns,
      `用户当地时间：${visualTime.currentLocalDate} ${visualTime.currentLocalTime}（${visualTime.timeZone}）；服务器 UTC 时间：${visualTime.currentInstant}。`,
      inputBudget
    );
    tryAddSystemPart(systemParts, turns, visualTimeReplyInstruction(visualTime), inputBudget);
```

In `packages/server/src/core/replier.ts`, import the resolver, wording guard, and type; then add the required result field:

```ts
import {
  ensureVisualTimeReplyText,
  resolveVisualTime,
  type VisualTimeContext
} from './visual-time.js';

export interface TextGenerationResult {
  text: string;
  rawText: string;
  directives: ModelDirectives;
  degraded: string[];
  contextBudget: Record<string, unknown>;
  firstTokenAt: number | null;
  published: boolean;
  visualTime: VisualTimeContext;
  interrupted?: Error;
  hiddenDraft?: boolean;
  hiddenStickerOnly?: boolean;
  webSearch?: WebSearchResult;
}
```

Immediately after `userDirectives` is built and before `hiddenDraft`, resolve the clock once:

```ts
      const world = this.deps.worldSnapshot?.();
      const visualTime = resolveVisualTime({
        now: world?.now ?? new Date(),
        timeZone: world?.timeZone ?? 'Asia/Shanghai',
        latestUserText: userText
      });
```

Extend the existing buffered-publication condition so an explicit conflicting time never flashes incorrect current-tense copy before validation:

```ts
      const holdDraft = hiddenDraft || hiddenStickerOnly || visualTime.mode === 'retrospective';
```

Replace the final text derivation after `stripModelDirectives(rawText)` with the deterministic guard:

```ts
      const stripped = stripModelDirectives(rawText);
      const modelDirectives = stripped.directives;
      const rawFinalText = stripSpeakerPrefix(stripped.text || visibleText.trim(), [persona.name]);
      const hasImage = Boolean(modelDirectives.selfImagePrompt ?? modelDirectives.imagePrompt);
      const finalText = ensureVisualTimeReplyText(rawFinalText, visualTime, hasImage);
```

Add `visualTime` to the context options and `TextGenerationResult` return object:

```ts
        visualTime,
```

Update `textResult` in `packages/server/test/reply-coordinator.test.ts` with a complete stable fixture:

```ts
    visualTime: {
      timeZone: 'Asia/Shanghai',
      currentInstant: '2026-08-26T05:17:00.000Z',
      currentLocalDate: '2026-08-26',
      currentLocalTime: '13:17:00',
      currentDayPeriod: 'midday',
      mode: 'current',
      depictedLocalDate: '2026-08-26',
      depictedDayPeriod: 'midday',
      requestedDayPeriod: null
    },
```

- [ ] **Step 4: Run focused planning and coordinator tests**

```powershell
npm run test -w @sooya/server -- test/replier-visual-time.test.ts test/reply-coordinator.test.ts
```

Expected: PASS; the fake 13:17 clock appears once as authoritative input and coordinator fixtures typecheck.

- [ ] **Step 5: Commit reply planning**

```powershell
git add -- packages/server/src/core/context.ts packages/server/src/core/replier.ts packages/server/test/replier-visual-time.test.ts packages/server/test/reply-coordinator.test.ts
git commit -m "feat: preserve visual time in reply planning"
```

### Task 3: Media director and final continuity enforce depicted time

**Files:**
- Modify: `packages/server/src/core/mediaDirector.ts:24-52,97-130,137-166`
- Modify: `packages/server/src/core/image-continuity.ts:1-60,176-334`
- Modify: `packages/server/test/media-director-continuity.test.ts`
- Modify: `packages/server/test/image-continuity.test.ts`

- [ ] **Step 1: Add failing unit tests for stale prompts, retrospective isolation, and fallback**

Append to `packages/server/test/image-continuity.test.ts`:

```ts
  it('overrides a stale night prompt with real midday lighting for an unspecified continuation', () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings, '2026-08-26T05:17:00.000Z');
    const decision = service.prepare({
      scene: '晚上在家，借着落地灯暖光看书',
      userText: '再来一张',
      activity: '午睡一会儿',
      activityKind: 'rest',
      location: '家',
      now: '2026-08-26T05:17:00.000Z',
      timeZone: 'Asia/Shanghai'
    });
    const prompt = service.applyToPrompt('晚上在家，借着落地灯暖光看书', decision, service.resolveOutfit(null, decision));

    expect(decision.visualTime).toMatchObject({ mode: 'current', currentDayPeriod: 'midday' });
    expect(prompt).toContain('Real current local time: 2026-08-26 13:17:00');
    expect(prompt).toContain('Depicted day period: midday');
    expect(prompt).toContain('clear natural midday daylight');
    expect(prompt).toContain('Ignore and override any earlier time-of-day or lighting description');
  });

  it('generates a requested night scene as yesterday without mutating current continuity', () => {
    const settings = new MemorySettings();
    const service = serviceAt(settings, '2026-08-26T05:17:00.000Z');
    const decision = service.prepare({
      scene: '晚上在家准备睡觉',
      userText: '发张晚上睡觉的照片',
      activity: '午睡一会儿',
      activityKind: 'rest',
      location: '家',
      now: '2026-08-26T05:17:00.000Z',
      timeZone: 'Asia/Shanghai'
    });
    const outfit = service.resolveOutfit(null, decision);
    const prompt = service.applyToPrompt('晚上在家准备睡觉', decision, outfit);

    expect(decision).toMatchObject({ previousOutfit: null, outfitMode: 'full_change', changeReason: 'retrospective_scene' });
    expect(decision.visualTime).toMatchObject({
      mode: 'retrospective',
      currentDayPeriod: 'midday',
      depictedLocalDate: '2026-08-25',
      depictedDayPeriod: 'evening'
    });
    expect(prompt).toContain('newly generated retrospective depiction');
    expect(prompt).not.toContain('Use the current activity and location above as authoritative');
    expect(service.commit(decision, { outfit, scene: decision.currentScene, mediaId: 'retro_media' })).toBeNull();
    expect(service.current()).toBeNull();
  });
```

Extend both continuity inputs in `packages/server/test/media-director-continuity.test.ts` with this exact value:

```ts
        visualTime: {
          timeZone: 'Asia/Shanghai',
          currentInstant: '2026-08-22T04:00:00.000Z',
          currentLocalDate: '2026-08-22',
          currentLocalTime: '12:00:00',
          currentDayPeriod: 'midday',
          mode: 'current',
          depictedLocalDate: '2026-08-22',
          depictedDayPeriod: 'midday',
          requestedDayPeriod: null
        }
```

Add assertions:

```ts
    expect(input.type === 'text' ? input.text : '').toContain('"currentDayPeriod": "midday"');
```

and in the fallback test:

```ts
    expect(result.prompt).toContain('Real current local time: 2026-08-22 12:00:00');
    expect(result.prompt).toContain('clear natural midday daylight');
```

- [ ] **Step 2: Run focused tests and confirm failures**

```powershell
npm run test -w @sooya/server -- test/image-continuity.test.ts test/media-director-continuity.test.ts
```

Expected: FAIL because `PreparedImageContinuity.visualTime`, time hard constraints, and retrospective no-op commit do not exist.

- [ ] **Step 3: Extend continuity and director contracts with the exact dual-clock value**

In `packages/server/src/core/mediaDirector.ts`:

```ts
import {
  visualDayPeriodLighting,
  type VisualTimeContext
} from './visual-time.js';

export interface ImageDirectorContinuity {
  dateKey?: string;
  currentActivity?: string | null;
  currentLocation?: string | null;
  previousOutfit?: string | null;
  outfitMode: 'new_day' | 'locked' | 'layer_adjustment' | 'full_change';
  changeReason?: string | null;
  explicitOutfitRequest?: string | null;
  visualTime: VisualTimeContext;
}
```

Add these entries to `fallbackImagePrompt` before the photography-style lines:

```ts
    continuity?.visualTime
      ? `Real current local time: ${continuity.visualTime.currentLocalDate} ${continuity.visualTime.currentLocalTime} (${continuity.visualTime.currentDayPeriod}, ${continuity.visualTime.timeZone}).`
      : null,
    continuity?.visualTime
      ? `Depicted scene: ${continuity.visualTime.mode}, ${continuity.visualTime.depictedLocalDate} ${continuity.visualTime.depictedDayPeriod}. Required lighting: ${visualDayPeriodLighting(continuity.visualTime.depictedDayPeriod)}.`
      : null,
```

In `packages/server/src/core/image-continuity.ts`, import the resolver/helpers and extend both input/output contracts:

```ts
import {
  resolveVisualTime,
  visualDayPeriodLighting,
  type VisualTimeContext
} from './visual-time.js';

export interface PrepareImageContinuityInput {
  scene: string;
  userText?: string | null;
  activity?: string | null;
  activityKind?: string | null;
  activityStartedAt?: string | null;
  location?: string | null;
  now?: string | Date;
  localDate?: string | null;
  timeZone?: string | null;
  visualTime?: VisualTimeContext;
}

export interface PreparedImageContinuity {
  dateKey: string;
  visualTime: VisualTimeContext;
  currentActivity: string | null;
  currentActivityKind: string | null;
  currentActivityStartedAt: string | null;
  currentLocation: string | null;
  currentScene: string;
  previousOutfit: string | null;
  previousOutfitRevision: number;
  previousActivity: string | null;
  previousScene: string | null;
  outfitMode: OutfitMode;
  outfitRevision: number;
  changeReason: string | null;
  explicitOutfitRequest: string | null;
}
```

At the start of `prepare`, resolve once and allow stored outfit state only for current scenes:

```ts
    const visualTime = input.visualTime ?? resolveVisualTime({
      now,
      timeZone: input.timeZone ?? this.options.timeZone,
      latestUserText: input.userText
    });
    const dateKey = visualTime.currentLocalDate;
    const stored = this.current();
    const state = visualTime.mode === 'current' && stored?.dateKey === dateKey ? stored : null;
```

Before the existing `if (state)` outfit branch, add the retrospective branch, and include `visualTime` in `decision`:

```ts
    if (visualTime.mode === 'retrospective') {
      outfitMode = 'full_change';
      changeReason = 'retrospective_scene';
      if (userText && (EXPLICIT_CHANGE_RE.test(userText) || LAYER_ADJUST_RE.test(userText))) {
        explicitOutfitRequest = userText;
      }
    } else if (state) {
      outfitMode = 'locked';
      if (userText && KEEP_OUTFIT_RE.test(userText)) {
        changeReason = 'user_keep_request';
      } else if (userText && CHANGE_OBSERVATION_RE.test(userText)) {
        changeReason = 'user_continuity_correction';
      } else if (userText && LAYER_ADJUST_RE.test(userText)) {
        outfitMode = 'layer_adjustment';
        changeReason = 'user_layer_request';
        explicitOutfitRequest = userText;
      } else if (userText && EXPLICIT_CHANGE_RE.test(userText)) {
        outfitMode = 'full_change';
        changeReason = 'user_request';
        explicitOutfitRequest = userText;
      } else if (LAYER_ADJUST_RE.test(layerRules)) {
        outfitMode = 'layer_adjustment';
        changeReason = 'environment_layer_adjustment';
      } else {
        const currentSpecial = specialActivityOf(currentRules);
        const previousSpecial = specialActivityOf(previousRules);
        if (currentSpecial && currentSpecial !== previousSpecial) {
          outfitMode = 'full_change';
          changeReason = currentSpecial;
        } else if (!currentSpecial && previousSpecial) {
          outfitMode = 'full_change';
          changeReason = `${previousSpecial}_ended`;
        }
      }
    } else if (userText && (EXPLICIT_CHANGE_RE.test(userText) || LAYER_ADJUST_RE.test(userText))) {
      explicitOutfitRequest = userText;
    }

    const decision: PreparedImageContinuity = {
      dateKey,
      visualTime,
      currentActivity,
      currentActivityKind,
      currentActivityStartedAt,
      currentLocation,
      currentScene: scene,
      previousOutfit: state?.outfit.fullDescription ?? null,
      previousOutfitRevision,
      previousActivity: state?.activity ?? null,
      previousScene: state?.scene ?? null,
      outfitMode,
      outfitRevision,
      changeReason,
      explicitOutfitRequest
    };
```

Make `defaultOutfit` use the requested scene rather than current Life activity for a retrospective depiction:

```ts
  const authoritativeContext = decision.visualTime.mode === 'retrospective'
    ? normalizeForRules(decision.currentScene, decision.explicitOutfitRequest)
    : decision.currentActivity || decision.currentActivityKind
      ? normalizeForRules(decision.currentActivity, decision.currentActivityKind)
      : normalizeForRules(decision.currentScene);
```

Replace `applyToPrompt` with a current/retrospective-aware final layer:

```ts
  applyToPrompt(prompt: string, decision: PreparedImageContinuity, outfit: string): string {
    const resolvedOutfit = cleanOutfit(outfit) ?? this.resolveOutfit(null, decision);
    const activity = decision.currentActivity ?? 'unknown ordinary daily activity; do not invent a conflicting activity';
    const location = decision.currentLocation ?? 'the real current location implied by the activity; do not invent a conflicting place';
    const outfitRule = decision.outfitMode === 'locked'
      ? 'This is the exact same-day outfit. Keep every garment type, color, material, and layer unchanged.'
      : decision.outfitMode === 'layer_adjustment'
        ? 'Only an outer layer may be added or removed. Keep the inner top, bottom, shoes, colors, and materials consistent with the prior outfit.'
        : decision.outfitMode === 'full_change'
          ? `A full outfit change is allowed only for this reason: ${decision.changeReason ?? 'explicitly approved transition'}.`
          : 'This is the first on-camera outfit for this local calendar day and becomes the same-day baseline.';
    const explicitRule = decision.explicitOutfitRequest
      ? `User's explicit outfit request (authoritative): ${decision.explicitOutfitRequest}`
      : null;
    const sceneRules = decision.visualTime.mode === 'current'
      ? [
          `Real current activity: ${activity}.`,
          `Real current location: ${location}.`,
          'Use the current activity and location above as authoritative. A new angle, composition, or ordinary location change must not create a different activity or outfit.'
        ]
      : [
          'This is a newly generated retrospective depiction, not current reality and not proof of a stored historical photo.',
          'Follow the latest explicit past-scene request and intended scene. Do not reuse current Life activity or location as historical facts.'
        ];
    const time = decision.visualTime;
    return [
      prompt.trim(),
      '',
      'DAILY VISUAL CONTINUITY — HARD CONSTRAINTS:',
      `Local calendar date: ${decision.dateKey}.`,
      ...sceneRules,
      `SOOYA's complete outfit: ${resolvedOutfit}.`,
      outfitRule,
      explicitRule,
      'Ignore and override any earlier clothing description that conflicts with the complete outfit above.',
      '',
      'VISUAL TIME CONTINUITY — FINAL HARD CONSTRAINTS:',
      `Real current local time: ${time.currentLocalDate} ${time.currentLocalTime} (${time.currentDayPeriod}, ${time.timeZone}).`,
      `Time mode: ${time.mode}.`,
      `Depicted local date: ${time.depictedLocalDate}.`,
      `Depicted day period: ${time.depictedDayPeriod}.`,
      `Required scene lighting: ${visualDayPeriodLighting(time.depictedDayPeriod)}.`,
      'Ignore and override any earlier time-of-day or lighting description that conflicts with this final block.'
    ].filter((line): line is string => Boolean(line)).join('\n');
  }
```

Make retrospective commits an explicit no-op and return nullable state:

```ts
  commit(decision: PreparedImageContinuity, input: CommitImageContinuityInput): DailyImageContinuityState | null {
    if (decision.visualTime.mode === 'retrospective') {
      this.options.onEvent?.('commit_skipped', {
        reason: 'retrospective_scene',
        sourceMediaId: cleanOptional(input.mediaId, 160),
        depictedLocalDate: decision.visualTime.depictedLocalDate,
        depictedDayPeriod: decision.visualTime.depictedDayPeriod
      });
      return this.current();
    }
    const outfit = cleanOutfit(input.outfit);
    const scene = cleanOptional(input.scene, 1000);
    const mediaId = cleanOptional(input.mediaId, 160);
    if (!outfit || !scene || !mediaId) throw new Error('invalid image continuity commit');
    const current = this.current();
    const sameDayCurrent = current?.dateKey === decision.dateKey ? current : null;
    const outfitRevision = decision.outfitMode === 'locked' && sameDayCurrent
      ? sameDayCurrent.outfitRevision
      : decision.outfitMode === 'new_day' || !sameDayCurrent
        ? 1
        : sameDayCurrent.outfitRevision + 1;
    const state: DailyImageContinuityState = {
      version: 1,
      dateKey: decision.dateKey,
      outfit: { fullDescription: decision.outfitMode === 'locked' && sameDayCurrent ? sameDayCurrent.outfit.fullDescription : outfit },
      outfitRevision,
      activity: decision.currentActivity,
      activityKind: decision.currentActivityKind,
      activityStartedAt: decision.currentActivityStartedAt,
      location: decision.currentLocation,
      scene,
      changeReason: decision.changeReason,
      sourceMediaId: mediaId,
      updatedAt: (this.options.clock?.() ?? new Date()).toISOString()
    };
    this.settings.set(DAILY_IMAGE_CONTINUITY_KEY, state);
    this.options.onEvent?.('committed', {
      dateKey: state.dateKey,
      outfitMode: decision.outfitMode,
      outfitRevision: state.outfitRevision,
      changeReason: state.changeReason,
      sourceMediaId: mediaId
    });
    return state;
  }
```

- [ ] **Step 4: Run unit tests and confirm green**

```powershell
npm run test -w @sooya/server -- test/visual-time.test.ts test/image-continuity.test.ts test/media-director-continuity.test.ts
```

Expected: PASS. Update the old final-line assertion in `image-continuity.test.ts` to expect the new final time override line.

```ts
    expect(prompt.endsWith('Ignore and override any earlier time-of-day or lighting description that conflicts with this final block.')).toBe(true);
```

- [ ] **Step 5: Commit final prompt enforcement**

```powershell
git add -- packages/server/src/core/mediaDirector.ts packages/server/src/core/image-continuity.ts packages/server/test/media-director-continuity.test.ts packages/server/test/image-continuity.test.ts
git commit -m "feat: enforce visual time in image prompts"
```

### Task 4: Ordinary reply images persist time evidence and never pollute current state

**Files:**
- Modify: `packages/server/src/core/replier.ts:680-815`
- Modify: `packages/server/test/daily-visual-continuity-integration.test.ts`

- [ ] **Step 1: Write failing end-to-end regression tests for the reported ordinary-chat case**

Append to `packages/server/test/daily-visual-continuity-integration.test.ts`:

```ts
  it('forces an unspecified 13:17 continuation back to current midday despite a stale night director prompt', async () => {
    harness = await createHarness({
      image: 'anuma',
      startWorkers: false,
      clock: () => localTime('2026-08-26T13:17'),
      env: { ENABLE_BACKGROUND_JOBS: 'false', LIFE_TIME_ZONE: 'Asia/Shanghai' },
      chat: {
        script: [
          ['再给你一张[[image-self:晚上在家，借着落地灯暖光看书]]'],
          [directorReply('At night at home, reading under a warm floor lamp.', baselineOutfit)]
        ]
      }
    });

    const body = await sendSelfie(harness, 'visual-time-current-1', '再来一张');
    const image = body.reply.content.find((part: any) => part.type === 'image');
    const providerPrompt = JSON.stringify(harness.state.imageRequests[0]!.body);

    expect(providerPrompt).toContain('Real current local time: 2026-08-26 13:17:00');
    expect(providerPrompt).toContain('Depicted day period: midday');
    expect(providerPrompt).toContain('clear natural midday daylight');
    expect(image.meta.continuity).toMatchObject({
      timeMode: 'current',
      currentDayPeriod: 'midday',
      depictedLocalDate: '2026-08-26',
      depictedDayPeriod: 'midday',
      requestedDayPeriod: null
    });
  });

  it('allows a new night image at 13:17 only as yesterday and leaves current continuity untouched', async () => {
    harness = await createHarness({
      image: 'anuma',
      startWorkers: false,
      clock: () => localTime('2026-08-26T13:17'),
      env: { ENABLE_BACKGROUND_JOBS: 'false', LIFE_TIME_ZONE: 'Asia/Shanghai' },
      chat: {
        script: [
          ['好呀，现在拍给你。[[image-self:晚上在家穿着家居服准备睡觉]]'],
          [directorReply('At night at home, getting ready to sleep.', '宽松浅色家居上衣、深色柔软家居长裤和室内拖鞋')]
        ]
      }
    });

    harness.app.repos.life.advance({
      activity: '午睡一会儿',
      kind: 'rest',
      mood: '平静',
      startedAt: localTime('2026-08-26T13:00').toISOString(),
      endsAt: localTime('2026-08-26T14:00').toISOString()
    });
    const lifeEventCount = harness.app.repos.life.events().length;

    const body = await sendSelfie(harness, 'visual-time-retro-1', '发张晚上睡觉的照片');
    const image = body.reply.content.find((part: any) => part.type === 'image');
    const media = harness.app.repos.media.get(image.mediaId)!;

    expect(body.reply.content.find((part: any) => part.type === 'text')?.text).toBe('现在还是中午，不过昨天倒是有一张这种。');
    expect(JSON.stringify(harness.state.imageRequests[0]!.body)).toContain('newly generated retrospective depiction');
    expect(image.meta.continuity).toMatchObject({
      timeMode: 'retrospective',
      currentDayPeriod: 'midday',
      depictedLocalDate: '2026-08-25',
      depictedDayPeriod: 'evening',
      requestedDayPeriod: 'evening'
    });
    expect(JSON.parse(media.meta_json).continuity).toMatchObject(image.meta.continuity);
    expect(harness.app.services.imageContinuity.current()).toBeNull();
    expect(harness.app.repos.life.events()).toHaveLength(lifeEventCount);
  });
```

- [ ] **Step 2: Run the integration test and confirm metadata/commit failures**

```powershell
npm run test -w @sooya/server -- test/daily-visual-continuity-integration.test.ts
```

Expected: FAIL because `Replier` has not passed `generated.visualTime` or persisted its bounded fields.

- [ ] **Step 3: Pass one context through director, final prompt, message metadata, and media metadata**

Import the metadata helper in `packages/server/src/core/replier.ts`:

```ts
import { resolveVisualTime, visualTimeMetadata, type VisualTimeContext } from './visual-time.js';
```

Pass the planning result unchanged in `continuityService.prepare(...)`:

```ts
            continuity = continuityService.prepare({
              scene: imagePrompt,
              userText,
              activity: life?.activity ?? null,
              activityKind: life?.kind ?? null,
              activityStartedAt: life?.startedAt ?? null,
              location: world?.location?.name ?? world?.city?.name ?? null,
              now: world?.now,
              localDate: world?.localDate,
              timeZone: world?.timeZone,
              visualTime: generated.visualTime
            });
```

Pass the exact same object to `MediaDirector.image`; current Life fields are omitted from the depicted scene when retrospective:

```ts
                    continuity: {
                      dateKey: continuity.dateKey,
                      currentActivity: continuity.visualTime.mode === 'current' ? continuity.currentActivity : null,
                      currentLocation: continuity.visualTime.mode === 'current' ? continuity.currentLocation : null,
                      previousOutfit: continuity.previousOutfit,
                      outfitMode: continuity.outfitMode,
                      changeReason: continuity.changeReason,
                      explicitOutfitRequest: continuity.explicitOutfitRequest,
                      visualTime: continuity.visualTime
                    }
```

Extend the existing `continuityMeta` object with the bounded projection:

```ts
            continuityMeta = {
              dateKey: continuity.dateKey,
              outfit: resolvedOutfit,
              outfitMode: continuity.outfitMode,
              outfitRevision: continuity.outfitRevision,
              changeReason: continuity.changeReason,
              activity: continuity.currentActivity,
              activityKind: continuity.currentActivityKind,
              location: continuity.currentLocation,
              ...visualTimeMetadata(continuity.visualTime)
            };
```

Handle the nullable no-op commit without changing retrospective metadata:

```ts
            const committed = continuityService.commit(continuity, {
              outfit: resolvedOutfit,
              scene: imagePrompt,
              mediaId: media.id
            });
            if (committed) {
              continuityMeta = {
                ...continuityMeta,
                outfit: committed.outfit.fullDescription,
                outfitRevision: committed.outfitRevision
              };
            }
```

- [ ] **Step 4: Run ordinary-image unit and integration suites**

```powershell
npm run test -w @sooya/server -- test/replier-visual-time.test.ts test/image-continuity.test.ts test/media-director-continuity.test.ts test/replier-image-reference.test.ts test/daily-visual-continuity-integration.test.ts
```

Expected: PASS. The reported 13:17 continuation is forced to midday, while the explicit night request generates a retrospective image and leaves `imageContinuity.current()` null.

- [ ] **Step 5: Commit ordinary reply integration**

```powershell
git add -- packages/server/src/core/replier.ts packages/server/test/daily-visual-continuity-integration.test.ts
git commit -m "fix: preserve real time in reply images"
```

### Task 5: Proactive images use event time without claiming it is happening now

**Files:**
- Modify: `packages/server/src/core/proactive.ts:1-30,278-315,557-687,770-818`
- Modify: `packages/server/test/proactive-composer.test.ts:25-55,118-145`

- [ ] **Step 1: Write a failing proactive event/publication clock test**

Change the fixed clock in `withMoments` so a test may override it:

```ts
    clock: options.clock ?? (() => localTime('2026-07-31T17:30'))
```

Append this test to `packages/server/test/proactive-composer.test.ts`:

```ts
  it('publishes an afternoon event at 18:30 as retrospective and stores both clocks', async () => {
    harness = await withMoments({
      image: 'anuma',
      clock: () => localTime('2026-07-31T18:30')
    });
    stageCandidate(harness);

    const result = await harness.app.services.proactive.run({ mode: 'image' });
    expect(result.status).toBe('sent');
    const moment = harness.app.repos.moments.get(result.momentId!)!;
    const media = harness.app.repos.media.get(moment.image_media_id!)!;
    const continuity = JSON.parse(media.meta_json).continuity;
    const allChatRequests = JSON.stringify(harness.state.chatCalls.map((request) => request.body));
    const providerPrompt = JSON.stringify(harness.state.imageRequests[0]!.body);

    expect(allChatRequests).toContain('当前发布时段是 evening');
    expect(allChatRequests).toContain('事件画面时段是 afternoon');
    expect(providerPrompt).toContain('Time mode: retrospective');
    expect(providerPrompt).toContain('Depicted day period: afternoon');
    expect(continuity).toMatchObject({
      timeMode: 'retrospective',
      currentDayPeriod: 'evening',
      depictedLocalDate: '2026-07-31',
      depictedDayPeriod: 'afternoon',
      requestedDayPeriod: null
    });
    expect(harness.app.repos.proactive.list(1)[0]!.detail.continuity).toMatchObject(continuity);
    expect(harness.app.services.imageContinuity.current()).toBeNull();
  });
```

- [ ] **Step 2: Run the proactive test and confirm it fails**

```powershell
npm run test -w @sooya/server -- test/proactive-composer.test.ts
```

Expected: FAIL because proactive composition and media generation do not yet share an event-derived `VisualTimeContext`.

- [ ] **Step 3: Resolve proactive visual time once and use it everywhere**

Import the visual-time API in `packages/server/src/core/proactive.ts`:

```ts
import {
  resolveVisualTime,
  visualTimeMetadata,
  type VisualTimeContext
} from './visual-time.js';
```

Immediately after `eventContext` is resolved in `run`, calculate one value and pass it to both composition and media preparation:

```ts
        const eventContext = this.resolveEventContext(candidate);
        const world = this.deps.worldSnapshot();
        const visualTime = resolveVisualTime({
          now: world.now,
          timeZone: world.timeZone,
          eventAt: eventContext.startedAt
        });

        sharePlan = await composeMomentSharePlan(
          provider,
          persona.systemPrompt,
          lifeLines,
          eventContext,
          visualTime,
          requestedMode ?? 'text',
          signal,
          this.deps.toolRuntime
        );

        prepared = await this.prepareMedia(requestedMode ?? 'text', sharePlan, eventContext, visualTime, candidate, signal);
```

Extend `prepareMedia` with the resolved value between event context and candidate:

```ts
  private async prepareMedia(
    mode: ProactiveMode,
    sharePlan: MomentSharePlan,
    eventContext: ProactiveEventContext,
    visualTime: VisualTimeContext,
    candidate: LifeLogRow,
    signal: AbortSignal
  ): Promise<PreparedMedia> {
```

Extend `composeMomentSharePlan` with the resolved value between event context and requested mode:

```ts
async function composeMomentSharePlan(
  provider: ReturnType<CapabilityRegistry['chatProvider']>,
  personaPrompt: string,
  lifeLines: string[],
  eventContext: ProactiveEventContext,
  visualTime: VisualTimeContext,
  requestedMode: ProactiveMode,
  signal: AbortSignal,
  toolRuntime?: ToolCallRuntime
): Promise<MomentSharePlan> {
```

In `composeMomentSharePlan`, insert this exact system line after the serialized historical event:

```ts
        visualTime.mode === 'retrospective'
          ? `【发布时间与事件时间】真实当前时间是 ${visualTime.currentLocalDate} ${visualTime.currentLocalTime}，当前发布时段是 ${visualTime.currentDayPeriod}；事件画面时间是 ${visualTime.depictedLocalDate}，事件画面时段是 ${visualTime.depictedDayPeriod}。正文和图片都必须表现为已经发生的事件，不得写成正在当前发生。`
          : `【发布时间与事件时间】真实当前时间是 ${visualTime.currentLocalDate} ${visualTime.currentLocalTime}，当前发布时段是 ${visualTime.currentDayPeriod}；事件画面与当前时段一致。`,
```

Inside `prepareMedia`, pass `visualTime` to `continuityService.prepare(...)`:

```ts
        continuity = continuityService.prepare({
          scene: groundedScene,
          activity: eventContext.activity,
          activityKind: eventContext.kind,
          activityStartedAt: eventContext.startedAt,
          location: eventContext.location?.name ?? null,
          now: world.now,
          localDate: world.localDate,
          timeZone: world.timeZone,
          visualTime
        });
```

Pass the same value to `MediaDirector.image(...)` and keep current Life facts out of retrospective depicted scenes:

```ts
              continuity: {
                dateKey: continuity.dateKey,
                currentActivity: continuity.visualTime.mode === 'current' ? continuity.currentActivity : null,
                currentLocation: continuity.visualTime.mode === 'current' ? continuity.currentLocation : null,
                previousOutfit: continuity.previousOutfit,
                outfitMode: continuity.outfitMode,
                changeReason: continuity.changeReason,
                explicitOutfitRequest: continuity.explicitOutfitRequest,
                visualTime: continuity.visualTime
              }
```

Extend `continuityMeta` exactly as follows:

```ts
        continuityMeta = {
          dateKey: continuity.dateKey,
          outfit: resolvedOutfit,
          outfitMode: continuity.outfitMode,
          outfitRevision: continuity.outfitRevision,
          changeReason: continuity.changeReason,
          activity: continuity.currentActivity,
          activityKind: continuity.currentActivityKind,
          location: continuity.currentLocation,
          ...visualTimeMetadata(continuity.visualTime)
        };
```

Use this nullable commit guard:

```ts
        const committed = continuityService.commit(continuity, {
          outfit: resolvedOutfit,
          scene: groundedScene,
          mediaId: media.id
        });
        if (committed) {
          continuityMeta = {
            ...continuityMeta,
            outfit: committed.outfit.fullDescription,
            outfitRevision: committed.outfitRevision
          };
        }
```

Because the media is saved before the final attempt detail is written, retain the same `continuityMeta` in both media metadata and `PreparedMedia.detail`; do not add raw prompts or Life payloads beyond the already bounded fields.

- [ ] **Step 4: Run proactive and shared-continuity integration tests**

```powershell
npm run test -w @sooya/server -- test/proactive-composer.test.ts test/daily-visual-continuity-integration.test.ts test/qq-proactive.test.ts
```

Expected: PASS. Same-period events retain current continuity; earlier-period events are retrospective and do not overwrite the current baseline.

- [ ] **Step 5: Commit proactive integration**

```powershell
git add -- packages/server/src/core/proactive.ts packages/server/test/proactive-composer.test.ts
git commit -m "fix: ground proactive images in event time"
```

### Task 6: Full verification and scope audit

**Files:**
- Verify: all files changed in Tasks 1–5

- [ ] **Step 1: Run all focused regression suites together**

```powershell
npm run test -w @sooya/server -- test/visual-time.test.ts test/replier-visual-time.test.ts test/image-continuity.test.ts test/media-director-continuity.test.ts test/replier-image-reference.test.ts test/daily-visual-continuity-integration.test.ts test/proactive-composer.test.ts test/qq-proactive.test.ts
```

Expected: all focused test files PASS with no unhandled rejection.

- [ ] **Step 2: Run the complete server test suite**

```powershell
npm run test -w @sooya/server
```

Expected: all server tests PASS.

- [ ] **Step 3: Run repository typecheck and build**

```powershell
npm run typecheck
npm run build
```

Expected: both commands exit 0; server and web TypeScript/build outputs succeed.

- [ ] **Step 4: Audit the diff and protected scope**

```powershell
git diff --check
git status --short
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- packages/server/src/core/visual-time.ts packages/server/src/core/context.ts packages/server/src/core/replier.ts packages/server/src/core/mediaDirector.ts packages/server/src/core/image-continuity.ts packages/server/src/core/proactive.ts packages/server/test/visual-time.test.ts packages/server/test/replier-visual-time.test.ts packages/server/test/image-continuity.test.ts packages/server/test/media-director-continuity.test.ts packages/server/test/daily-visual-continuity-integration.test.ts packages/server/test/proactive-composer.test.ts packages/server/test/reply-coordinator.test.ts
```

Expected: no whitespace error; unrelated user-owned untracked files remain unmodified; the diff contains only the design/plan and scoped server/test changes.

- [ ] **Step 5: Record final verification commit only if verification required a correction**

If Step 1–4 required a scoped correction, stage only the corrected files and commit:

```powershell
git add -- packages/server/src/core/visual-time.ts packages/server/src/core/context.ts packages/server/src/core/replier.ts packages/server/src/core/mediaDirector.ts packages/server/src/core/image-continuity.ts packages/server/src/core/proactive.ts packages/server/test/visual-time.test.ts packages/server/test/replier-visual-time.test.ts packages/server/test/image-continuity.test.ts packages/server/test/media-director-continuity.test.ts packages/server/test/daily-visual-continuity-integration.test.ts packages/server/test/proactive-composer.test.ts packages/server/test/reply-coordinator.test.ts
git commit -m "test: verify visual time continuity"
```

If no correction was needed, do not create an empty commit. Report the exact passing commands and current commit IDs before asking whether to push/deploy.
