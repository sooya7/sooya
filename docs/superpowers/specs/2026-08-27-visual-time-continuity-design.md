# Visual time continuity design

Date: 2026-08-27

## Problem

SOOYA currently gives ordinary chat generation the correct `Asia/Shanghai` clock, but the image pipeline does not preserve that clock as an authoritative constraint. The final image-continuity layer carries only the local calendar date, current activity, current location, and outfit.

This caused a real mismatch on 2026-08-26: at about 13:17 China Standard Time, while Life reported `午睡一会儿` at home, an image prompt still described `晚上在家` with warm floor-lamp lighting. The image pipeline preserved the afternoon activity but rendered it as a night scene.

The same missing time contract affects ordinary reply images and proactive images because both use the shared image-continuity service.

## Goals

- Keep SOOYA's real current time immutable and explicit throughout reply and image generation.
- Make an unspecified image scene use the real current local time and day period.
- Treat a user-requested conflicting day period as a retrospective photo, not as a change to current reality.
- Allow a new retrospective image to be generated even when no matching historical media exists.
- Make visible reply wording acknowledge the temporal relationship naturally, for example: `现在还是下午，不过昨晚倒是有一张这种。`
- Apply the same rules to ordinary reply images and proactive images.
- Persist bounded, non-secret visual-time metadata for later diagnosis.

## Non-goals

- Do not change Life's clock, activity schedule, location, or stored history.
- Do not implement a general natural-language calendar parser.
- Do not search the gallery for an existing historical photo in this change.
- Do not rewrite unrelated image, outfit, weather, or proactive scheduling behavior.
- Do not infer a future memory or claim that a newly generated retrospective image was physically captured in the past; it is a generated depiction framed as a past scene.

## Approaches considered

### A. Dual-clock visual-time contract — selected

Carry both the real current time and the depicted scene time through reply planning, media direction, final prompt constraints, and metadata. Resolve conflicts deterministically.

This is the only approach that protects both time cognition and rendered lighting while still allowing retrospective generation.

### B. Prompt-only reminder

Add a sentence telling the model to respect the current time. This is small but remains probabilistic, does not guarantee past-tense reply wording, and provides poor audit evidence.

### C. Reject conflicting requests

Return text only when a requested time conflicts with reality. This is reliable but conflicts with the accepted requirement to allow newly generated retrospective photos.

## Time semantics

The system derives a local visual clock from an instant and the configured timezone, currently `Asia/Shanghai`.

The shared time context contains:

```ts
interface VisualTimeContext {
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
```

`VisualDayPeriod` is a small deterministic set suitable for lighting constraints: `late-night`, `morning`, `midday`, `afternoon`, and `evening`. One tested helper owns these half-open local-time boundaries rather than repeating them in prompts:

- `late-night`: 00:00–05:00
- `morning`: 05:00–11:00
- `midday`: 11:00–14:00
- `afternoon`: 14:00–18:00
- `evening`: 18:00–24:00

Rules:

1. No explicit day-period request: `mode=current`; the depicted time equals the real current time.
2. Explicit request matching the current period: `mode=current`.
3. Explicit request conflicting with the current period: `mode=retrospective`; the real current time remains unchanged. If the request contains a supported relative-past expression such as `昨晚` or `昨天早上`, that expression determines the depicted date. Otherwise the depicted date is the previous local calendar day and the depicted period is the requested period. Thus a night request at 13:17 is always framed as the previous evening/night, never as the current afternoon or the coming evening.
4. A vague continuation such as `再来一张` never inherits a stale conflicting day period merely because an earlier prompt contained one. It defaults to the current clock unless the latest user request explicitly supplies a period.
5. Life activity and location remain authoritative only for a current scene. A retrospective scene takes activity and location from the latest explicit user request; when those are absent, it uses neutral compatible defaults rather than presenting current Life state as historical fact. It must not mutate current Life state or create a Life-history record.

## Components and data flow

### Visual-time resolver

A small pure module derives the current day period, recognizes a bounded set of explicit Chinese and English day-period expressions, and returns `VisualTimeContext`.

It only detects direct expressions such as morning, noon, afternoon, evening, tonight, late night, sleep-at-night phrasing, and bounded relative-past forms such as yesterday morning or last night. Ambiguous words are not treated as a time override. In an immediate image request, `今晚` or `tonight` supplies an evening scene intent but does not advance the real clock; when it conflicts with the current period, the resolver applies the same previous-day retrospective rule. Explicit future dates and scheduling requests are outside this change and must not silently become current or retrospective scenes.

### Reply planning

The reply context continues to state the real local clock. For image requests it additionally states:

- current time is factual and cannot be changed by the request;
- a matching scene is current;
- a conflicting requested period must be framed as a past/retrospective image;
- visible text must use the corresponding temporal language and must not imply the scene is happening now.

The resolver result is computed from the latest user request, not from stale assistant image prompts.

### Media director

`MediaDirector.image` receives the visual-time context alongside activity, location, and outfit continuity. Its fallback prompt includes both the real current clock and the depicted time.

### Final image-continuity layer

The final hard-constraint block is authoritative and contains:

- real current local date and time;
- current day period;
- `current` or `retrospective` mode;
- depicted local date and day period;
- lighting guidance appropriate to the depicted period;
- an explicit instruction to ignore earlier time-of-day or lighting descriptions that conflict with this block.

For the reported case, the final prompt must say that reality is approximately 13:17 in Shanghai, the current period is midday, and an unspecified continuation must use daylight. If the user explicitly requests a night sleeping photo, the prompt instead marks it as a retrospective scene from the previous evening while preserving the current midday clock.

### Proactive images

Proactive generation uses the same resolver and final hard constraints. Its event timestamp may legitimately be historical; that event time becomes the depicted time while the publication time remains the real current time. Visible copy must not present an old event as happening now.

### Metadata

Generated image metadata records only bounded fields:

- `timeMode`
- `timeZone`
- `currentInstant`
- `currentDayPeriod`
- `depictedLocalDate`
- `depictedDayPeriod`
- `requestedDayPeriod`

No prompt secrets, credentials, or additional private context are introduced.

## Error handling and fallback

- If timezone formatting fails, use the configured timezone with the existing UTC instant and fall back to a conservative `current` mode.
- If no explicit period can be recognized, do not guess; use the current day period.
- If reply wording or an image prompt conflicts with the resolved time context, the final hard constraint wins.
- Image-provider failure keeps the existing media failure behavior; this change does not alter delivery fallback semantics.

## Tests

Tests are written before production changes and must demonstrate the previous failure.

1. At 13:17 in `Asia/Shanghai`, `再来一张` resolves to `current` and a daylight midday scene; a stale `晚上` prompt is overridden.
2. At 13:17, an explicit request for a night sleeping photo resolves to `retrospective`, preserves the real 13:17 clock, and depicts the previous evening.
3. At night, an explicit night request remains `current`.
4. Reply-planning instructions require past-tense acknowledgement for a retrospective request.
5. Media-director and final-continuity prompts contain both clocks and the conflict-override rule.
6. Ordinary reply images and proactive images persist the same bounded time metadata.
7. Existing outfit, activity, reference-image, and proactive image tests remain green.

## Acceptance criteria

- The reported 13:16 `再来一张` scenario can no longer produce an unqualified current-night scene.
- An explicit conflicting night request can still generate a new image, but SOOYA keeps the afternoon as current reality and frames the image as retrospective.
- Current Life state is unchanged by image requests.
- Both ordinary and proactive image paths use the shared visual-time contract.
- Focused tests, server test suites, type checks, and build checks pass before deployment.
