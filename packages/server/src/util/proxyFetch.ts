import { request as httpRequest, type RequestOptions } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';

/**
 * Proxy-aware fetch for environments where outbound HTTPS is blocked and the
 * deployment provides a local SOCKS5/HTTP proxy (e.g. sing-box on 127.0.0.1).
 *
 * Node's native `fetch` intentionally ignores HTTPS_PROXY/HTTP_PROXY, so the
 * providers receive this implementation through the injectable `fetchImpl`
 * seam instead. Only `socks5h://` and `http://` proxies are supported; the
 * request body must be a string or Buffer (TTS/image payloads are).
 *
 * The https path is: SOCKS5 CONNECT → raw net.Socket → tls.connect() →
 * secureConnect → http.request. The TLS socket is created explicitly because
 * handing a used socket to https.request's createConnection is unreliable
 * (it would emit plain HTTP to the 443 port and get a Cloudflare 400).
 */

export interface ProxyFetchOptions {
  proxyUrl: string;
  /** TLS certificate verification (production true; tests may disable). */
  rejectUnauthorized?: boolean;
}

function signalAbortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function parseProxyUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'socks5h:' && url.protocol !== 'socks5:' && url.protocol !== 'http:') {
    throw new Error(`unsupported proxy protocol: ${url.protocol}`);
  }
  return url;
}

/**
 * Performs the SOCKS5 handshake against `proxyHost:proxyPort` and returns the
 * raw connected socket to `host:port` once the CONNECT reply is confirmed.
 *
 * Replies are parsed from an accumulating buffer: a single `data` event may
 * carry several replies (or one reply may arrive split across events), so the
 * state machine never assumes one event per reply.
 */
export function socks5Handshake(
  proxyHost: string,
  proxyPort: number,
  host: string,
  port: number,
  credentials?: { username: string; password: string },
  signal?: AbortSignal
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxyHost, port: proxyPort });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onError = (err: Error) => fail(err);
    const onAbort = () => fail(signalAbortReason(signal));
    if (signal?.aborted) {
      fail(signalAbortReason(signal));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const stage = { value: 'greeting' as 'greeting' | 'auth' | 'connect' };

    const sendConnect = () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf
      ]));
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage.value === 'greeting') {
        // Greeting reply: VER(1) METHOD(1)
        if (buffer.length < 2) return;
        const method = buffer[1];
        buffer = buffer.subarray(2);
        if (method === 0xff) { fail(new Error('socks5: no acceptable auth method')); return; }
        if (method === 0x02 && credentials) {
          stage.value = 'auth';
          const user = Buffer.from(credentials.username, 'utf8');
          const pass = Buffer.from(credentials.password, 'utf8');
          socket.write(Buffer.concat([
            Buffer.from([0x01, user.length]), user,
            Buffer.from([pass.length]), pass
          ]));
          return;
        }
        if (method === 0x02) { fail(new Error('socks5: server requires auth but none was provided')); return; }
        stage.value = 'connect';
        sendConnect();
        return;
      }

      if (stage.value === 'auth') {
        // Auth reply: VER(1) STATUS(1)
        if (buffer.length < 2) return;
        const status = buffer[1];
        buffer = buffer.subarray(2);
        if (status !== 0x00) { fail(new Error('socks5: auth failed')); return; }
        stage.value = 'connect';
        sendConnect();
        return;
      }

      // Connect reply: VER(1) REP(1) RSV(1) ATYP(1) BND.ADDR BND.PORT
      if (buffer.length < 4) return;
      if (buffer[1] !== 0x00) { fail(new Error(`socks5: connect failed code ${buffer[1]}`)); return; }
      const atyp = buffer[3];
      let bindLen: number;
      if (atyp === 0x01) bindLen = 4;
      else if (atyp === 0x04) bindLen = 16;
      else if (atyp === 0x03) {
        if (buffer.length < 5) return;
        bindLen = buffer[4] ?? 0;
      } else { fail(new Error(`socks5: unsupported address type ${atyp}`)); return; }
      const total = 4 + (atyp === 0x03 ? 1 + bindLen : bindLen) + 2;
      if (buffer.length < total) return;
      buffer = buffer.subarray(total);
      settled = true;
      cleanup();
      socket.resume();
      resolve(socket);
    };

    socket.once('error', onError);
    socket.on('data', onData);
    socket.once('connect', () => {
      const hasAuth = Boolean(credentials?.username);
      socket.write(Buffer.from([0x05, hasAuth ? 0x02 : 0x01, hasAuth ? 0x02 : 0x00]));
    });
  });
}

/** fetch-compatible Response shim for the proxy path. */
function toResponse(status: number, headers: Record<string, string | string[] | undefined>, body: Buffer): Response {
  const headersInit = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headersInit.append(key, v);
    else headersInit.set(key, value);
  }
  return new Response(body, { status, headers: headersInit });
}

/**
 * Builds a fetch implementation that routes through the given proxy.
 * `socks5h://` proxies resolve DNS remotely; `http://` proxies use CONNECT.
 */
export function createProxyFetch(proxyUrl: string, opts: { rejectUnauthorized?: boolean } = {}): typeof fetch {
  const proxy = parseProxyUrl(proxyUrl);
  const useSocks = proxy.protocol === 'socks5h:' || proxy.protocol === 'socks5:';
  const rejectUnauthorized = opts.rejectUnauthorized ?? true;

  return async function proxyFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body == null ? undefined : Buffer.from(String(init?.body));
    const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const signal = init?.signal ?? undefined;

    if (signal?.aborted) throw signalAbortReason(signal);

    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => { headerRecord[key] = value; });
    if (body && !headers.has('content-length')) headerRecord['content-length'] = String(body.length);

    const doRequest = (rawSocket: Socket): Promise<Response> => new Promise((resolve, reject) => {
      const abortHandler = () => {
        // Close quietly. Passing an Error to destroy() emits an `error` event on
        // the raw SOCKS socket after its handshake listener has been removed.
        rawSocket.destroy();
        reject(signalAbortReason(signal));
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      if (url.protocol === 'https:') {
        // The correct chain: raw proxied socket → explicit TLS upgrade.
        // SNI is only sent for DNS names — RFC 6066 forbids IP literals in
        // servername, and Node ignores it with a deprecation warning, which
        // leaves the handshake without SNI and can break IP-based origins.
        const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(':');
        const tlsSocket = tlsConnect({
          socket: rawSocket,
          ...(isIp ? {} : { servername: url.hostname }),
          rejectUnauthorized
        });
        // Register data/end listeners immediately — a fast origin may answer
        // before secureConnect's callback runs, and a listener registered
        // there would miss the response (hanging the request).
        const chunks: Buffer[] = [];
        let started = false;
        let done = false;

        /** Decodes a chunked body, returning null until the final chunk. */
        const decodeChunked = (body: Buffer): Buffer | null => {
          const out: Buffer[] = [];
          let pos = 0;
          while (true) {
            const lineEnd = body.indexOf('\r\n', pos);
            if (lineEnd < 0) return null; // size line incomplete
            const sizeLine = body.subarray(pos, lineEnd).toString('utf8').trim();
            const size = Number.parseInt(sizeLine.split(';')[0] ?? '', 16);
            if (Number.isNaN(size)) return null;
            pos = lineEnd + 2;
            if (size === 0) {
              // Final chunk: trailing CRLF (or trailers) may follow.
              return Buffer.concat(out);
            }
            if (body.length < pos + size + 2) return null; // chunk incomplete
            out.push(body.subarray(pos, pos + size));
            pos += size + 2;
          }
        };

        const maybeFinish = () => {
          if (done || !started) return;
          const raw = Buffer.concat(chunks);
          const headerEnd = raw.indexOf('\r\n\r\n');
          if (headerEnd < 0) return; // header not complete yet
          const headStr = raw.subarray(0, headerEnd).toString('utf8');
          const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(headStr);
          const bodyStart = headerEnd + 4;
          const headers: Record<string, string> = {};
          for (const line of headStr.split('\r\n').slice(1)) {
            const idx = line.indexOf(':');
            if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          }
          const body = raw.subarray(bodyStart);
          if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
            const decoded = decodeChunked(body);
            if (decoded === null) return; // not all chunks arrived yet
            done = true;
            signal?.removeEventListener('abort', abortHandler);
            resolve(toResponse(statusMatch ? Number(statusMatch[1]) : 0, headers, decoded));
            return;
          }
          const cl = headers['content-length'];
          const contentLength = cl ? Number(cl) : null;
          if (contentLength !== null && !Number.isNaN(contentLength)) {
            // Fixed-length body: resolve once the declared bytes are buffered
            // (the origin may keep the connection alive, so no `end` comes).
            if (body.length < contentLength) return;
            done = true;
            signal?.removeEventListener('abort', abortHandler);
            resolve(toResponse(statusMatch ? Number(statusMatch[1]) : 0, headers, body.subarray(0, contentLength)));
            return;
          }
          // No content-length and no chunked: wait for the connection to close.
          done = true;
          signal?.removeEventListener('abort', abortHandler);
          resolve(toResponse(statusMatch ? Number(statusMatch[1]) : 0, headers, body));
        };
        tlsSocket.on('data', (c) => {
          if (!started) return;
          chunks.push(Buffer.from(c));
          maybeFinish();
        });
        tlsSocket.once('end', () => maybeFinish());
        tlsSocket.once('error', (err) => {
          signal?.removeEventListener('abort', abortHandler);
          reject(err);
        });
        tlsSocket.once('secureConnect', () => {
          started = true;
          // After TLS the socket is a plain duplex stream; write the HTTP
          // request directly. Reusing http.request's createConnection with an
          // already-secured socket has proved unreliable (hang-ups).
          const path = `${url.pathname}${url.search}`;
          const lines = [`${method} ${path} HTTP/1.1`, `host: ${url.hostname}${targetPort === 443 ? '' : `:${targetPort}`}`];
          for (const [key, value] of Object.entries(headerRecord)) lines.push(`${key}: ${value}`);
          const head = `${lines.join('\r\n')}\r\n\r\n`;
          tlsSocket.write(Buffer.concat([Buffer.from(head), body ?? Buffer.alloc(0)]));
        });
        return;
      }

      const opts: RequestOptions = {
        method,
        host: url.hostname,
        port: targetPort,
        path: `${url.pathname}${url.search}`,
        headers: headerRecord,
        createConnection: () => rawSocket,
        agent: false
      };
      const req = httpRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          signal?.removeEventListener('abort', abortHandler);
          resolve(toResponse(res.statusCode ?? 0, res.headers as Record<string, string | string[] | undefined>, Buffer.concat(chunks)));
        });
      });
      req.once('error', (err) => { signal?.removeEventListener('abort', abortHandler); reject(err); });
      if (body) req.write(body);
      req.end();
    });

    if (useSocks) {
      const socket = await socks5Handshake(proxy.hostname, Number(proxy.port || 1080), url.hostname, targetPort, proxy.username ? { username: proxy.username, password: proxy.password ?? '' } : undefined, signal);
      return doRequest(socket);
    }

    // HTTP proxy: CONNECT tunnel for https, plain absolute-URI GET for http.
    return new Promise((resolve, reject) => {
      const connectReq = httpRequest({
        method: 'CONNECT',
        host: proxy.hostname,
        port: Number(proxy.port || 8080),
        path: `${url.hostname}:${targetPort}`,
        headers: { host: `${url.hostname}:${targetPort}` }
      });
      connectReq.once('connect', (_res, socket) => {
        connectReq.destroy();
        resolve(doRequest(socket));
      });
      connectReq.once('error', reject);
      connectReq.end();
    });
  };
}
