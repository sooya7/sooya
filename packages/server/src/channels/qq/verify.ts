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

/*
 * op 13 输入的形状约束 —— 这是一条安全边界，不只是入参校验。
 *
 * op 13（URL 验证）与 op 0（事件推送）用同一把私钥、同一种 `prefix ‖ payload`
 * 字节拼接方式签名：
 *   op 13: sign(event_ts ‖ plain_token)
 *   op 0 : verify(timestamp ‖ rawBody)
 * 两者构造完全相同，没有域分隔。而 op 13 分支在签名校验之前、不需要任何凭据
 * 即可调用（协议要求如此：回调地址验证正是用来证明持有 Secret 的握手）。
 *
 * 如果不约束输入，op 13 就是一个开放给全网的、对攻击者任意选定消息的签名预言机：
 * 把想伪造的事件体当作 plain_token 提交 → 拿回对该事件体有效的签名 → 原样重放为
 * op 0，verifyEventSignature 会通过。等于 webhook 签名校验被完全绕过。
 *
 * 切断方式：能走到 op 0 的 body 必须是合法 JSON 对象（app.ts 的 JSON 解析器会先
 * 拒掉非 JSON 负载），因此必然含 `{` 与 `"`。下面的字符集刻意排除了这两者以及
 * 空白与控制字符，使 op 13 在数学上无法产出任何可用于 op 0 的签名，同时仍兼容
 * 十六进制 / base64 / base64url / JWT 等一切现实中的不透明 token 形态。
 */
const PLAIN_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{1,256}$/u;
const EVENT_TS_RE = /^\d{1,20}$/u;

/**
 * op 13 的 (event_ts, plain_token) 是否允许被签名。
 * 返回 false 时调用方必须拒绝请求，不得退化成「签一个空值」。
 */
export function isSignableValidationInput(eventTs: string, plainToken: string): boolean {
  return EVENT_TS_RE.test(eventTs) && PLAIN_TOKEN_RE.test(plainToken);
}

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
  /*
   * 防御性拒签：调用方应当已经校验过形状，但签名原语自己也绝不为可疑输入签名。
   * 这样即便未来新增一个忘记校验的调用点，签名预言机也不会被重新打开。
   */
  if (!isSignableValidationInput(eventTs, plainToken)) {
    throw new Error('refusing to sign a validation payload with an unexpected shape');
  }
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