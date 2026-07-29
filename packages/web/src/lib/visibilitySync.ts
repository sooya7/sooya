export interface VisibilitySynchronizer {
  notify(): void;
  dispose(): void;
}

export function createVisibilitySynchronizer(
  send: (visible: boolean) => Promise<void>,
  readVisibility: () => boolean
): VisibilitySynchronizer {
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const retryDelays = [250, 1_000] as const;

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const attempt = async (currentGeneration: number, visible: boolean, attemptIndex: number): Promise<void> => {
    try {
      await send(visible);
    } catch {
      if (disposed || currentGeneration !== generation || attemptIndex >= retryDelays.length) return;
      timer = setTimeout(() => {
        timer = null;
        void attempt(currentGeneration, visible, attemptIndex + 1);
      }, retryDelays[attemptIndex]);
    }
  };

  return {
    notify() {
      if (disposed) return;
      cancelTimer();
      generation++;
      void attempt(generation, readVisibility(), 0);
    },
    dispose() {
      disposed = true;
      generation++;
      cancelTimer();
    }
  };
}
