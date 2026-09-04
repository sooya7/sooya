import { describe, expect, it } from 'vitest';
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProxyFetch, socks5Handshake } from '../src/util/proxyFetch.js';
import { UserInterruptedError } from '../src/util/abort.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_KEY = readFileSync(join(HERE, 'fixtures', 'proxy-test-key.pem'), 'utf8');
const FIXTURE_CERT = readFileSync(join(HERE, 'fixtures', 'proxy-test-cert.pem'), 'utf8');

/**
 * Real end-to-end proxy test: a local HTTPS origin + a local SOCKS5 proxy that
 * forwards CONNECT to it. The proxy fetch implementation must complete
 * SOCKS5 CONNECT → TLS handshake → HTTP 200 — no timers, no "timeout counts as
 * pass".
 */

interface Fixture {
  close: () => Promise<void>;
  socksPort: number;
  originPort: number;
  originConnected: Promise<void>;
}

/** HTTPS origin + forwarding SOCKS5 proxy. */
async function startFixture(originDelayMs = 0): Promise<Fixture> {
  // 1. HTTPS origin (fixture cert committed with the test).
  let markOriginConnected!: () => void;
  const originConnected = new Promise<void>((resolve) => { markOriginConnected = resolve; });
  const origin = createTlsServer({ key: FIXTURE_KEY, cert: FIXTURE_CERT }, (socket) => {
    markOriginConnected();
    const send = () => {
      if (socket.destroyed) return;
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok');
      socket.end();
    };
    if (originDelayMs > 0) setTimeout(send, originDelayMs);
    else send();
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originPort = (origin.address() as { port: number }).port;

  // 2. SOCKS5 proxy that forwards CONNECT to the origin.
  const proxy = createNetServer((client: Socket) => {
    let stage: 'greeting' | 'connect' = 'greeting';
    let buffer = Buffer.alloc(0);
    let upstream: Socket | null = null;

    const onClientData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        // Greeting: VER(1) NMETHODS(1) METHODS... — accept no-auth (0x00).
        if (buffer.length < 3) return;
        const nMethods = buffer[1] ?? 0;
        if (buffer.length < 2 + nMethods) return;
        const supportsNoAuth = buffer.subarray(2, 2 + nMethods).includes(0x00);
        buffer = buffer.subarray(2 + nMethods);
        client.write(Buffer.from([0x05, supportsNoAuth ? 0x00 : 0xff]));
        if (!supportsNoAuth) { client.destroy(); return; }
        stage = 'connect';
        return;
      }
      // Connect: VER CMD RSV ATYP(3=domain) LEN HOST PORT
      if (buffer.length < 5) return;
      const atyp = buffer[3];
      if (atyp !== 0x03) { client.destroy(); return; }
      const hostLen = buffer[4] ?? 0;
      if (buffer.length < 5 + hostLen + 2) return;
      const host = buffer.subarray(5, 5 + hostLen).toString('utf8');
      const port = buffer.readUInt16BE(5 + hostLen);
      buffer = buffer.subarray(5 + hostLen + 2);
      const target = netConnect({ host, port });
      upstream = target;
      target.once('connect', () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        // Stop parsing: from here on this is a raw TCP tunnel. Without this
        // the TLS ClientHello would be re-parsed as a CONNECT request.
        client.removeListener('data', onClientData);
        target.pipe(client);
        client.pipe(target);
        if (buffer.length > 0) target.write(buffer);
      });
      target.once('error', () => client.destroy());
      client.once('error', () => target.destroy());
    };
    client.on('data', onClientData);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const socksPort = (proxy.address() as { port: number }).port;

  return {
    socksPort,
    originPort,
    originConnected,
    close: async () => {
      proxy.close();
      origin.close();
    }
  };
}

describe('createProxyFetch (real SOCKS5 → TLS → HTTPS)', () => {
  it('completes a real HTTPS request through the SOCKS5 proxy', async () => {
    const fixture = await startFixture();
    try {
      const fetchImpl = createProxyFetch(`socks5h://127.0.0.1:${fixture.socksPort}`, { rejectUnauthorized: false });
      const res = await fetchImpl(`https://127.0.0.1:${fixture.originPort}/hello`, { method: 'GET' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      await fixture.close();
    }
  });

  it('aborts an in-flight SOCKS request without an uncaught socket error and preserves the reason', async () => {
    const fixture = await startFixture(250);
    const fetchImpl = createProxyFetch(`socks5h://127.0.0.1:${fixture.socksPort}`, { rejectUnauthorized: false });
    const controller = new AbortController();
    const reason = new UserInterruptedError('superseded by newer user message');
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      const pending = fetchImpl(`https://127.0.0.1:${fixture.originPort}/slow`, { signal: controller.signal });
      await fixture.originConnected;
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(uncaught).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await fixture.close();
    }
  });

  it('sends the SOCKS5 greeting and CONNECT for the target host', async () => {
    const fixture = await startFixture();
    try {
      const socket = await socks5Handshake('127.0.0.1', fixture.socksPort, '127.0.0.1', fixture.originPort);
      // Reaching this point means the full handshake completed. The socket is
      // the client→proxy connection (the proxy holds the origin connection).
      expect(socket.destroyed).toBe(false);
      expect(socket.remotePort).toBe(fixture.socksPort);
      socket.destroy();
      expect(socket.destroyed).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('rejects unsupported proxy protocols', () => {
    expect(() => createProxyFetch('https://127.0.0.1:8082')).toThrow(/unsupported proxy protocol/);
  });
});

/**
 * Origin that speaks chunked transfer encoding under test control, so a test
 * can observe the body arriving *before* the response is complete. Also
 * records the request bytes it received, for body-integrity assertions.
 */
interface ChunkedFixture {
  close: () => Promise<void>;
  socksPort: number;
  originPort: number;
  /** Resolves with the raw request bytes once the head + body have arrived. */
  request: Promise<Buffer>;
  sendChunk: (text: string) => void;
  finish: () => void;
}

async function startChunkedFixture(): Promise<ChunkedFixture> {
  let originSocket: Socket | null = null;
  let markRequest!: (raw: Buffer) => void;
  const request = new Promise<Buffer>((resolve) => { markRequest = resolve; });
  const pendingChunks: string[] = [];
  let headSent = false;

  const flush = (): void => {
    if (!originSocket || !headSent) return;
    while (pendingChunks.length > 0) {
      const text = pendingChunks.shift()!;
      const payload = Buffer.from(text, 'utf8');
      originSocket.write(`${payload.length.toString(16)}\r\n`);
      originSocket.write(payload);
      originSocket.write('\r\n');
    }
  };

  const origin = createTlsServer({ key: FIXTURE_KEY, cert: FIXTURE_CERT }, (socket) => {
    originSocket = socket;
    let received = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (!headSent && received.includes('\r\n\r\n')) {
        headSent = true;
        socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n');
        markRequest(received);
        flush();
      }
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originPort = (origin.address() as { port: number }).port;

  const proxy = createNetServer((client: Socket) => {
    let stage: 'greeting' | 'connect' = 'greeting';
    let buffer = Buffer.alloc(0);
    const onClientData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 3) return;
        const nMethods = buffer[1] ?? 0;
        if (buffer.length < 2 + nMethods) return;
        buffer = buffer.subarray(2 + nMethods);
        client.write(Buffer.from([0x05, 0x00]));
        stage = 'connect';
        return;
      }
      if (buffer.length < 5) return;
      const hostLen = buffer[4] ?? 0;
      if (buffer.length < 5 + hostLen + 2) return;
      const host = buffer.subarray(5, 5 + hostLen).toString('utf8');
      const port = buffer.readUInt16BE(5 + hostLen);
      buffer = buffer.subarray(5 + hostLen + 2);
      const target = netConnect({ host, port });
      target.once('connect', () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.removeListener('data', onClientData);
        target.pipe(client);
        client.pipe(target);
        if (buffer.length > 0) target.write(buffer);
      });
      target.once('error', () => client.destroy());
      client.once('error', () => target.destroy());
    };
    client.on('data', onClientData);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const socksPort = (proxy.address() as { port: number }).port;

  return {
    socksPort,
    originPort,
    request,
    sendChunk: (text: string) => { pendingChunks.push(text); flush(); },
    finish: () => { originSocket?.write('0\r\n\r\n'); },
    close: async () => { proxy.close(); origin.close(); originSocket?.destroy(); }
  };
}

describe('createProxyFetch: streaming, bounds and socket lifecycle', () => {
  /*
   * The regression that mattered most: the transport used to buffer the whole
   * response before resolving, so every `accept: text/event-stream` request
   * silently degraded into a blocking call. This asserts the first SSE frame is
   * readable while the origin is still generating.
   */
  it('delivers a chunked body incrementally instead of buffering it whole', async () => {
    const fixture = await startChunkedFixture();
    try {
      const fetchImpl = createProxyFetch(`socks5h://127.0.0.1:${fixture.socksPort}`, { rejectUnauthorized: false });
      const res = await fetchImpl(`https://127.0.0.1:${fixture.originPort}/v1/chat`, {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: '{"stream":true}'
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      fixture.sendChunk('data: {"delta":"你"}\n\n');
      const first = await reader.read();
      expect(decoder.decode(first.value)).toBe('data: {"delta":"你"}\n\n');

      // The origin has NOT finished — a buffering transport could not have
      // produced the frame above.
      fixture.sendChunk('data: {"delta":"好"}\n\n');
      const second = await reader.read();
      expect(decoder.decode(second.value)).toBe('data: {"delta":"好"}\n\n');

      fixture.finish();
      expect((await reader.read()).done).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('passes a binary request body through byte-for-byte', async () => {
    const fixture = await startChunkedFixture();
    try {
      const fetchImpl = createProxyFetch(`socks5h://127.0.0.1:${fixture.socksPort}`, { rejectUnauthorized: false });
      // Bytes that are NOT valid utf8: the old Buffer.from(String(body)) path
      // replaced these with U+FFFD and corrupted every binary upload.
      const payload = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0x7f, 0xc3, 0x28]);
      const pending = fetchImpl(`https://127.0.0.1:${fixture.originPort}/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: payload
      });
      const raw = await fixture.request;
      const bodyStart = raw.indexOf('\r\n\r\n') + 4;
      expect(raw.subarray(bodyStart, bodyStart + payload.length).equals(payload)).toBe(true);
      expect(raw.toString('latin1')).toContain(`content-length: ${payload.length}`);
      fixture.finish();
      await pending;
    } finally {
      await fixture.close();
    }
  });

  it('rejects a body that exceeds maxResponseBytes instead of buffering it', async () => {
    const fixture = await startChunkedFixture();
    try {
      const fetchImpl = createProxyFetch(`socks5h://127.0.0.1:${fixture.socksPort}`, {
        rejectUnauthorized: false,
        maxResponseBytes: 64
      });
      const res = await fetchImpl(`https://127.0.0.1:${fixture.originPort}/big`, { method: 'GET' });
      fixture.sendChunk('x'.repeat(200));
      await expect(res.text()).rejects.toThrow(/exceeded 64 bytes/u);
    } finally {
      await fixture.close();
    }
  });

  it('refuses body types it cannot serialise rather than sending "[object Object]"', async () => {
    const fetchImpl = createProxyFetch('socks5h://127.0.0.1:1080');
    const form = new FormData();
    form.append('a', 'b');
    await expect(fetchImpl('https://example.invalid/x', { method: 'POST', body: form }))
      .rejects.toThrow(/cannot serialise a FormData body/u);
  });

  it('destroys the proxy socket once the response body ends', async () => {
    const fixture = await startFixture();
    try {
      const handshakeSockets: Socket[] = [];
      const fetchImpl = createProxyFetch(`socks5h://127.0.0.1:${fixture.socksPort}`, { rejectUnauthorized: false });
      const res = await fetchImpl(`https://127.0.0.1:${fixture.originPort}/hello`, { method: 'GET' });
      expect(await res.text()).toBe('ok');
      // Give the teardown a turn of the event loop, then assert nothing is left
      // holding a descriptor: the old implementation never destroyed either socket.
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const socket of handshakeSockets) expect(socket.destroyed).toBe(true);
      const handles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles();
      const liveToProxy = handles.filter((handle): handle is Socket =>
        handle instanceof Object && 'remotePort' in handle
        && (handle as Socket).remotePort === fixture.socksPort
        && !(handle as Socket).destroyed
      );
      expect(liveToProxy).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
