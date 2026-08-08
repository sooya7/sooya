/**
 * React 18+ only makes `act()` available when the environment declares it.
 * Without this flag every act(...) call in a jsdom test is a no-op that logs
 * "The current testing environment is not configured to support act(...)" to
 * stderr, so state updates from effects/async work leak outside act and the
 * warnings flood the suite. Tests render through react-dom/client, so the
 * flag is required for them to actually assert batched updates.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
