import { useEffect, useState } from 'react';

/**
 * Notice state that clears itself. The admin console pinned every notice on
 * screen until the next one replaced it ("人设已保存" could sit there for the
 * whole session); the chat page already auto-clears after 5s, and now anything
 * using this hook behaves the same. A fresh notice restarts the countdown.
 */
export function useAutoNotice(timeoutMs = 5000): [string | null, (text: string | null) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [notice, timeoutMs]);
  return [notice, setNotice];
}
