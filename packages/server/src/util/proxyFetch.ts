import { request as httpsRequest, type RequestOptions } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';

/**
 * Proxy-aware fetch for environments where outbound HTTPS is blocked and the
 * deployment provides a local SOCKS5/HTTP proxy (e.g. sing-box on 127.0.0.1).
 *
 * Node's native `fetch` intentionally ignores HTTPS_PROXY/HTTP_PROXY, so the
 * providers receive this implementation through the injectable `fetchImpl`
 * seam instead. Only `socks5h://` and `http://` proxies are supported; the
 * request body must be a string or Buffer (TTS/image payloads are).
 */

export interface ProxyFetchOptions {
  proxyUrl: string;
  /** Optional headers merged over the request's own headers. */
  headers?: Record<string, string>;
}

function parseProxyUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'socks5h:' && url.protocol !== 'socks5:' && url.protocol !== 'http:') {
    throw new Error(`unsupported proxy protocol: ${url.protocol}`);
  }
  return url;
}

/** Opens a SOCKS5 connection to the target host:port through the proxy. */
function socks5Connect(proxy: URL, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port || 1080) });
    const onError = (err: Error) => { socket.destroy(); reject(err); };
    socket.once('error', onError);
    const hasAuth = Boolean(proxy.username);
    socket.once('connect', () => {
      // Greeting: no auth (or user/pass when the proxy URL carries credentials).
      const greeting = Buffer.from([0x05, hasAuth ? 0x02 : 0x01, hasAuth ? 0x02 : 0x00]);
      socket.write(greeting);
    });
    let stage: 'greeting' | 'connect' = 'greeting';
    socket.once('data', function onData(chunk: Buffer) {
      if (stage === 'greeting') {
        stage = 'connect';
        const method = chunk[1];
        if (method === 0xff) { socket.destroy(); reject(new Error('socks5: no acceptable auth method')); return; }
        if (method === 0x02 && hasAuth) {
          const user = Buffer.from(proxy.username, 'utf8');
          const pass = Buffer.from(proxy.password ?? '', 'utf8');
          const auth = Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]);
          socket.write(auth);
          socket.once('data', (authResp) => {
            if (authResp[1] !== 0x00) { socket.destroy(); reject(new Error('socks5: auth failed')); return; }
            sendConnect();
          });
          return;
        }
        sendConnect();
        return;
      }
      // Connect response: VER REP RSV ATYP BND.ADDR BND.PORT
      if (chunk[1] !== 0x00) { socket.destroy(); reject(new Error(`socks5: connect failed code ${chunk[1]}`)); return; }
      socket.removeListener('data', onData);
      socket.once('error', () => { /* connection is owned by the caller */ });
      resolve(socket);
    });
    function sendConnect(): void {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]));
    }
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
export function createProxyFetch(proxyUrl: string): typeof fetch {
  const proxy = parseProxyUrl(proxyUrl);
  const useSocks = proxy.protocol === 'socks5h:' || proxy.protocol === 'socks5:';

  return async function proxyFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body == null ? undefined : Buffer.from(String(init?.body));
    const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const signal = init?.signal;

    const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
    if (signal?.aborted) throw abortError();

    // Normalize headers for the underlying request.
    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => { headerRecord[key] = value; });
    if (body && !headers.has('content-length')) headerRecord['content-length'] = String(body.length);

    const doRequest = (socket: Socket): Promise<Response> => new Promise((resolve, reject) => {
      const opts: RequestOptions = {
        method,
        host: url.hostname,
        port: targetPort,
        path: `${url.pathname}${url.search}`,
        headers: headerRecord,
        servername: url.hostname,
        createConnection: () => socket,
        rejectUnauthorized: true
      };
      const onAbort = () => { req.destroy(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const req = url.protocol === 'https:' ? httpsRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(toResponse(res.statusCode ?? 0, res.headers as Record<string, string | string[] | undefined>, Buffer.concat(chunks)));
        });
      }) : httpRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(toResponse(res.statusCode ?? 0, res.headers as Record<string, string | string[] | undefined>, Buffer.concat(chunks)));
        });
      });
      req.once('error', (err) => { signal?.removeEventListener('abort', onAbort); reject(err); });
      if (body) req.write(body);
      req.end();
    });

    if (useSocks) {
      const socket = await socks5Connect(proxy, url.hostname, targetPort);
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
