import crypto from 'node:crypto';

/*
 * QQ webhook 签名（bot.q.qq.com wiki, sign.html / event-emit.html，2026-08 核对）：
 * - 事件推送（Dispatch, op 0）：HTTP 头 X-Signature-Ed25519（64 字节 hex）与
 *   X-Signature-Timestamp（unix 秒）；被签内容 = timestamp 字符串 + 原始 Body 字节。
 * - URL 验证（op 13）：body 为 { op:13, d:{ plain_token, event_ts } }，
 *   需回 { plain_token, signature }，其中 signature = hex(ed25519.sign(event_ts + plain_token))。
 * - 密钥派生：把 Bot Secret 按字节反复拼接直到 >= 32 字节，取前 32 字节作为
 *   ed25519 seed（对应官方 Go 代码 strings.Repeat(seed,2) 后 seed[:ed25519.SeedSize]）。
 * 使用 Node 内置 crypto：把 32 字节 seed 包进 PKCS#8 DER 构造 ed25519 私钥，
 * 再派生公钥做 sign/verify，不引入额外依赖。
 *
 * 时间戳窗口：±5 分钟（防重放）。过期/畸形签名一律拒绝并写安全日志。
 */

/** PKCS#8 DER 前缀 + 空算法参数（id-Ed25519 OID 1.3.101.112） + 嵌套 octet string。 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SIGNED_BODY_TTL_MS = 5 * 60 * 1000;

/** 与官方一致：按字节 repeat secret 直至 >= 32 字节，取前 32 字节。 */
export function seedFromBotSecret(secret: string): Buffer {
  let bytes = Buffer.from(secret, 'utf8');
  while (bytes.length < 32) bytes = Buffer.concat([bytes, bytes]);
  return bytes.subarray(0, 32);
}

function ed25519PrivateKey(seed: Buffer): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function ed25519PublicKey(seed: Buffer): crypto.KeyObject {
  return crypto.createPublicKey(ed25519PrivateKey(seed));
}

/** 派生出的公钥（hex）——固定向量测试可校验 seed 派生与官方算法一致。 */
export function derivedPublicKeyHex(secret: string): string {
  return ed25519PublicKey(seedFromBotSecret(secret)).export({ format: 'jwk' }).x as string;
}

/**
 * 校验事件推送签名。timestamp 必须为 unix 秒字符串，signature 必须为 128 位 hex，
 * 且时间戳落在当前时间 ± SIGNED_BODY_TTL_MS 内。
 */
export function verifyEventSignature(secret: string, timestamp: unknown, signatureHex: unknown, rawBody: Buffer): boolean {
  if (typeof signatureHex !== 'string' || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) return false;
  if (!isTimestampFresh(timestamp)) return false;
  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
  try {
    return crypto.verify(null, message, ed25519PublicKey(seedFromBotSecret(secret)), Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** URL 验证回包签名：hex(ed25519.sign(event_ts + plain_token))。 */
export function signValidationResponse(secret: string, eventTs: string, plainToken: string): string {
  const message = Buffer.concat([Buffer.from(eventTs, 'utf8'), Buffer.from(plainToken, 'utf8')]);
  return crypto.sign(null, message, ed25519PrivateKey(seedFromBotSecret(secret))).toString('hex');
}

/** 事件请求签名：hex(ed25519.sign(timestamp + body))。测试 / Admin 测试发送复验用。 */
export function signEventBody(secret: string, timestamp: string, rawBody: Buffer): string {
  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
  return crypto.sign(null, message, ed25519PrivateKey(seedFromBotSecret(secret))).toString('hex');
}

export function isTimestampFresh(timestampValue: string, windowMs = SIGNED_BODY_TTL_MS): boolean {
  const seconds = Number(timestampValue);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(Date.now() / 1000 - seconds) <= windowMs / 1000;
}