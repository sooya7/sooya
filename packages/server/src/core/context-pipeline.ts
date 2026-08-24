import type { Persona } from '../config/schema.js';
import type { ChatMessage } from './types.js';
import type { LifeRuntime } from './life.js';
import type { FutureContextService } from './future/context.js';
import type { RelationshipContextService } from './relationship/service.js';
import type { WorldSnapshot } from './world-context.js';

export interface ContextRequest {
  persona: Persona;
  latestUserText: string;
  recent: ChatMessage[];
  now: Date;
  lastUserAt?: Date | null;
}

export interface ContextFragment {
  sourceId: string;
  priority: number;
  lines: string[];
  metadata?: Record<string, unknown>;
}

export interface ContextSource {
  id: string;
  priority: number;
  collect(request: ContextRequest): Promise<ContextFragment | null> | ContextFragment | null;
}

export class ContextSourcePipeline {
  private readonly sources: ContextSource[] = [];

  register(source: ContextSource): this {
    this.sources.push(source);
    this.sources.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    return this;
  }

  async collect(request: ContextRequest): Promise<ContextFragment[]> {
    const fragments: ContextFragment[] = [];
    for (const source of this.sources) {
      try {
        const fragment = await source.collect(request);
        if (fragment && fragment.lines.length > 0) fragments.push({ ...fragment, lines: fragment.lines.filter((line) => line.trim()).slice(0, 40) });
      } catch {
        // Context is an enhancement. A failed optional source must never block
        // the current reply; the source's own health/error layer records detail.
      }
    }
    return fragments;
  }

  sourceIds(): string[] { return this.sources.map((source) => source.id); }
}

export function createContextSourcePipeline(deps: {
  life?: LifeRuntime;
  future?: FutureContextService;
  relationship?: RelationshipContextService;
  worldSnapshot?: () => WorldSnapshot;
}): ContextSourcePipeline {
  const pipeline = new ContextSourcePipeline();
  pipeline.register({
    id: 'future', priority: 80,
    collect: () => deps.future ? { sourceId: 'future', priority: 80, lines: deps.future.contextLines() } : null
  });
  pipeline.register({
    id: 'relationship', priority: 70,
    collect: () => deps.relationship ? { sourceId: 'relationship', priority: 70, lines: deps.relationship.contextLines() } : null
  });
  pipeline.register({
    id: 'life', priority: 60,
    collect: (request) => deps.life ? { sourceId: 'life', priority: 60, lines: deps.life.contextLines(request.lastUserAt ?? null) } : null
  });
  pipeline.register({
    id: 'world', priority: 50,
    collect: () => {
      const city = deps.worldSnapshot?.().city;
      if (!city?.name) return null;
      return { sourceId: 'world', priority: 50, lines: [`当前城市：${[city.country ?? '中国', city.region, city.name].filter(Boolean).join('')}`] };
    }
  });
  return pipeline;
}
