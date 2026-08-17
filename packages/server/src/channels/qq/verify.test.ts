import { describe, it, expect } from 'vitest';
import {
  derivedPublicKeyHex,
  isTimestampFresh,
  seedFromBotSecret,
  signEventBody,
  signValidationResponse,
  verifyEventSignature
} from './verify.js';

/**
 * 官方契约测试（bot.q.qq.com wiki event-emit.html / sign.html，2026-08 核对）。
 * Ed25519 签名：timestamp + body；密钥 = bot secret 补满 32 字节 seed 派生。
 * 固定向量锁定「secret → seed → 公钥」派生，任何改动都会破坏契约。
 */
const SECRET = 'test-callback-secret-2026';

describe('qq verify: seed derivation', () => {
  it('matches the official repeated-seed derivation (fixed vector)', () => {
    expect(seedFromBotSecret(SECRET).toString('hex')).toBe('746573742d63616c6c6261636b2d7365637265742d32303236746573742d6361');
    // 公钥（jwk.x, base64url）为固定值；与官方 Go 参考实现派生结果一致。
    expect(derivedPublicKeyHex(SECRET)).toBe('_dUfN-Gn00jKT7oKsulKT-Iv2MRhsS6OkvxCtqfPyg0');
  });

  it('truncates long secrets to the first 32 bytes', () => {
    const long = 'a'.repeat(64);
    expect(seedFromBotSecret(long).length).toBe(32);
    expect(seedFromBotSecret(long).toString('hex')).toBe('61'.repeat(32));
  });
});

describe('qq verify: event signature', () => {
  it('accepts a valid signature over timestamp + body', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE' }));
    const signature = signEventBody(SECRET, timestamp, body);
    expect(signature).toMatch(/^[0-9a-f]{128}$/u);
    expect(verifyEventSignature(SECRET, timestamp, signature, body)).toBe(true);
  });

  it('rejects a tampered body or signature', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from('{"content":"你好"}');
    const signature = signEventBody(SECRET, timestamp, body);
    expect(verifyEventSignature(SECRET, timestamp, signature, Buffer.from('{"content":"你坏"}'))).toBe(false);
    const flipped = signature[0] === 'a' ? `b${signature.slice(1)}` : `a${signature.slice(1)}`;
    expect(verifyEventSignature(SECRET, timestamp, flipped, body)).toBe(false);
  });

  it('rejects a signature produced with a different secret', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from('{}');
    const signature = signEventBody('wrong-secret', timestamp, body);
    expect(verifyEventSignature(SECRET, timestamp, signature, body)).toBe(false);
  });

  it('rejects malformed headers (non-hex, wrong length, non-numeric timestamp)', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from('{}');
    expect(verifyEventSignature(SECRET, timestamp, 'zzzz', body)).toBe(false);
    expect(verifyEventSignature(SECRET, timestamp, 'abc', body)).toBe(false);
    expect(verifyEventSignature(SECRET, 'not-a-timestamp', signEventBody(SECRET, 'not-a-timestamp', body), body)).toBe(false);
  });
});

describe('qq verify: timestamp window (replay protection)', () => {
  it('accepts a fresh timestamp and rejects stale ones', () => {
    const fresh = String(Math.floor(Date.now() / 1000));
    expect(isTimestampFresh(fresh)).toBe(true);
    expect(isTimestampFresh(String(Math.floor(Date.now() / 1000) - 60 * 60))).toBe(false);
    expect(isTimestampFresh(String(Math.floor(Date.now() / 1000) + 60 * 60))).toBe(false);
    expect(isTimestampFresh('garbage')).toBe(false);
  });

  it('rejects an event signed with an expired timestamp', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const body = Buffer.from('{"op":0}');
    const signature = signEventBody(SECRET, stale, body);
    expect(verifyEventSignature(SECRET, stale, signature, body)).toBe(false);
  });
});

describe('qq verify: URL validation (op 13)', () => {
  it('signs event_ts + plain_token and can be verified back', () => {
    const eventTs = String(Math.floor(Date.now() / 1000));
    const token = '0123456789abcdef';
    const signature = signValidationResponse(SECRET, eventTs, token);
    expect(signature).toMatch(/^[0-9a-f]{128}$/u);
    expect(verifyEventSignature(SECRET, eventTs, signature, Buffer.from(token))).toBe(true);
  });

  it('produces a deterministic signature for the same inputs', () => {
    expect(signValidationResponse(SECRET, '1740000000', 'pt1')).toBe(signValidationResponse(SECRET, '1740000000', 'pt1'));
    expect(signValidationResponse(SECRET, '1740000000', 'pt1')).not.toBe(signValidationResponse(SECRET, '1740000000', 'pt2'));
  });
});