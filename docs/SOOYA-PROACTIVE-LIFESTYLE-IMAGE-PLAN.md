# SOOYA 主动消息人物生活配图改造方案

> 状态：实施方案，不包含本次代码修改、部署或服务重启  
> 日期：2026-08-22  
> 仓库：`sooya7/sooya`  
> 基线：`main@be3aceb96b003180f5e89c68c24818d63f8f74fc`  
> 基线说明：该提交已合并 PR #127 `feat: preserve daily visual continuity`  
> 建议开发分支：`feat/proactive-lifestyle-images`

## 0. 需求确认

### 0.1 最终需求

主动消息中的配图不再生成第一视角 `POV` 照片。

图片应优先表现 **SOOYA 本人在当前真实生活场景中做事**，例如：

- 坐在餐厅吃饭、夹菜、喝汤；
- 在咖啡店喝咖啡、看窗外、翻书；
- 在图书馆看书、写东西；
- 在路上走、等车、逛店；
- 在家做饭、洗水果、整理桌面、窝在沙发上；
- 在公园散步、看猫、蹲下来摸猫；
- 其他与当前 `Life` 活动一致的自然生活动作。

同时保留自然自拍，但不要求每张图片都自拍。

最终主动图片只应产生两种新图片语义：

1. `lifestyle`：SOOYA 在场景中自然进行当前生活活动，作为默认优先类型；
2. `selfie`：SOOYA 在同一真实事件中的自然自拍，在场景适合自拍时使用。

### 0.2 明确不再允许的主动图片

新生成链路中禁止：

- 第一视角 `POV`；
- 纯风景照；
- 纯食物特写；
- 纯桌面或物件照；
- 摄影者完全消失、只剩环境的“图库素材”式配图；
- 旅游宣传片、商业写真、棚拍、时尚大片式构图；
- 与当前 `Life` 活动或地点冲突的画面。

历史已经保存的 `pov` Moment 不删除，不改写，只停止继续生成。

### 0.3 信息完整性

需求已经完整，无需额外产品决策。

本方案按当前 `main` 的真实实现编写，并考虑：

- 当前 `MomentSharePlanSchema` 仍使用 `pov | selfie`；
- 当前 `ProactiveComposer.prepareMedia()` 只有自拍接入人物参考和 `ImageContinuityService`；
- 当前 POV 有专门的“人物完全不入镜”硬约束；
- 当前数据库 `moments.image_kind` 有 `CHECK (image_kind IN ('pov','selfie'))`；
- 当前每日视觉连续性已完成，可以直接复用，不另造状态系统。

---

# 1. 当前实现与问题定位

## 1.1 当前主动图片规划

文件：

`packages/server/src/core/proactive.ts`

当前 Schema：

```ts
const MomentSharePlanSchema = z.object({
  text: z.string().trim().min(1).max(120),
  image: z.object({
    kind: z.enum(['pov', 'selfie']),
    scene: z.string().trim().min(4).max(300),
    action: z.string().trim().max(160).optional(),
    mood: z.string().trim().max(80).optional(),
    framing: z.enum(['front', 'side', 'full-body', 'environment']).optional()
  }).nullable()
});
```

因此主模型目前只能在 `pov` 与 `selfie` 之间选择，没有“人物在环境中自然生活”的独立类型。

## 1.2 当前 POV 会主动把 SOOYA 从画面里删除

`buildGroundedScene()` 当前对非自拍的定义是：

```text
SOOYA 手机第一视角拍摄眼前所见，SOOYA 本人不入镜
```

`applyMomentPhotoConstraints()` 又进一步默认禁止：

- hands
- arms
- legs
- feet
- torso
- clothing
- reflection
- mirror image
- body shadow

所以现在出现纯食物、纯风景、纯环境并不是偶发模型偏差，而是当前规则的直接结果。

## 1.3 当前只有 selfie 被当成人物照片

`prepareMedia()` 目前使用：

```ts
const continuityService = imagePlan.kind === 'selfie'
  ? this.deps.imageContinuity
  : undefined;
```

人物参考图同样只对自拍加载：

```ts
const referenceImages = imagePlan.kind === 'selfie'
  ? await this.deps.personaReferences.load(finalImagePrompt)
  : [];
```

因此新增 `lifestyle` 后必须同时进入这两条分支，否则会出现：

- 人在场景里但长相漂移；
- 人在场景里但当天衣服不连续；
- 自拍与生活照各自维护不同视觉状态。

## 1.4 当前数据库也限制了图片类型

`packages/server/src/db/repos/moment.repo.ts`：

```ts
export type MomentImageKind = 'pov' | 'selfie';
```

`packages/server/src/db/migrations.ts` 的 migration 34：

```sql
image_kind TEXT CHECK (image_kind IN ('pov','selfie'))
```

因此真正增加 `lifestyle` 不能只改 TypeScript 类型，还需要数据库迁移。

---

# 2. 最终产品模型

## 2.1 新主动图片类型

### `lifestyle`

定义：

> SOOYA 本人清晰存在于画面中，并正在自然进行当前真实 `Life` 活动。场景、食物、物件用于说明她正在经历什么，而不是替代她本人。

核心特征：

- 人物必须入镜；
- 当前活动是画面主事件；
- 场景与地点作为环境背景；
- 食物可以很明显，但 SOOYA 应该正在吃、拿、喝或与之互动；
- 构图偏自然生活抓拍；
- 不要求看镜头；
- 不要求摆姿势；
- 可正面、侧面、背侧、半身、全身或环境人像；
- 必须加载人物参考图；
- 必须进入每日视觉连续性。

### `selfie`

定义保持：

> SOOYA 在当前真实事件中自己拍的自然自拍。

允许：

- 正脸；
- 半身；
- 侧脸；
- 镜前；
- 坐着吃东西时顺手自拍；
- 带大量环境信息的自拍。

同样必须：

- 加载人物参考；
- 进入每日视觉连续性；
- 服从当前活动、地点和当天穿搭。

## 2.2 默认选择逻辑

不建议硬编码随机 `70/30`。

让 Share Planner 按事件选择，但给予明确优先级：

1. 默认优先 `lifestyle`；
2. 当事件天然适合直接面对用户分享自己状态时选 `selfie`；
3. 不允许为了展示风景或食物改成第一视角；
4. 如果内容重点是食物，优先生成“SOOYA 正在吃这份东西”的 `lifestyle`；
5. 如果内容重点是地点，优先生成“SOOYA 在这个地点进行当前活动”的 `lifestyle`。

例子：

| Life 事件 | 推荐类型 | 画面 |
| --- | --- | --- |
| 吃拉面 | lifestyle | SOOYA 坐在店里低头吃面，筷子和拉面都在画面中 |
| 咖啡店休息 | lifestyle | SOOYA 坐窗边喝咖啡，杯子和环境同时存在 |
| 今天妆很好看 | selfie | 自然半身自拍 |
| 图书馆看书 | lifestyle | SOOYA 坐在桌边翻书或阅读 |
| 公园看猫 | lifestyle | SOOYA 蹲下看猫或摸猫 |
| 刚到某地想给用户看自己 | selfie | 带地点背景的自然自拍 |

---

# 3. 核心架构决策

## 3.1 Planner 接受旧 POV，但内部立即归一化

为了避免模型偶尔因为旧提示习惯返回 `pov` 后整次主动消息失败，建议分成两个 Schema。

### 原始模型输出 Schema

允许读取旧值，但只作为兼容输入：

```ts
const RawMomentSharePlanSchema = z.object({
  text: z.string().trim().min(1).max(120),
  image: z.object({
    kind: z.enum(['pov', 'selfie', 'lifestyle']),
    scene: z.string().trim().min(4).max(300),
    action: z.string().trim().max(160).optional(),
    mood: z.string().trim().max(80).optional(),
    framing: z.enum(['front', 'side', 'full-body', 'environment']).optional()
  }).nullable()
});
```

### 内部正式类型

```ts
type ActiveMomentImageKind = 'selfie' | 'lifestyle';
```

模型返回 `pov` 时，在 `composeMomentSharePlan()` 返回前立即归一化成 `lifestyle`：

```ts
function normalizeActiveImagePlan(
  raw: RawMomentSharePlan,
  context: ProactiveEventContext
): MomentSharePlan {
  if (!raw.image || raw.image.kind !== 'pov') return raw as MomentSharePlan;

  return {
    ...raw,
    image: {
      ...raw.image,
      kind: 'lifestyle',
      action: raw.image.action?.trim() || context.activity,
      scene: `${raw.image.scene}；SOOYA 本人在同一场景中自然进行“${context.activity}”`
    }
  };
}
```

目的：

- 新系统绝不把 `pov` 送入生图链路；
- 旧模型输出不会导致一次主动消息直接报错；
- 即使旧计划写的是“桌上的拉面”，也会被转换为“SOOYA 在店里吃这碗拉面”的人物生活图。

## 3.2 统一判断“人物是否入镜”

不要继续散落多个 `kind === 'selfie'`。

新增：

```ts
function isSooyaOnCamera(kind: ActiveMomentImageKind): boolean {
  return kind === 'selfie' || kind === 'lifestyle';
}
```

当前两个类型都返回 `true`。

后续如果增加别的出镜类型，只改这个入口。

所有以下逻辑统一使用该判断：

- `ImageContinuityService`；
- `PersonaReferenceLoader`；
- `referenceMissing`；
- outfit resolve / commit；
- 媒体元数据。

---

# 4. 文件级实施方案

## 4.1 `packages/server/src/core/proactive.ts`

这是本次主要修改文件。

### A. 修改 Share Plan Schema

模型正式提示只暴露：

```text
selfie|lifestyle
```

不要再告诉模型有 `pov`。

原始解析可以兼容 `pov`，但返回 `prepareMedia()` 前必须完成归一化。

### B. 重写 `composeMomentSharePlan()` 图片规则

删除当前规则：

```text
pov 是 SOOYA 手机第一视角...
selfie 才出现 SOOYA
```

替换为类似：

```text
如果有图片，只能选择 lifestyle 或 selfie。

lifestyle：SOOYA 本人在画面中，自然进行这件真实生活事件对应的动作。
默认优先 lifestyle。不要把食物、风景、桌面或物件单独拍成主体；如果事件涉及吃东西，就拍 SOOYA 正在吃；如果事件涉及某个地点，就拍 SOOYA 在该地点进行当前活动。

selfie：只有当这件事自然适合自拍分享时才选择。允许自然半身、侧脸、镜前或带环境的自拍。

禁止第一视角 POV、纯风景、纯食物、纯物件和摄影者完全不出现的场景图。
```

JSON 输出改为：

```text
{"text":"...","image":null 或 {"kind":"selfie|lifestyle", ...}}
```

### C. 修改 `buildGroundedScene()`

当前：

```ts
image.kind === 'selfie'
  ? 'SOOYA 在同一真实事件中的自然生活自拍'
  : 'SOOYA 手机第一视角拍摄眼前所见，SOOYA 本人不入镜'
```

改为显式双分支：

```ts
const photoType = image.kind === 'selfie'
  ? 'SOOYA 在同一真实事件中的自然生活自拍，SOOYA 本人入镜'
  : 'SOOYA 本人在同一真实生活场景中自然进行当前活动的生活照片，SOOYA 本人必须入镜，场景和物件作为生活环境';
```

并追加：

```text
禁止第一视角 POV；禁止只拍风景、食物、桌面或物件而没有 SOOYA。
```

### D. 删除旧 POV 专用约束

当前：

```ts
applyMomentPhotoConstraints()
```

包含：

- `POV identity constraint`
- `Keep the photographer completely out of frame`
- 禁止手、腿、衣服、倒影、影子等

这套逻辑全部退出主动图片新链路。

建议把函数重命名为：

```ts
applyMomentCompositionConstraints()
```

### E. 新 `lifestyle` 硬约束

```ts
function applyMomentCompositionConstraints(
  prompt: string,
  image: NonNullable<MomentSharePlan['image']>
): string {
  if (image.kind === 'selfie') {
    return [
      prompt,
      'SOOYA must be visibly present as the same person from the provided identity reference.',
      'Keep the image casual and naturally self-shot, not studio portraiture.'
    ].join('\n');
  }

  return [
    prompt,
    'LIFESTYLE COMPOSITION — HARD CONSTRAINTS:',
    'SOOYA herself must be visibly present in the frame.',
    'Show SOOYA naturally performing the real current activity described above.',
    'The environment, food, scenery, or objects are supporting context, not a replacement for SOOYA.',
    'Do not use first-person POV.',
    'Do not produce a scenery-only, food-only, tabletop-only, or object-only image.',
    'Use candid daily-life body language; do not turn the moment into a fashion pose, studio portrait, tourism poster, or commercial shoot.'
  ].join('\n');
}
```

### F. `prepareMedia()` 让两类图片共用人物链路

新增：

```ts
const onCamera = isSooyaOnCamera(imagePlan.kind);
const continuityService = onCamera ? this.deps.imageContinuity : undefined;
```

人物参考：

```ts
const referenceImages = onCamera
  ? await this.deps.personaReferences.load(finalImagePrompt)
  : [];
```

`referenceMissing`：

```ts
...(onCamera && !referenceUsed ? { referenceMissing: true } : {})
```

这样 `lifestyle` 和 `selfie` 都：

- 加载同一人物参考；
- 读取当天 outfit；
- 读取当前 activity/location；
- 生成成功后 commit；
- 失败时不污染连续状态。

### G. Media Director intent

当前非自拍使用：

```text
casual first-person smartphone photo...
```

改为：

```ts
intent: imagePlan.kind === 'selfie'
  ? 'casual Moments-feed selfie from the same real lived event'
  : 'candid daily-life photo of SOOYA visibly present and naturally performing the same real lived event'
```

### H. 元数据版本升级

建议：

```ts
sharePlanVersion: 4
```

原因：v4 的图片类型语义已经和 v3 不同。

主动 attempt 和 Media meta 都继续保存：

```ts
photoKind: imagePlan.kind
```

这样可以在 Admin 中统计新图是否真正来自 `lifestyle`。

---

## 4.2 `packages/server/src/db/repos/moment.repo.ts`

修改：

```ts
export type MomentImageKind = 'pov' | 'selfie' | 'lifestyle';
```

这里保留 `pov` 的唯一原因是读取历史数据。

加注释：

```ts
/**
 * `pov` is legacy-read-only. New proactive generation may only persist
 * `selfie` or `lifestyle`.
 */
```

不要删除 `pov` 类型，否则已有数据库中的历史 Moment 会失去合法类型。

---

## 4.3 `packages/server/src/db/migrations.ts`

当前最新 migration 是 `39`。

新增 migration：

```ts
{
  version: 40,
  name: 'moments_lifestyle_image_kind',
  up: (db) => {
    db.pragma('defer_foreign_keys = ON');
    db.exec(`
      CREATE TABLE moments_new (
        id                TEXT PRIMARY KEY,
        candidate_id      TEXT NOT NULL UNIQUE,
        text              TEXT NOT NULL,
        image_media_id    TEXT REFERENCES media(id) ON DELETE SET NULL,
        image_kind        TEXT CHECK (image_kind IN ('pov','selfie','lifestyle')),
        activity          TEXT NOT NULL,
        location_id       TEXT,
        location_name     TEXT,
        city              TEXT,
        weather_condition TEXT,
        temperature_c     REAL,
        liked             INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL
      );

      INSERT INTO moments_new(
        id,candidate_id,text,image_media_id,image_kind,activity,
        location_id,location_name,city,weather_condition,temperature_c,liked,created_at
      )
      SELECT
        id,candidate_id,text,image_media_id,image_kind,activity,
        location_id,location_name,city,weather_condition,temperature_c,liked,created_at
      FROM moments;

      DROP TABLE moments;
      ALTER TABLE moments_new RENAME TO moments;
      CREATE INDEX idx_moments_created ON moments(created_at DESC);
    `);
  }
}
```

### 迁移必须验证

因为 `proactive_attempts.moment_id` 外键指向 `moments(id)`，迁移测试必须确认：

1. migration 39 数据库中已有 Moment；
2. `proactive_attempts.moment_id` 已引用该 Moment；
3. 升级到 migration 40；
4. 原 Moment 仍在；
5. 原外键引用仍在；
6. `PRAGMA foreign_key_check` 返回 0 条；
7. 可以新插入 `image_kind='lifestyle'`；
8. 仍然不能插入未知类型。

如果当前 SQLite/测试环境对事务内表重建 + deferred FK 表现不一致，则不要强推 migration 40，应在实现阶段改用仓库现有的安全表重建模式，并以 `migration-upgrade.test.ts` 绿灯作为唯一准入条件。

---

## 4.4 `packages/server/src/core/director/prompts.ts`

当前 `IMAGE_DIRECTOR_PROMPT` 写着：

```text
POV 或纯场景图可以省略 outfit
```

主动图片不再使用 POV 后，建议改成更通用的：

```text
SOOYA 明确出镜时 outfit 必须是完整、规范化、可复用的描述；真正的纯场景图片可以省略 outfit。
```

注意：`MediaDirector` 是共享组件，聊天中的普通非人物图片仍可能存在，所以这里不要全局禁止所有纯场景图片。

主动消息是否允许纯场景，应该由 `ProactiveComposer` 自己负责禁止。

这能避免把“主动消息产品规则”误伤整个聊天生图能力。

---

## 4.5 `packages/server/src/core/image-continuity.ts`

原则上 **不需要修改核心状态模型**。

现有能力已经具备：

- `prepare()`；
- `resolveOutfit()`；
- `applyToPrompt()`；
- `commit()`；
- `runExclusive()`；
- 当天 outfit 持久化；
- 活动/地点连续；
- 合理换装；
- 生成成功后才提交。

本次只需要让 `lifestyle` 调用这套现成能力。

不要创建第二套 `LifestyleContinuityService`。

---

## 4.6 `docs/DAILY-VISUAL-CONTINUITY-PLAN.md`

当前文档仍描述：

- 主动动态包含 `selfie / pov`；
- POV 不强行加入人物穿搭；
- 普通 POV 场景照只约束活动地点。

代码完成后这些说明会过时。

同步更新为：

- 主动图片为 `selfie / lifestyle`；
- 两者都是人物出镜图片；
- 两者都进入当天 outfit continuity；
- `pov` 仅为历史数据兼容值，不再生成。

---

# 5. 测试改造

## 5.1 `packages/server/test/proactive-composer.test.ts`

### 修改 helper

当前：

```ts
function sharePlan(
  text: string,
  image: { kind: 'pov' | 'selfie'; scene: string } | null = ...
)
```

改为新主动类型。

默认测试计划建议直接使用 `lifestyle`。

### 删除/替换旧 POV 正向测试

当前测试：

```text
plans a grounded POV photo and stores it as a Moment media reference
```

替换为：

```text
plans a grounded lifestyle photo with SOOYA in frame and stores it as a Moment media reference
```

至少断言：

```ts
expect(prompt).toContain('社区公园');
expect(prompt).toContain('橘猫');
expect(prompt).toContain('LIFESTYLE COMPOSITION');
expect(prompt).toContain('SOOYA herself must be visibly present');
expect(prompt).toContain('Do not use first-person POV');
expect(prompt).not.toContain('Keep the photographer completely out of frame');
expect(body.input_images).toBeDefined();
```

### 人物参考测试

将：

```text
uses persona references only for a selfie Moment
```

改为：

```text
uses persona references for every on-camera proactive Moment
```

用 `it.each(['selfie', 'lifestyle'])` 验证两类都带 `input_images`。

### 增加旧 POV 自动归一化测试

模拟模型仍返回：

```json
{
  "kind": "pov",
  "scene": "桌上一碗刚端上来的拉面"
}
```

最终必须断言：

- 生图 prompt 不含 first-person POV；
- prompt 明确 SOOYA 入镜；
- action 至少回落到当前 `Life` 活动；
- proactive detail `photoKind === 'lifestyle'`；
- Moment 最终 `image_kind === 'lifestyle'`。

这条测试非常重要，它保证“去掉 POV”不是只靠提示词自觉。

---

## 5.2 `packages/server/test/daily-visual-continuity-integration.test.ts`

### 保留现有自拍连续性测试

以下仍然有效：

- 两张普通同日自拍锁定 outfit；
- 生图失败不 commit outfit；
- 聊天自拍和主动图片共享状态。

### 将主动 selfie 共享连续性扩展到 lifestyle

当前测试：

```text
shares the same persisted outfit between chat selfies and proactive selfie Moments
```

改为更关键的：

```text
shares the same persisted outfit between chat selfies and proactive lifestyle Moments
```

流程：

1. 聊天自拍先确定当天衣服；
2. Life 候选变为公园看猫；
3. 主动图计划返回 `lifestyle`；
4. Director 故意漂移成另一套衣服；
5. 最终 prompt 必须被 continuity 拉回当天 outfit；
6. 状态 revision 不变；
7. activity 更新成真实主动事件。

### 删除旧测试

删除：

```text
does not create or overwrite outfit state for proactive POV scenery photos
```

替换为：

```text
proactive lifestyle photos participate in outfit continuity and commit only after successful generation
```

---

## 5.3 `packages/server/test/migration-upgrade.test.ts`

新增 migration 40 测试。

必须覆盖：

- v39 -> v40；
- 历史 `pov` 行可继续读取；
- 历史 `selfie` 行可继续读取；
- 新 `lifestyle` 可插入；
- `proactive_attempts.moment_id` 外键保持；
- `foreign_key_check` 为空；
- 索引 `idx_moments_created` 存在。

---

## 5.4 其他回归

至少运行：

```bash
npm test --workspace packages/server -- proactive-composer.test.ts
npm test --workspace packages/server -- daily-visual-continuity-integration.test.ts
npm test --workspace packages/server -- image-continuity.test.ts
npm test --workspace packages/server -- media-director-continuity.test.ts
npm test --workspace packages/server -- migration-upgrade.test.ts
npm test --workspace packages/server -- migration-rollback.test.ts
npm test --workspace packages/server -- qq-proactive.test.ts
npm test --workspace packages/server -- qq-delivery-media.test.ts
```

然后运行 server 全量：

```bash
npm test --workspace packages/server
```

最后运行仓库现有综合 CI / release gate。

---

# 6. 端到端生成流程

改造后主动图片链路应为：

```text
Life 候选事件
    ↓
composeMomentSharePlan
    ↓
只规划 lifestyle / selfie
    ↓
如果模型误返 pov，则立即 normalize -> lifestyle
    ↓
buildGroundedScene
    ↓
注入真实 activity / location / weather
    ↓
ImageContinuityService.prepare
    ↓
MediaDirector.image
    ↓
applyMomentCompositionConstraints
    ↓
ImageContinuityService.resolveOutfit + applyToPrompt
    ↓
PersonaReferenceLoader
    ↓
Image Provider
    ↓
MediaStore.save
    ↓
ImageContinuityService.commit
    ↓
Moment 持久化
    ↓
QQ durable delivery
```

关键不变量：

```text
主动图片只要生成，就必须与 SOOYA 本人有关。
```

不是“文字说她在吃饭，图片却只有一碗饭”。

而是：

```text
文字：这个居然比我想的辣……
图片：SOOYA 坐在店里正在吃这碗面，表情和动作自然，食物是生活事件的一部分。
```

---

# 7. Prompt 约束优先级

最终主动人物图片的约束优先级建议固定为：

1. 用户明确指令；
2. 当前真实 `Life` 活动；
3. 当前真实地点；
4. 当天视觉连续性状态；
5. 图片类型硬约束 `lifestyle/selfie`；
6. Media Director 的构图与摄影补全。

其中 Director 无权：

- 把 `lifestyle` 改成纯场景；
- 把人物删掉；
- 把当前活动改掉；
- 随意换当天衣服；
- 把普通生活图改成棚拍写真。

---

# 8. 失败与降级策略

## 8.1 Share Planner 返回旧 `pov`

不失败。

自动升级成 `lifestyle`。

## 8.2 Director 返回空 prompt

保持当前行为：

```text
image_director_failed -> text fallback
```

## 8.3 人物参考缺失

沿用当前策略，但记录：

```ts
referenceMissing: true
```

不应该悄悄把 `lifestyle` 降级成纯场景图。

如果人物身份可靠性不足，宁可本次主动动态退回文字，也不要重新走 POV。

推荐在这一轮顺手强化：

```text
lifestyle/selfie + reference missing -> text fallback
```

这样能避免“有个人，但不是她”。

如果当前产品希望在参考图暂时不可用时仍允许文本 + 无图，这是最安全的降级。

## 8.4 生图失败

保持：

- Moment 可降级文字；
- 不 commit 新 outfit；
- 不更新错误的连续性状态。

## 8.5 lifestyle 构图不合格

第一版不建议额外再调用视觉模型做生成后审核，否则会增加延迟和成本。

先通过：

- Planner 硬规则；
- Composition hard constraints；
- 人物参考；
- continuity；
- 集成测试；

解决主要问题。

后续如果实测仍频繁生成纯食物，可再增加低成本后验视觉 QA。

---

# 9. 可观测性

现有 `proactive_attempt.detail` 已保存 `photoKind`、`referenceUsed` 等信息。

升级到 v4 后建议至少确保 detail 包含：

```json
{
  "sharePlanVersion": 4,
  "photoKind": "lifestyle",
  "referenceUsed": true,
  "referenceMissing": false,
  "imageDirectorUsed": true,
  "mediaPersisted": true,
  "continuity": {
    "dateKey": "...",
    "outfitMode": "locked",
    "outfitRevision": 1,
    "activity": "...",
    "location": "..."
  }
}
```

后续可以直接从 Admin/日志判断：

- lifestyle 占比；
- 自拍占比；
- 是否还有 legacy POV 被模型返回并自动归一化；
- 人物参考是否缺失；
- 连续性是否生效。

建议额外记录：

```ts
legacyPovNormalized: true
```

只在模型原始输出为 `pov` 时出现。

这样过几天就能判断旧 POV 倾向是否已经完全消失。

---

# 10. 验收场景

## 场景 A：吃东西

Life：

```text
在拉面店吃午饭
```

允许：

- SOOYA 坐在桌边正在夹面；
- SOOYA 喝汤；
- 食物与人物同时出现；
- 自然侧面或半身。

禁止：

- 只有一碗拉面；
- 第一视角筷子夹面；
- 只有桌面。

## 场景 B：咖啡店

允许：

- SOOYA 坐窗边喝咖啡；
- SOOYA 看书，咖啡在桌上；
- 如果正文更亲近，可以自然自拍。

禁止：

- 只有咖啡杯；
- 只有窗外风景。

## 场景 C：图书馆

允许：

- SOOYA 坐着看书；
- SOOYA 从书架取书；
- SOOYA 在桌边写东西。

必须继承当天 outfit。

## 场景 D：公园看猫

允许：

- SOOYA 蹲下看猫；
- SOOYA 坐在长椅边逗猫；
- 猫可以很明显，但不能只有猫。

## 场景 E：同日多张主动图片

上午第一张确定穿搭。

下午普通活动变化时：

- lifestyle 继续穿同一套；
- selfie 继续穿同一套；
- 地点和活动正常变化；
- 合理换装场景仍按现有 continuity 规则处理。

---

# 11. 不做的事情

本次不要顺手扩大范围：

- 不修改聊天里的普通 `imagePrompt` 产品定义；
- 不禁止用户主动要求纯风景图；
- 不重写 `Life` 系统；
- 不新增第二套人物状态；
- 不修改 Persona Reference 的选择逻辑；
- 不改变 QQ durable delivery；
- 不新增生图 Provider；
- 不做生成后视觉审核；
- 不删除历史 POV Moment。

这次只解决：

> **主动消息配图从“她看到的东西”改成“她正在经历的生活”。**

---

# 12. 推荐提交拆分

建议 3 个独立 commit，不必拆成很多 PR。

## Commit 1：数据契约

```text
feat: add lifestyle kind for proactive moment images
```

包含：

- `moment.repo.ts`；
- migration 40；
- migration tests。

## Commit 2：生成链路

```text
feat: replace proactive pov photos with lifestyle images
```

包含：

- `proactive.ts`；
- `director/prompts.ts`；
- legacy POV normalize；
- reference + continuity 接入。

## Commit 3：测试与文档

```text
test: cover proactive lifestyle image continuity
```

包含：

- `proactive-composer.test.ts`；
- `daily-visual-continuity-integration.test.ts`；
- `docs/DAILY-VISUAL-CONTINUITY-PLAN.md` 更新。

如果仓库习惯单 PR，三个 commit 放同一个分支和 PR 即可。

---

# 13. CI 准入条件

只有同时满足以下条件才允许合并：

- TypeScript 编译通过；
- migration upgrade/rollback 测试通过；
- `foreign_key_check` 无违规；
- proactive composer 测试通过；
- daily visual continuity integration 通过；
- media director continuity 通过；
- QQ proactive/delivery media 通过；
- server 全量测试通过；
- 仓库综合 CI 全绿。

不能只凭“生出了一张看起来不错的图”判断完成。

---

# 14. 最终验收标准

上线后满足以下条件即视为完成：

1. 新主动动态永远不会以 POV 进入生图 Provider；
2. 主动图片只生成 `lifestyle` 或 `selfie`；
3. `lifestyle` 中 SOOYA 必须可见；
4. 涉及吃东西时，默认是“她正在吃”，而不是纯食物；
5. 涉及地点时，默认是“她在地点里做事”，而不是纯风景；
6. `lifestyle` 与 `selfie` 都加载人物参考；
7. 两者共享同一套当天 outfit continuity；
8. 合理换衣服继续按照现有 continuity 规则工作；
9. 历史 `pov` Moment 仍能正常读取；
10. 生图失败或人物参考不可用时，不回退到 POV；
11. QQ 主动投递链路不受影响；
12. 数据库升级后无 FK 破坏；
13. 全量测试与 CI 通过。

---

# 15. 给实施 Agent 的直接任务摘要

```text
基于 sooya7/sooya 当前 main 实施“主动消息生活人物配图”改造。

目标：
1. 主动消息不再生成 POV/第一视角图片。
2. 新增 lifestyle 主动图片类型，表示 SOOYA 本人在当前真实 Life 场景中自然做事、吃东西、看书、走路等。
3. 保留 selfie。
4. 默认优先 lifestyle，禁止主动图退化成纯风景、纯食物、纯桌面、纯物件。
5. lifestyle 与 selfie 都必须加载 PersonaReference，并进入现有 ImageContinuityService，共享当天 outfit/activity/location。
6. 模型若误返回旧 kind=pov，必须在进入生图链路前自动 normalize 成 lifestyle，禁止把 POV 传给 Image Provider。
7. 历史 POV Moment 保留可读。
8. 数据库 moments.image_kind CHECK 扩展支持 lifestyle，新增安全 migration 40，并验证 proactive_attempts.moment_id 外键完整。
9. sharePlanVersion 升到 4，记录 photoKind 和 legacyPovNormalized。
10. 更新 proactive-composer、daily visual continuity、migration、QQ proactive 相关回归测试。
11. 更新 docs/DAILY-VISUAL-CONTINUITY-PLAN.md 中已经过时的 POV 说明。
12. 不修改聊天普通图片产品规则、不重写 Life、不新增第二套 continuity。

严格按 docs/SOOYA-PROACTIVE-LIFESTYLE-IMAGE-PLAN.md 实施。
全部相关测试和 server 全量测试通过后再结束，不要部署生产，除非另行明确要求。
```
