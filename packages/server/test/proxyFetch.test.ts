import { describe, expect, it } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { createProxyFetch } from '../src/util/proxyFetch.js';

/**
 * A minimal SOCKS5 server that records the greeting and CONNECT request bytes,
 * then destroys the socket. The test asserts the exact protocol bytes the
 * proxy fetch implementation sends — real TLS to a vendor is covered by the
 * deployment smoke test.
 */
function startSocksServer(): Promise<{ port: number; close: () => void; greeting: Promise<Buffer>; connect: Promise<Buffer> }> {
  return new Promise((resolve, reject) => {
    let resolveGreeting!: (b: Buffer) => void;
    let resolveConnect!: (b: Buffer) => void;
    const greeting = new Promise<Buffer>((r) => { resolveGreeting = r; });
    const connect = new Promise<Buffer>((r) => { resolveConnect = r; });

    const server = createServer((socket: Socket) => {
      socket.once('data', (chunk) => {
        // Greeting: 05 01 00 (version 5, 1 method, no-auth)
        resolveGreeting(chunk.subarray(0, 3));
        socket.write(Buffer.from([0x05, 0x00]));
        socket.once('data', (connectChunk) => {
          resolveConnect(connectChunk);
          // Success response; the client will then try TLS and fail, but the
          // socket close is fine — assertions already captured the bytes.
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          setTimeout(() => socket.destroy(), 50);
        });
      });
      socket.on('error', () => { /* expected: TLS handshake failure after capture */ });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({ port: address.port, close: () => server.close(), greeting, connect });
      } else {
        reject(new Error('failed to bind test server'));
      }
    });
  });
}

describe('createProxyFetch', () => {
  it('sends the SOCKS5 greeting and CONNECT for the target host', async () => {
    const { port, close, greeting, connect } = await startSocksServer();
    try {
      const fetchImpl = createProxyFetch(`socks5h://127.0.0.1:${port}`);
      // The TLS handshake will fail against the raw socket; race the fetch
      // against a short timer so the test does not hang on socket teardown.
      const promise = fetchImpl('https://api.fish.audio/v1/tts', { method: 'POST' });
      await Promise.race([promise.catch(() => { /* expected */ }), new Promise((r) => setTimeout(r, 500))]);

      const greetingBytes = await greeting;
      expect([...greetingBytes]).toEqual([0x05, 0x01, 0x00]);

      const connectBytes = await connect;
      // VER CMD RSV ATYP(3=domain) LEN "api.fish.audio" PORT(443)
      expect(connectBytes[0]).toBe(0x05);
      expect(connectBytes[1]).toBe(0x01);
      expect(connectBytes[3]).toBe(0x03);
      const hostLen = connectBytes[4] ?? 0;
      expect(connectBytes.subarray(5, 5 + hostLen).toString('utf8')).toBe('api.fish.audio');
      expect(connectBytes.readUInt16BE(5 + hostLen)).toBe(443);
    } finally {
      close();
    }
  });

  it('rejects unsupported proxy protocols', () => {
    expect(() => createProxyFetch('https://127.0.0.1:8082')).toThrow(/unsupported proxy protocol/);
  });
});
