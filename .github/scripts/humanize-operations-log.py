from pathlib import Path

panel_path = Path('packages/web/src/components/AdminPanel.tsx')
panel = panel_path.read_text(encoding='utf-8')

start = panel.index('function OperationsPanel({ onNotice }: { onNotice: (v: string) => void }) {')
end = panel.index('/** Loads the persona the avatar editor edits, which the old page shell owned. */', start)

replacement = r'''type AdminErrorGroup = {
  key: string;
  count: number;
  latest: AdminError;
  title: string;
  explanation: string;
};

function operationAreaLabel(scope: string): string {
  if (scope === 'job.sticker.analyze' || scope.includes('sticker.analy')) return '表情包 AI 分析';
  if (scope.includes('sticker')) return '表情包处理';
  if (scope.includes('moment') || scope.includes('proactive')) return '朋友圈发布';
  if (scope.includes('life')) return '生活状态更新';
  if (scope.includes('weather')) return '天气更新';
  if (scope.includes('image')) return '图片生成';
  if (scope.includes('tts') || scope.includes('voice')) return '语音处理';
  if (scope.includes('push')) return '消息推送';
  if (scope.includes('chat') || scope.includes('reply')) return '聊天回复';
  if (scope.includes('memory') || scope.includes('embedding') || scope.includes('rerank')) return '记忆系统';
  if (scope.includes('database') || scope.includes('sqlite') || scope.includes('db')) return '数据库';
  return '后台任务';
}

function operationErrorCopy(error: AdminError): { title: string; explanation: string } {
  const area = operationAreaLabel(error.scope);
  const message = error.message.toLowerCase();

  if (message.includes('invalid_analysis_json')) {
    return {
      title: '表情包 AI 分析结果格式异常',
      explanation: '视觉模型返回的数据格式不符合要求，本次分析结果没有保存。若持续出现，建议检查视觉模型配置或输出格式。'
    };
  }
  if (/timeout|timed out|etimedout/.test(message)) {
    return {
      title: `${area}超时`,
      explanation: '上游服务在限定时间内没有返回结果。系统会按任务策略重试，持续出现时再检查接口速度或网络。'
    };
  }
  if (/rate.?limit|too many requests|\b429\b/.test(message)) {
    return {
      title: `${area}请求过于频繁`,
      explanation: '上游服务触发了频率限制。通常等待一会儿即可恢复，频繁发生时需要降低并发或提高额度。'
    };
  }
  if (/unauthor|forbidden|invalid.?key|\b401\b|\b403\b/.test(message)) {
    return {
      title: `${area}鉴权失败`,
      explanation: '服务拒绝了当前凭据。请检查对应模型或服务的 API Key、权限和接口地址。'
    };
  }
  if (/not configured|unconfigured|provider.*config|missing.*key/.test(message)) {
    return {
      title: `${area}尚未配置完整`,
      explanation: '这项能力缺少必要配置，因此任务没有继续执行。请到对应设置页补齐服务地址、模型或密钥。'
    };
  }
  if (/fetch failed|network|econn|socket|dns|connection/.test(message)) {
    return {
      title: `${area}连接失败`,
      explanation: '系统没有成功连到上游服务。持续出现时请检查网络、代理、接口地址以及服务是否可用。'
    };
  }
  if (/json|parse|schema|invalid.*format/.test(message)) {
    return {
      title: `${area}返回格式异常`,
      explanation: '上游返回的内容与系统预期格式不一致，本次结果没有采用。技术详情里保留了原始错误码。'
    };
  }
  if (/not found|missing|enoent|\b404\b/.test(message)) {
    return {
      title: `${area}所需资源不存在`,
      explanation: '任务引用的资源或上游地址没有找到。可先检查对应媒体、配置或服务地址是否仍然有效。'
    };
  }

  return {
    title: `${area}出现异常`,
    explanation: '系统记录到一次异常。这里先显示可读摘要，原始错误码和详细数据收在“查看技术详情”里。'
  };
}

function groupAdminErrors(errors: AdminError[]): AdminErrorGroup[] {
  const groups = new Map<string, AdminErrorGroup>();
  for (const error of errors) {
    const key = `${error.scope}\u0000${error.message}`;
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

function operationDetailText(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail.trim() || null;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function operationJobLabel(type: string): string {
  if (type.includes('sticker') && type.includes('analy')) return '表情包 AI 分析';
  if (type.includes('sticker')) return '表情包处理';
  if (type.includes('moment') || type.includes('proactive')) return '朋友圈发布';
  if (type.includes('life')) return '生活状态更新';
  if (type.includes('weather')) return '天气更新';
  if (type.includes('image')) return '图片生成';
  if (type.includes('tts') || type.includes('voice')) return '语音处理';
  if (type.includes('push')) return '消息推送';
  if (type.includes('reply') || type.includes('chat')) return '聊天回复';
  return '后台任务';
}

function operationJobStatus(status: string): string {
  const value = status.toLowerCase();
  if (['queued', 'pending'].includes(value)) return '等待处理';
  if (['running', 'processing', 'leased'].includes(value)) return '处理中';
  if (['completed', 'done', 'success', 'succeeded'].includes(value)) return '已完成';
  if (['failed', 'dead'].includes(value)) return '失败';
  if (['cancelled', 'canceled'].includes(value)) return '已取消';
  if (value.includes('retry')) return '等待重试';
  return status;
}

function OperationsPanel({ onNotice }: { onNotice: (v: string) => void }) {
  const [errors, setErrors] = useState<AdminError[]>([]);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [backups, setBackups] = useState<AdminBackup[]>([]);

  const groupedErrors = useMemo(() => groupAdminErrors(errors), [errors]);

  const load = useCallback(async () => {
    try {
      const [e, j, b] = await Promise.all([adminApi.errors(), adminApi.jobs(), adminApi.backups()]);
      setErrors(e.errors);
      setJobs(j.jobs);
      setBackups(b.backups);
    } catch (err) {
      onNotice(errorText(err));
    }
  }, [onNotice]);

  useEffect(() => { void load(); }, [load]);

  const run = async (work: () => Promise<unknown>, message: string) => {
    try {
      await work();
      await load();
      onNotice(message);
    } catch (e) {
      onNotice(errorText(e));
    }
  };

  return (
    <section className="admin-operations">
      <article className="admin-card" data-testid="admin-error-list">
        <div className="admin-card-subtitle">
          <h2>最近错误</h2>
          <span className="admin-count-badge">{errors.length ? `${groupedErrors.length} 类 · ${errors.length} 次` : '0'}</span>
        </div>
        {errors.length ? (
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
      </article>

      <article className="admin-card" data-testid="admin-job-list">
        <div className="admin-card-subtitle"><h2>后台任务</h2><span className="admin-count-badge">{jobs.length}</span></div>
        {jobs.length ? (
          <div className="admin-log-scroll">
            {jobs.map((job) => (
              <div className="admin-list-row admin-job-readable" key={job.id} title={`${job.type} · ${job.status}`}>
                <span><strong>{operationJobLabel(job.type)}</strong><small>{operationJobStatus(job.status)}</small></span>
                <small>尝试 {job.attempts}/{job.max_attempts}</small>
              </div>
            ))}
          </div>
        ) : <EmptyState>暂无后台任务</EmptyState>}
      </article>

      <article className="admin-card" data-testid="admin-backup-list">
        <div className="admin-card-heading"><div><h2>备份</h2><p>{backups.length} 份可用备份</p></div><button type="button" onClick={() => void run(() => adminApi.createBackup(), '备份已创建')}>创建备份</button></div>
        {backups.length ? backups.map((b) => <div className="admin-list-row" key={b.name}><span>{b.name} · {formatBytes(b.bytes)}</span><div><button type="button" onClick={() => void run(() => adminApi.verifyBackup(b.name), '备份校验完成')}>校验</button><button type="button" onClick={() => { if (confirmAction(`确认恢复备份“${b.name}”？`)) void run(() => adminApi.restoreBackup(b.name), '备份已恢复，请刷新聊天页面'); }}>恢复</button><button type="button" className="admin-danger" onClick={() => { if (confirmAction(`确认删除备份“${b.name}”？`)) void run(() => adminApi.deleteBackup(b.name), '备份已删除'); }}>删除</button></div></div>) : <EmptyState>暂无备份，可先创建一份</EmptyState>}
      </article>
    </section>
  );
}

'''

panel_path.write_text(panel[:start] + replacement + panel[end:], encoding='utf-8')

css_path = Path('packages/web/src/components/AdminPanel.css')
css = css_path.read_text(encoding='utf-8')
marker = '/* ---- Human-readable operations logs ---- */'
if marker not in css:
    css += r'''

/* ---- Human-readable operations logs ---- */
.admin-v2 .admin-log-scroll {
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  margin: 4px -4px 10px 0;
  padding-right: 4px;
}

.admin-v2 .admin-error-groups {
  display: grid;
  gap: 8px;
}

.admin-v2 .admin-error-group {
  padding: 10px 11px;
  background: var(--admin-surface-soft);
  border: 1px solid var(--admin-line);
  border-radius: 11px;
}

.admin-v2 .admin-error-group-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.admin-v2 .admin-error-group-head strong {
  min-width: 0;
  color: var(--admin-text);
  font-size: 13px;
  line-height: 1.35;
}

.admin-v2 .admin-error-group-head span {
  flex: 0 0 auto;
  padding: 2px 7px;
  color: var(--admin-warning);
  background: var(--admin-warning-soft);
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}

.admin-v2 .admin-error-group p {
  margin: 5px 0 4px;
  color: var(--admin-muted);
  font-size: 11px;
  line-height: 1.5;
}

.admin-v2 .admin-error-group > small {
  color: var(--admin-faint);
  font-size: 10px;
}

.admin-v2 .admin-error-technical {
  margin-top: 6px;
  color: var(--admin-muted);
  font-size: 10px;
}

.admin-v2 .admin-error-technical summary {
  width: max-content;
  max-width: 100%;
  cursor: pointer;
  color: var(--admin-primary-deep);
  font-weight: 650;
}

.admin-v2 .admin-error-technical code,
.admin-v2 .admin-error-technical pre {
  display: block;
  max-width: 100%;
  margin-top: 6px;
  padding: 7px 8px;
  overflow: auto;
  color: var(--admin-text);
  background: var(--admin-surface);
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.admin-v2 .admin-job-readable > span {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.admin-v2 .admin-job-readable > span strong {
  font-size: 12px;
}

.admin-v2 .admin-job-readable > span small {
  color: var(--admin-muted);
  font-size: 10px;
}

@media (max-width: 560px) {
  .admin-v2 .admin-log-scroll {
    max-height: 280px;
  }

  .admin-v2 .admin-error-group {
    padding: 9px 10px;
  }
}
'''
    css_path.write_text(css, encoding='utf-8')

print('rewritten operations log UI')
