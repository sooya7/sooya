import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type JsonWebKey
} from 'node:crypto';
import type { SettingsRepo, ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { PushSubscriptionRepo, PushSubscriptionRow } from '../db/repos/feature.repo.js';
import type { ChatMessage } from './types.js';

interface StoredVapidKeys {
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  publicKey: string;
  subject: string;
}

export interface BrowserPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface PushSendSummary {
  attempted: number;
  delivered: number;
  removed: number;
  failed: number;
}

const SETTINGS_KEY = 'push.vapid';
const FRONTEND_ACTIVE_MS = 35_000;
/**
 * A push service only answers 404/410 for an endpoint it still knows about. One that
 * keeps timing out or 5xx-ing is never cleaned up by that path, so `fail_count` was
 * written on every failure and read by nobody: dead endpoints accumulated forever and
 * every later send paid for them. Six consecutive failures is a dead endpoint.
 */
const MAX_CONSECUTIVE_FAILURES = 6;

export class PushService {
  private readonly keys: StoredVapidKeys;

  constructor(
    private readonly subscriptions: PushSubscriptionRepo,
    private readonly settings: SettingsRepo,
    private readonly errors: ErrorLogRepo,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.keys = this.loadOrCreateKeys();
  }

  publicKey(): string {
    return this.keys.publicKey;
  }

  status(): { configured: boolean; subscriptions: number; publicKey: string } {
    return { configured: true, subscriptions: this.subscriptions.count(), publicKey: this.keys.publicKey };
  }

  subscribe(input: BrowserPushSubscription): void {
    const endpoint = String(input.endpoint ?? '').trim();
    const p256dh = String(input.keys?.p256dh ?? '').trim();
    const auth = String(input.keys?.auth ?? '').trim();
    if (!/^https:\/\//i.test(endpoint) || !p256dh || !auth) throw new Error('invalid push subscription');
    if (endpoint.length > 2048 || p256dh.length > 512 || auth.length > 256) throw new Error('push subscription is too large');
    this.subscriptions.upsert({ endpoint, p256dh, auth, expirationTime: input.expirationTime ?? null });
  }

  unsubscribe(endpoint: string): boolean {
    return this.subscriptions.remove(endpoint);
  }

  setVisibility(endpoint: string, visible: boolean): void {
    this.subscriptions.markVisibility(endpoint, visible);
  }

  async notifyReply(message: ChatMessage): Promise<PushSendSummary> {
    const body = message.content
      .map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'audio' ? part.transcript ?? '' : part.type === 'image' ? '[图片]' : part.type === 'sticker' ? '[表情包]' : '')
      .filter(Boolean)
      .join('\n')
      .replace(/(?:sk|key|token)-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
      .slice(0, 180) || 'SOOYA 回复你了';
    return await this.send({
      title: 'SOOYA',
      body,
      tag: `sooya-reply-${message.id}`,
      url: `/?message=${encodeURIComponent(message.id)}`,
      messageId: message.id
    });
  }

  async send(payload: Record<string, unknown>): Promise<PushSendSummary> {
    const summary: PushSendSummary = { attempted: 0, delivered: 0, removed: 0, failed: 0 };
    const now = Date.now();
    for (const subscription of this.subscriptions.list()) {
      const recentlyVisible = subscription.visible === 1 && subscription.last_seen_at && now - Date.parse(subscription.last_seen_at) < FRONTEND_ACTIVE_MS;
      if (recentlyVisible) continue;
      summary.attempted++;
      try {
        const response = await this.deliver(subscription, Buffer.from(JSON.stringify(payload)));
        if (response.ok || response.status === 201) {
          this.subscriptions.markSuccess(subscription.endpoint);
          summary.delivered++;
          continue;
        }
        if (response.status === 404 || response.status === 410) {
          this.subscriptions.remove(subscription.endpoint);
          summary.removed++;
          continue;
        }
        summary.failed++;
        this.errors.add('push.deliver', `push endpoint returned ${response.status}`, { endpoint: originOnly(subscription.endpoint) });
        if (this.retire(subscription.endpoint)) summary.removed++;
      } catch (err) {
        summary.failed++;
        this.errors.add('push.deliver', (err as Error).message, { endpoint: originOnly(subscription.endpoint) });
        if (this.retire(subscription.endpoint)) summary.removed++;
      }
    }
    return summary;
  }

  /** Count one failure and drop the endpoint once it is clearly dead. */
  private retire(endpoint: string): boolean {
    const failures = this.subscriptions.markFailure(endpoint);
    if (failures < MAX_CONSECUTIVE_FAILURES) return false;
    this.subscriptions.remove(endpoint);
    this.errors.add('push.retire', `dropped endpoint after ${failures} consecutive failures`, { endpoint: originOnly(endpoint) });
    return true;
  }

  private async deliver(subscription: PushSubscriptionRow, payload: Buffer): Promise<Response> {
    const encrypted = encryptPayload(payload, subscription.p256dh, subscription.auth);
    const audience = new URL(subscription.endpoint).origin;
    const token = makeVapidJwt(this.keys, audience);
    return await this.fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        TTL: '300',
        Urgency: 'normal',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: `vapid t=${token}, k=${this.keys.publicKey}`
      },
      body: encrypted
    });
  }

  private loadOrCreateKeys(): StoredVapidKeys {
    const stored = this.settings.get<StoredVapidKeys | null>(SETTINGS_KEY, null);
    if (stored?.publicJwk?.x && stored.privateJwk?.d && stored.publicKey) return stored;
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicJwk = pair.publicKey.export({ format: 'jwk' }) as JsonWebKey;
    const privateJwk = pair.privateKey.export({ format: 'jwk' }) as JsonWebKey;
    if (!publicJwk.x || !publicJwk.y) throw new Error('failed to generate VAPID key');
    const publicKey = base64url(Buffer.concat([Buffer.from([4]), fromBase64url(publicJwk.x), fromBase64url(publicJwk.y)]));
    const created: StoredVapidKeys = { publicJwk, privateJwk, publicKey, subject: 'mailto:admin@localhost' };
    this.settings.set(SETTINGS_KEY, created);
    return created;
  }
}

function encryptPayload(payload: Buffer, clientPublicKey: string, authSecret: string): Buffer {
  const clientPublic = fromBase64url(clientPublicKey);
  if (clientPublic.length !== 65 || clientPublic[0] !== 4) throw new Error('invalid push p256dh key');
  const auth = fromBase64url(authSecret);
  const sender = createECDH('prime256v1');
  sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const sharedSecret = sender.computeSecret(clientPublic);

  const authPrk = hkdfExtract(auth, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPublic, senderPublic]);
  const ikm = hkdfExpand(authPrk, keyInfo, 32);
  const salt = randomBytes(16);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plaintext = Buffer.concat([payload, Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21 + senderPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(senderPublic.length, 20);
  senderPublic.copy(header, 21);
  return Buffer.concat([header, ciphertext]);
}

function makeVapidJwt(keys: StoredVapidKeys, audience: string): string {
  const header = base64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: keys.subject })));
  const unsigned = `${header}.${claims}`;
  const privateKey = createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${base64url(signature)}`;
}

function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac('sha256', salt).update(ikm).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(chunks).length < length; counter++) {
    previous = createHmac('sha256', prk).update(Buffer.concat([previous, info, Buffer.from([counter])])).digest();
    chunks.push(previous);
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function base64url(value: Buffer): string {
  return value.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromBase64url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized + '='.repeat((4 - normalized.length % 4) % 4), 'base64');
}

function originOnly(endpoint: string): string {
  try { return new URL(endpoint).origin; } catch { return 'invalid-endpoint'; }
}
