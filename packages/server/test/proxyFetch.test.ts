import { describe, expect, it } from 'vitest';
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProxyFetch, socks5Handshake } from '../src/util/proxyFetch.js';

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
}

/** HTTPS origin + forwarding SOCKS5 proxy. */
async function startFixture(): Promise<Fixture> {
  // 1. HTTPS origin (fixture cert committed with the test).
  const origin = createTlsServer({ key: FIXTURE_KEY, cert: FIXTURE_CERT }, (socket) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok');
    socket.end();
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
