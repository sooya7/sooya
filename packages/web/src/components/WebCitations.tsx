interface Citation {
  title: string;
  url: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  doubao: '豆包搜索',
  tavily: 'Tavily',
  responses: 'Responses 原生搜索'
};

export function WebCitations({ meta }: { meta?: Record<string, unknown> }): React.ReactNode {
  if (meta?.webSearchUsed !== true || !Array.isArray(meta.webCitations)) return null;
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const value of meta.webCitations) {
    if (!value || typeof value !== 'object') continue;
    const raw = value as Record<string, unknown>;
    if (typeof raw.url !== 'string') continue;
    const url = safeUrl(raw.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push({
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : new URL(url).hostname,
      url
    });
    if (citations.length >= 5) break;
  }
  if (citations.length === 0) return null;
  const provider = typeof meta.webSearchProvider === 'string' ? meta.webSearchProvider : '';
  return (
    <aside className="web-citations" data-testid="web-citations" aria-label="联网来源">
      <div className="web-citations-title">来源 · {PROVIDER_LABELS[provider] ?? '联网搜索'}</div>
      <ol>
        {citations.map((citation) => (
          <li key={citation.url}>
            <a href={citation.url} target="_blank" rel="noopener noreferrer">{citation.title}</a>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
