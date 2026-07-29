import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { publicFailure, redactDiagnostic } from '../src/core/public-error.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

describe('public error helpers', () => {
  it('creates stable localized failures with unique incident IDs', () => {
    const first = publicFailure('internal_error');
    const second = publicFailure('internal_error');
    expect(first).toMatchObject({
      code: 'internal_error',
      message: '服务器暂时无法处理请求，请稍后重试。',
      incidentId: expect.stringMatching(/^inc_/)
    });
    expect(second.incidentId).not.toBe(first.incidentId);
  });

  it('redacts credentials, secret assignments, secret URL parameters, and absolute paths', () => {
    const error = new Error(
      'Bearer sk-secret-upstream apiKey=sk-assignment token: tok-value secret="hidden" client_secret=hunter2 ' +
        'https://user:p@ss@example.test/path?token=abc&client_secret=hunter2'
    );
    error.stack =
      `${error.name}: ${error.message}\n` +
      '    at load (C:\\Users\\name\\My Project\\provider file.ts:10:2)\n' +
      '    at start (/opt/sooya/My Project/provider file.ts:20:4)\n' +
      '    at esm (file:///C:/Users/name/My%20Project/file.ts:30:6)';
    const diagnostic = redactDiagnostic(error);

    expect(diagnostic).toContain('[REDACTED]');
    for (const secret of [
      'sk-secret-upstream',
      'sk-assignment',
      'tok-value',
      'hidden',
      'hunter2',
      'user:p@ss',
      'ss@example.test',
      'token=abc',
      'client_secret=hunter2',
      'C:\\Users\\name\\My Project\\provider file.ts',
      '/opt/sooya/My Project/provider file.ts',
      'file:///C:/Users/name/My%20Project/file.ts'
    ]) {
      expect(diagnostic).not.toContain(secret);
    }
  });
});

describe('Fastify error boundary', () => {
  it('returns only a generic incident response and stores a redacted diagnostic', async () => {
    h = await createHarness();
    const sensitive =
      'route exploded with sk-secret-upstream at https://user:pass@api.example.test/v1?token=sk-secret-upstream from /opt/sooya/private/route.ts';
    h.app.server.get('/api/test-unexpected-error', async () => {
      throw new Error(sensitive);
    });

    const response = await h.app.server.inject({ method: 'GET', url: '/api/test-unexpected-error' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: 'internal_error',
      message: '服务器暂时无法处理请求，请稍后重试。',
      incidentId: expect.stringMatching(/^inc_/)
    });
    expect(response.body).not.toContain('sk-secret-upstream');
    expect(response.body).not.toContain('api.example.test');
    expect(response.body).not.toContain('/opt/sooya/private/route.ts');

    const diagnostic = h.app.repos.errors.list(10).find((entry) => entry.scope === 'http.unexpected');
    expect(diagnostic).toBeTruthy();
    expect(JSON.stringify(diagnostic)).toContain(response.json().incidentId);
    expect(JSON.stringify(diagnostic)).toContain('route exploded');
    expect(JSON.stringify(diagnostic)).not.toContain('sk-secret-upstream');
    expect(JSON.stringify(diagnostic)).not.toContain('/opt/sooya/private/route.ts');
  });

  it('preserves status, code, and message for explicitly safe thrown application errors', async () => {
    h = await createHarness();
    h.app.server.get('/api/test-expected-error', async () => {
      throw Object.assign(new Error('请求状态冲突'), {
        statusCode: 409,
        code: 'safe_conflict',
        sooyaPublicSafe: true
      });
    });
    const response = await h.app.server.inject({ method: 'GET', url: '/api/test-expected-error' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'safe_conflict', message: '请求状态冲突' });
  });

  it('does not trust arbitrary thrown framework 4xx messages', async () => {
    h = await createHarness();
    h.app.server.get('/api/test-internal-4xx', async () => {
      throw Object.assign(new Error('internal parser detail sk-secret-upstream'), {
        statusCode: 400,
        code: 'FST_INTERNAL_DETAIL'
      });
    });
    const response = await h.app.server.inject({ method: 'GET', url: '/api/test-internal-4xx' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'bad_request', message: '请求格式不正确。' });
    expect(response.body).not.toContain('sk-secret-upstream');
    expect(response.body).not.toContain('FST_INTERNAL_DETAIL');
  });
});
