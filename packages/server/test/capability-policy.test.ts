import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { createCapabilityPolicy } from '../src/config/capabilities.js';

describe('effective capability policy', () => {
  it('reports Ombre read/write switches instead of only the memory pipeline flag', () => {
    const env = loadEnv({ NODE_ENV: 'test', MEMORY_BACKEND: 'ombre', OMBRE_READ_ENABLED: 'false', OMBRE_WRITE_ENABLED: 'true' });
    const policy = createCapabilityPolicy(env);
    expect(policy.memory).toMatchObject({ backend: 'ombre', read: false, write: true });
  });

  it('reports proactive delivery as ineffective when QQ delivery is disabled', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      QQ_BOT_ENABLED: 'true',
      QQ_APP_ID: 'app',
      QQ_APP_SECRET: 'secret',
      QQ_CALLBACK_SECRET: 'callback',
      QQ_PROACTIVE_ENABLED: 'false'
    });
    const policy = createCapabilityPolicy(env);
    expect(policy.proactive.effective).toBe(false);
    expect(policy.proactive.reasons).toContain('qq proactive delivery is disabled');
  });

  it('reports future proactive as effective when QQ is configured and enabled', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      QQ_BOT_ENABLED: 'true',
      QQ_APP_ID: 'app',
      QQ_APP_SECRET: 'secret',
      QQ_CALLBACK_SECRET: 'callback'
    });
    expect(createCapabilityPolicy(env).proactive.effective).toBe(true);
  });
});
