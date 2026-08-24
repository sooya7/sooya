import { DEFAULT_JOB_CONTRACT, laneForJob, timeoutForLane } from './lanes.js';
import type { JobContract, JobDefinition, JobHandler, JobLane } from './types.js';

export class JobRegistry {
  private readonly definitions = new Map<string, JobDefinition>();

  register(type: string, execute: JobHandler, contract: Partial<JobContract> = {}): JobDefinition {
    const lane = contract.lane ?? laneForJob(type);
    const definition: JobDefinition = {
      type,
      lane,
      timeoutMs: contract.timeoutMs ?? timeoutForLane(lane),
      maxAttempts: contract.maxAttempts ?? DEFAULT_JOB_CONTRACT.maxAttempts,
      retryable: contract.retryable ?? DEFAULT_JOB_CONTRACT.retryable,
      cancellable: contract.cancellable ?? DEFAULT_JOB_CONTRACT.cancellable,
      timeoutMode: contract.timeoutMode ?? DEFAULT_JOB_CONTRACT.timeoutMode,
      execute
    };
    this.definitions.set(type, definition);
    return definition;
  }

  registerDefinition(definition: JobDefinition): void {
    this.definitions.set(definition.type, definition);
  }

  get(type: string): JobDefinition | undefined {
    return this.definitions.get(type);
  }

  all(): JobDefinition[] {
    return [...this.definitions.values()];
  }

  allTypes(): string[] {
    return [...this.definitions.keys()];
  }

  typesForLane(lane: JobLane): string[] {
    return this.all().filter((definition) => definition.lane === lane).map((definition) => definition.type);
  }
}
