from pathlib import Path

path = Path('packages/web/src/components/AdminPanel.tsx')
text = path.read_text(encoding='utf-8')

old = '''function groupAdminErrors(errors: AdminError[]): AdminErrorGroup[] {
  const groups = new Map<string, AdminErrorGroup>();
  for (const error of errors) {
    const key = `${error.scope}\\u0000${error.message}`;
    const existing = groups.get(key);
    if (!existing) {
      const copy = operationErrorCopy(error);
      groups.set(key, { key, count: 1, latest: error, ...copy });
      continue;
    }
    existing.count += 1;
    if (Date.parse(error.createdAt) > Date.parse(existing.latest.createdAt)) existing.latest = error;
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt));
}
'''
new = '''function groupAdminErrors(errors: AdminError[]): AdminErrorGroup[] {
  const groups = new Map<string, AdminErrorGroup>();
  for (const error of errors) {
    const copy = operationErrorCopy(error);
    // Group by the problem a human can act on, not by raw backend code. Several
    // parser/provider variants can describe the same visible failure mode.
    const key = copy.title;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, count: 1, latest: error, ...copy });
      continue;
    }
    existing.count += 1;
    if (Date.parse(error.createdAt) > Date.parse(existing.latest.createdAt)) existing.latest = error;
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt));
}
'''
if old not in text:
    raise SystemExit('groupAdminErrors block not found')
text = text.replace(old, new, 1)

marker = '''function operationJobStatus(status: string): string {
  const value = status.toLowerCase();
  if (['queued', 'pending'].includes(value)) return '等待处理';
  if (['running', 'processing', 'leased'].includes(value)) return '处理中';
  if (['completed', 'done', 'success', 'succeeded'].includes(value)) return '已完成';
  if (['failed', 'dead'].includes(value)) return '失败';
  if (['cancelled', 'canceled'].includes(value)) return '已取消';
  if (value.includes('retry')) return '等待重试';
  return status;
}
'''
insert = marker + '''
type AdminJobGroup = {
  key: string;
  label: string;
  status: string;
  count: number;
  latest: AdminJob;
};

function groupAdminJobs(jobs: AdminJob[]): AdminJobGroup[] {
  const groups = new Map<string, AdminJobGroup>();
  for (const job of jobs) {
    const label = operationJobLabel(job.type);
    const status = operationJobStatus(job.status);
    const key = `${label}\\u0000${status}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, label, status, count: 1, latest: job });
      continue;
    }
    existing.count += 1;
    if (Date.parse(job.updated_at) > Date.parse(existing.latest.updated_at)) existing.latest = job;
  }

  const priority = (status: string) => status === '失败' ? 0 : status === '处理中' ? 1 : status === '等待重试' ? 2 : status === '等待处理' ? 3 : 4;
  return [...groups.values()].sort((a, b) => {
    const delta = priority(a.status) - priority(b.status);
    return delta || Date.parse(b.latest.updated_at) - Date.parse(a.latest.updated_at);
  });
}
'''
if marker not in text:
    raise SystemExit('operationJobStatus block not found')
text = text.replace(marker, insert, 1)

old = '''  const groupedErrors = useMemo(() => groupAdminErrors(errors), [errors]);
'''
new = '''  const groupedErrors = useMemo(() => groupAdminErrors(errors), [errors]);
  const groupedJobs = useMemo(() => groupAdminJobs(jobs), [jobs]);
'''
if old not in text:
    raise SystemExit('groupedErrors line not found')
text = text.replace(old, new, 1)

old = '''        {errors.length ? (
          <div className="admin-log-scroll admin-error-groups">
            {groupedErrors.map((group) => {
              const detail = operationDetailText(group.latest.detail);
              return (
                <article className="admin-error-group" key={group.key}>
                  <div className="admin-error-group-head">
                    <strong>{group.title}</strong>
                    <span>{group.count} 次</span>
                  </div>
                  <p>{group.explanation}</p>
                  <small>最近发生：{formatAdminDateTime(group.latest.createdAt)}</small>
                  <details className="admin-error-technical">
                    <summary>查看技术详情</summary>
                    <code>{group.latest.scope} · {group.latest.message}</code>
                    {detail && <pre>{detail}</pre>}
                  </details>
                </article>
              );
            })}
          </div>
        ) : <EmptyState>暂无错误记录</EmptyState>}
        <div className="admin-actions"><button type="button" className="admin-danger" onClick={() => { if (confirmAction('确认清空错误记录？')) void run(() => adminApi.clearErrors(), '错误记录已清空'); }}>清空错误记录</button></div>
'''
new = '''        {errors.length ? (
          <div className="admin-log-scroll admin-error-groups">
            {groupedErrors.map((group) => {
              const detail = operationDetailText(group.latest.detail);
              return (
                <details className="admin-error-group" key={group.key}>
                  <summary className="admin-error-summary">
                    <span><strong>{group.title}</strong><small>最近：{formatAdminDateTime(group.latest.createdAt)}</small></span>
                    <b>{group.count} 次</b>
                  </summary>
                  <p>{group.explanation}</p>
                  <div className="admin-error-technical">
                    <strong>技术详情</strong>
                    <code>{group.latest.scope} · {group.latest.message}</code>
                    {detail && <pre>{detail}</pre>}
                  </div>
                </details>
              );
            })}
          </div>
        ) : <EmptyState>暂无错误记录</EmptyState>}
        <div className="admin-log-footer"><button type="button" className="admin-danger" onClick={() => { if (confirmAction('确认清空错误记录？')) void run(() => adminApi.clearErrors(), '错误记录已清空'); }}>清空错误记录</button></div>
'''
if old not in text:
    raise SystemExit('error rendering block not found')
text = text.replace(old, new, 1)

old = '''        {jobs.length ? (
          <div className="admin-log-scroll">
            {jobs.map((job) => (
              <div className="admin-list-row admin-job-readable" key={job.id} title={`${job.type} · ${job.status}`}>
                <span><strong>{operationJobLabel(job.type)}</strong><small>{operationJobStatus(job.status)}</small></span>
                <small>尝试 {job.attempts}/{job.max_attempts}</small>
              </div>
            ))}
          </div>
        ) : <EmptyState>暂无后台任务</EmptyState>}
'''
new = '''        {jobs.length ? (
          <div className="admin-log-scroll admin-job-groups">
            {groupedJobs.map((group) => (
              <div className="admin-list-row admin-job-readable" key={group.key} title={`${group.latest.type} · ${group.latest.status}`}>
                <span><strong>{group.label}</strong><small>{group.status} · 最近 {formatAdminDateTime(group.latest.updated_at)}</small></span>
                <span className="admin-job-count">{group.count} 个</span>
              </div>
            ))}
          </div>
        ) : <EmptyState>暂无后台任务</EmptyState>}
'''
if old not in text:
    raise SystemExit('job rendering block not found')
text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')

css_path = Path('packages/web/src/components/AdminPanel.css')
css = css_path.read_text(encoding='utf-8')
css += r'''

/* Compact operations summaries: the page shows problems, not raw rows. */
.admin-v2 .admin-error-group {
  padding: 0;
  overflow: hidden;
}

.admin-v2 .admin-error-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 11px;
  cursor: pointer;
  list-style: none;
}

.admin-v2 .admin-error-summary::-webkit-details-marker { display: none; }

.admin-v2 .admin-error-summary > span {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.admin-v2 .admin-error-summary strong {
  overflow: hidden;
  color: var(--admin-text);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-v2 .admin-error-summary small {
  color: var(--admin-muted);
  font-size: 9px;
}

.admin-v2 .admin-error-summary b,
.admin-v2 .admin-job-count {
  flex: 0 0 auto;
  padding: 3px 7px;
  color: var(--admin-warning);
  background: var(--admin-warning-soft);
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}

.admin-v2 .admin-error-group[open] > p,
.admin-v2 .admin-error-group[open] > .admin-error-technical {
  margin-left: 11px;
  margin-right: 11px;
}

.admin-v2 .admin-error-group[open] > p {
  margin-top: 0;
  padding-top: 1px;
}

.admin-v2 .admin-error-group[open] > .admin-error-technical {
  margin-bottom: 10px;
}

.admin-v2 .admin-log-footer {
  display: flex;
  align-items: center;
  min-height: 46px;
  margin: 0 -14px -13px;
  padding: 8px 14px;
  background: var(--admin-surface);
  border-top: 1px solid var(--admin-line);
}

.admin-v2 .admin-log-footer button {
  min-height: 34px;
  padding: 6px 11px;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 650;
}

.admin-v2 .admin-job-groups .admin-list-row {
  min-height: 50px;
}

.admin-v2 .admin-job-count {
  color: var(--admin-primary-deep);
  background: var(--admin-primary-soft);
}

@media (max-width: 560px) {
  .admin-v2 .admin-log-scroll { max-height: 230px; }
  .admin-v2 .admin-error-summary { padding: 9px 10px; }
  .admin-v2 .admin-log-footer { margin-left: -14px; margin-right: -14px; }
}
'''
css_path.write_text(css, encoding='utf-8')

# Update the focused AdminPanel test to cover human-readable grouping.
test_path = Path('packages/web/src/components/AdminPanel.test.tsx')
test = test_path.read_text(encoding='utf-8')
test = test.replace("  testWebSearch: vi.fn(async (provider: string) => ({ ok: true, provider, latencyMs: 1, resultCount: 1 })),\n", "  testWebSearch: vi.fn(async (provider: string) => ({ ok: true, provider, latencyMs: 1, resultCount: 1 })),\n  errors: vi.fn(async () => ({ errors: [\n    { id: 'e1', createdAt: '2026-08-12T04:55:00.000Z', scope: 'job.sticker.analyze', message: 'invalid_analysis_json', detail: { raw: 'bad' } },\n    { id: 'e2', createdAt: '2026-08-12T04:54:00.000Z', scope: 'job.sticker.analyze', message: 'invalid_analysis_json: schema', detail: null }\n  ] })),\n  jobs: vi.fn(async () => ({ jobs: [\n    { id: 'j1', type: 'life.tick', status: 'completed', attempts: 1, max_attempts: 3, last_error: null, created_at: '2026-08-12T04:00:00.000Z', updated_at: '2026-08-12T04:00:01.000Z' },\n    { id: 'j2', type: 'life.tick', status: 'completed', attempts: 1, max_attempts: 3, last_error: null, created_at: '2026-08-12T04:05:00.000Z', updated_at: '2026-08-12T04:05:01.000Z' }\n  ] })),\n  clearErrors: vi.fn(async () => ({ ok: true })),\n")
needle = "  it('联网搜索位于现有模型配置的能力列表中', async () => {"
case = '''  it('运维页按人话问题类型和任务状态聚合日志', async () => {\n    window.history.replaceState(null, '', '/admin/operations');\n    container = document.createElement('div');\n    document.body.append(container);\n    root = createRoot(container);\n    await act(async () => {\n      root!.render(<AdminPanel initialTab=\"operations\" />);\n      await Promise.resolve();\n      await Promise.resolve();\n    });\n\n    const errors = container.querySelector('[data-testid=\"admin-error-list\"]')!;\n    expect(errors.textContent).toContain('表情包 AI 分析结果格式异常');\n    expect(errors.textContent).toContain('1 类 · 2 次');\n    expect(errors.textContent).not.toContain('invalid_analysis_json');\n\n    const jobs = container.querySelector('[data-testid=\"admin-job-list\"]')!;\n    expect(jobs.textContent).toContain('生活状态更新');\n    expect(jobs.textContent).toContain('已完成');\n    expect(jobs.textContent).toContain('2 个');\n  });\n\n'''
if needle not in test:
    raise SystemExit('test insertion point not found')
test = test.replace(needle, case + needle, 1)
test_path.write_text(test, encoding='utf-8')

print('compacted operations summaries')
