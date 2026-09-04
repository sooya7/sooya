import { request as httpRequest, type RequestOptions } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { Readable } from 'node:stream';

/**
 * Proxy-aware fetch for environments where outbound HTTPS is blocked and the
 * deployment provides a local SOCKS5/HTTP proxy (e.g. sing-box on 127.0.0.1).
 *
 * Node's native `fetch` intentionally ignores HTTPS_PROXY/HTTP_PROXY, so the
 * providers receive this implementation through the injectable `fetchImpl`
 * seam instead. Only `socks5h://` and `http://` proxies are supported.
 *
 * The https path is: SOCKS5 CONNECT → raw net.Socket → tls.connect() →
 * secureConnect → hand-written HTTP/1.1. The TLS socket is created explicitly
 * because handing a used socket to https.request's createConnection is
 * unreliable (it would emit plain HTTP to the 443 port and get a Cloudflare
 * 400).
 *
 * Three properties this implementation must preserve, each of which was
 * previously violated:
 *
 * 1. **Streaming.** The response resolves as soon as the headers are parsed and
 *    the body is delivered incrementally. The earlier version buffered the
 *    whole response before resolving, which silently turned every streaming
 *    chat completion (`accept: text/event-stream`) into a blocking call:
 *    incremental tokens disappeared and long generations hit
 *    CHAT_REQUEST_TIMEOUT_MS instead of streaming.
 * 2. **Bounded memory.** Bodies are capped at `maxResponseBytes`. Without a
 *    cap a hostile or malfunctioning upstream can drive the process to OOM.
 * 3. **No leaked sockets.** Every exit path destroys both the TLS socket and
 *    the underlying SOCKS socket. The earlier version never destroyed them and
 *    sent no `connection: close`, so a keep-alive origin left one TLS socket
 *    plus one SOCKS socket open per request until the peer gave up — a steady
 *    file-descriptor leak on the deployments that need a proxy at all.
 */

/** Default body ceiling; callers should pass MAX_REMOTE_FETCH_BYTES. */
const DEFAULT_MAX_RESPONSE_BYTES = 15 * 1024 * 1024;

/**
 * Independent ceiling for the response head, deliberately not tied to the body
 * limit. A response head is never legitimately large (this matches the 64 KiB
 * that Nginx and friends allow), whereas the body limit is a policy number that
 * a caller may set very low. Sharing one number would make a small body budget
 * reject perfectly ordinary headers.
 */
const MAX_HEAD_BYTES = 64 * 1024;

export interface ProxyFetchOptions {
  proxyUrl: string;
  /** TLS certificate verification (production true; tests may disable). */
  rejectUnauthorized?: boolean;
  /** Hard ceiling on a single response body. */
  maxResponseBytes?: number;
}

export class ProxyResponseTooLargeError extends Error {
  override name = 'ProxyResponseTooLargeError';
}

export class ProxyUnsupportedBodyError extends Error {
  override name = 'ProxyUnsupportedBodyError';
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
 * Normalises a fetch body to bytes.
 *
 * `Buffer.from(String(body))` — the previous implementation — round-trips
 * through utf8 and is therefore *lossy for binary*: any byte sequence that is
 * not valid utf8 comes out as U+FFFD, and a FormData/stream body degrades to
 * the literal string "[object FormData]". Binary payloads are passed through
 * untouched, and anything this transport genuinely cannot serialise fails
 * loudly instead of being silently corrupted.
 */
function encodeBody(body: RequestInit['body']): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new ProxyUnsupportedBodyError(
    `proxy transport cannot serialise a ${body.constructor?.name ?? typeof body} body; pass a string or bytes`
  );
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

interface ParsedHead {
  status: number;
  headers: Headers;
  /** Bytes of the body that arrived in the same read as the head. */
  rest: Buffer;
}

/** Parses a complete HTTP/1.1 head, or null when `\r\n\r\n` has not arrived yet. */
function parseHead(raw: Buffer): ParsedHead | null {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const headStr = raw.subarray(0, headerEnd).toString('utf8');
  const lines = headStr.split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    // append, not set: set-cookie and friends legitimately repeat.
    try { headers.append(name, value); } catch { /* skip a malformed header rather than fail the response */ }
  }
  return { status, headers, rest: raw.subarray(headerEnd + 4) };
}

type BodyFraming =
  | { kind: 'chunked' }
  | { kind: 'length'; total: number }
  | { kind: 'until-close' };

function framingFor(headers: Headers): BodyFraming {
  if (headers.get('transfer-encoding')?.toLowerCase().includes('chunked')) return { kind: 'chunked' };
  const declared = headers.get('content-length');
  if (declared !== null) {
    const total = Number(declared);
    if (Number.isFinite(total) && total >= 0) return { kind: 'length', total };
  }
  return { kind: 'until-close' };
}

/**
 * Incremental body decoder. Emits payload bytes as they arrive — this is what
 * makes SSE work through the proxy — and enforces the byte ceiling.
 */
function createBodyDecoder(
  framing: BodyFraming,
  maxBytes: number,
  sink: { push: (chunk: Buffer) => void; end: () => void; fail: (err: Error) => void }
): { write: (chunk: Buffer) => void; eof: () => void } {
  let emitted = 0;
  let finished = false;
  let buffer = Buffer.alloc(0);
  // chunked state
  let phase: 'size' | 'data' | 'crlf' = 'size';
  let remaining = 0;

  const emit = (chunk: Buffer): boolean => {
    if (chunk.length === 0) return true;
    emitted += chunk.length;
    if (emitted > maxBytes) {
      finished = true;
      sink.fail(new ProxyResponseTooLargeError(`response body exceeded ${maxBytes} bytes`));
      return false;
    }
    sink.push(chunk);
    return true;
  };

  const complete = (): void => {
    if (finished) return;
    finished = true;
    sink.end();
  };

  const pumpChunked = (): void => {
    for (;;) {
      if (finished) return;
      if (phase === 'size') {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd < 0) return;
        const sizeToken = buffer.subarray(0, lineEnd).toString('utf8').split(';')[0]?.trim() ?? '';
        const size = Number.parseInt(sizeToken, 16);
        if (!Number.isFinite(size) || size < 0) {
          finished = true;
          sink.fail(new Error(`malformed chunk size: ${sizeToken}`));
          return;
        }
        buffer = buffer.subarray(lineEnd + 2);
        if (size === 0) { complete(); return; } // trailers, if any, are ignored
        remaining = size;
        phase = 'data';
        continue;
      }
      if (phase === 'data') {
        if (buffer.length === 0) return;
        const take = Math.min(remaining, buffer.length);
        if (!emit(buffer.subarray(0, take))) return;
        buffer = buffer.subarray(take);
        remaining -= take;
        if (remaining > 0) return;
        phase = 'crlf';
        continue;
      }
      // phase === 'crlf': consume the CRLF that terminates the chunk data.
      if (buffer.length < 2) return;
      buffer = buffer.subarray(2);
      phase = 'size';
    }
  };

  return {
    write: (chunk: Buffer) => {
      if (finished) return;
      if (framing.kind === 'chunked') {
        buffer = Buffer.concat([buffer, chunk]);
        pumpChunked();
        return;
      }
      if (framing.kind === 'length') {
        const take = Math.min(chunk.length, framing.total - emitted);
        if (!emit(chunk.subarray(0, take))) return;
        if (emitted >= framing.total) complete();
        return;
      }
      emit(chunk);
    },
    eof: () => {
      if (finished) return;
      // A truncated fixed-length body is a real error; the other framings end here.
      if (framing.kind === 'length' && emitted < framing.total) {
        finished = true;
        sink.fail(new Error(`response body truncated: ${emitted}/${framing.total} bytes`));
        return;
      }
      complete();
    }
  };
}

/**
 * Builds a fetch implementation that routes through the given proxy.
 * `socks5h://` proxies resolve DNS remotely; `http://` proxies use CONNECT.
 */
export function createProxyFetch(proxyUrl: string, opts: { rejectUnauthorized?: boolean; maxResponseBytes?: number } = {}): typeof fetch {
  const proxy = parseProxyUrl(proxyUrl);
  const useSocks = proxy.protocol === 'socks5h:' || proxy.protocol === 'socks5:';
  const rejectUnauthorized = opts.rejectUnauthorized ?? true;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return async function proxyFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = encodeBody(init?.body);
    const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const signal = init?.signal ?? undefined;

    if (signal?.aborted) throw signalAbortReason(signal);

    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => { headerRecord[key] = value; });
    if (body && !headers.has('content-length')) headerRecord['content-length'] = String(body.length);
    // The socket is never pooled, so ask the origin to close when the body ends.
    // Without this an `until-close` framing on a keep-alive origin would hang.
    if (!headers.has('connection')) headerRecord.connection = 'close';

    const doRequest = (rawSocket: Socket): Promise<Response> => new Promise((resolve, reject) => {
      let settled = false;
      /** Body stream controller, set once the head is parsed. */
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let bodyClosed = false;
      let socketToClose: Socket | null = rawSocket;

      /** Single teardown path: every exit destroys the TLS socket *and* the SOCKS socket. */
      const teardown = (): void => {
        signal?.removeEventListener('abort', abortHandler);
        if (socketToClose && !socketToClose.destroyed) socketToClose.destroy();
        if (!rawSocket.destroyed) rawSocket.destroy();
      };
      const closeBody = (): void => {
        if (bodyClosed) return;
        bodyClosed = true;
        try { controller?.close(); } catch { /* already closed */ }
      };
      const errorBody = (err: Error): void => {
        if (bodyClosed) return;
        bodyClosed = true;
        try { controller?.error(err); } catch { /* already closed */ }
      };
      /** Fails the request before the head arrived, or the body stream after. */
      const fail = (err: unknown): void => {
        if (settled) { errorBody(err as Error); teardown(); return; }
        settled = true;
        teardown();
        reject(err);
      };
      const abortHandler = () => {
        // Close quietly. Passing an Error to destroy() emits an `error` event on
        // the raw SOCKS socket after its handshake listener has been removed.
        const reason = signalAbortReason(signal);
        if (settled) { errorBody(reason as Error); teardown(); return; }
        settled = true;
        teardown();
        reject(reason);
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      /** Wires a duplex byte source (TLS socket or IncomingMessage) to a streamed Response. */
      const consume = (source: {
        on: (event: 'data', cb: (chunk: Buffer) => void) => void;
        once: (event: 'end' | 'error' | 'close', cb: (err?: Error) => void) => void;
      }, head: { fromSocket: boolean }): void => {
        let pending = Buffer.alloc(0);
        let decoder: ReturnType<typeof createBodyDecoder> | null = null;

        const startBody = (parsed: ParsedHead): void => {
          const framing = framingFor(parsed.headers);
          const stream = new ReadableStream<Uint8Array>({
            start: (c) => { controller = c; },
            cancel: () => { closeBody(); teardown(); }
          });
          decoder = createBodyDecoder(framing, maxResponseBytes, {
            push: (chunk) => { try { controller?.enqueue(new Uint8Array(chunk)); } catch { /* consumer gone */ } },
            end: () => { closeBody(); teardown(); },
            fail: (err) => { errorBody(err); teardown(); }
          });
          settled = true;
          signal?.removeEventListener('abort', abortHandler);
          // Re-arm abort against the body stream now that the head has resolved.
          signal?.addEventListener('abort', abortHandler, { once: true });
          resolve(new Response(stream, { status: parsed.status, headers: parsed.headers }));
          decoder.write(parsed.rest);
        };

        source.on('data', (chunk) => {
          if (decoder) { decoder.write(chunk); return; }
          pending = Buffer.concat([pending, chunk]);
          if (pending.length > MAX_HEAD_BYTES) {
            fail(new ProxyResponseTooLargeError(`response head exceeded ${MAX_HEAD_BYTES} bytes`));
            return;
          }
          const parsed = head.fromSocket ? parseHead(pending) : null;
          if (parsed) startBody(parsed);
        });
        source.once('end', () => {
          if (decoder) { decoder.eof(); return; }
          fail(new Error('proxy connection ended before a complete response head'));
        });
        source.once('error', (err) => fail(err ?? new Error('proxy socket error')));
      };

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
        socketToClose = tlsSocket;
        // Register data/end listeners immediately — a fast origin may answer
        // before secureConnect's callback runs, and a listener registered
        // there would miss the response (hanging the request).
        consume(tlsSocket, { fromSocket: true });
        tlsSocket.once('secureConnect', () => {
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

      // Plain http through the tunnel: node's parser handles framing, but the
      // body is still streamed and capped rather than buffered wholesale.
      const requestOptions: RequestOptions = {
        method,
        host: url.hostname,
        port: targetPort,
        path: `${url.pathname}${url.search}`,
        headers: headerRecord,
        createConnection: () => rawSocket,
        agent: false
      };
      const req = httpRequest(requestOptions, (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v);
          else responseHeaders.append(key, value);
        }
        let emitted = 0;
        const stream = new ReadableStream<Uint8Array>({
          start: (c) => { controller = c; },
          cancel: () => { closeBody(); teardown(); }
        });
        res.on('data', (chunk: Buffer) => {
          emitted += chunk.length;
          if (emitted > maxResponseBytes) {
            errorBody(new ProxyResponseTooLargeError(`response body exceeded ${maxResponseBytes} bytes`));
            teardown();
            return;
          }
          try { controller?.enqueue(new Uint8Array(chunk)); } catch { /* consumer gone */ }
        });
        res.once('end', () => { closeBody(); teardown(); });
        res.once('error', (err) => { errorBody(err); teardown(); });
        settled = true;
        resolve(new Response(stream, { status: res.statusCode ?? 0, headers: responseHeaders }));
      });
      req.once('error', (err) => fail(err));
      if (body) req.write(body);
      req.end();
    });

    if (useSocks) {
      const socket = await socks5Handshake(proxy.hostname, Number(proxy.port || 1080), url.hostname, targetPort, proxy.username ? { username: proxy.username, password: proxy.password ?? '' } : undefined, signal);
      return doRequest(socket);
    }

    // HTTP proxy: CONNECT tunnel to the origin for both schemes (the tunnel is
    // opaque, so the inner request is written exactly as in the SOCKS case).
    return new Promise((resolve, reject) => {
      const connectReq = httpRequest({
        method: 'CONNECT',
        host: proxy.hostname,
        port: Number(proxy.port || 8080),
        path: `${url.hostname}:${targetPort}`,
        headers: { host: `${url.hostname}:${targetPort}` }
      });
      const onAbort = () => { connectReq.destroy(); reject(signalAbortReason(signal)); };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      connectReq.once('connect', (_res, socket) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(doRequest(socket));
      });
      connectReq.once('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
      connectReq.end();
    });
  };
}

/** Kept for callers that want the whole body with the cap enforced. */
export async function readCappedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(response.body as never)) {
    const buf = Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) throw new ProxyResponseTooLargeError(`response body exceeded ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
