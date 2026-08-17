import { describe, expect, it, vi } from 'vitest';
import { QqApiClient } from './client.js';
import type { QqBotConfig } from './config.js';

const config: QqBotConfig = {
  enabled: true,
  appId: 'app-id',
  appSecret: 'app-secret',
  callbackSecret: 'app-secret',
  env: 'production',
  allowedUsers: ['owner-openid'],
  proactiveEnabled: true
};

describe('QqApiClient media upload', () => {
  it('does not auto-send during upload because delivery sends msg_type=7 separately', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      bodies.push(body);
      if ('appId' in body) {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ file_uuid: 'uuid', file_info: 'info', ttl: 3600 }), { status: 200 });
    }) as typeof fetch;

    const client = new QqApiClient(config, { baseUrl: 'https://qq.invalid', fetchImpl });
    await client.uploadMedia({ openid: 'owner-openid', fileType: 3, bytes: Buffer.from('audio') });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      file_type: 3,
      srv_send_msg: false
    });
  });
});
