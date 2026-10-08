import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/** Restrict local browser traffic without interception that breaks Firefox fetch abortion. */
export function providerProxy(origins: string[], blocked: (target: string) => void) {
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Proxy destinations must be explicit loopback HTTP ports');
  }
  const allowed = new Set(origins.map(value => new URL(value).origin));
  const authorities = new Set(origins.map(value => new URL(value).host));
  function target(request: IncomingMessage): URL | undefined {
    try {
      const url = new URL(request.url || '');
      if (url.protocol === 'ws:') url.protocol = 'http:';
      if (!allowed.has(url.origin) || url.username || url.password) throw new Error('Denied origin');
      return url;
    } catch { blocked(request.url || 'invalid URL'); return; }
  }
  const server = createServer((incoming, outgoing) => {
    const url = target(incoming);
    if (!url) {
      outgoing.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      outgoing.end('<!doctype html><head><link rel="icon" href="data:,"></head><body>Local test proxy denied this origin</body>'); return;
    }
    const upstream = httpRequest(url, { method: incoming.method, headers: { ...incoming.headers, host: url.host } }, response => {
      response.on('error', () => outgoing.destroy());
      outgoing.writeHead(response.statusCode || 502, response.headers); response.pipe(outgoing);
    });
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on('aborted', () => upstream.destroy());
    incoming.on('error', () => { upstream.destroy(); outgoing.destroy(); });
    outgoing.on('close', () => { if (!outgoing.writableEnded) upstream.destroy(); });
    incoming.pipe(upstream);
  });
  function tunnel(incoming: IncomingMessage, socket: Duplex, head: Buffer, upgrade: boolean) {
    const url = upgrade ? target(incoming) : undefined;
    const authority = url?.host || incoming.url || '';
    if (upgrade ? !url : !authorities.has(authority)) {
      if (!upgrade) blocked(authority);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const [hostname, port] = authority.split(':');
    const upstream = connect(Number(port), hostname, () => {
      if (upgrade) upstream.write(`${incoming.method} ${url!.pathname}${url!.search} HTTP/1.1\r\n${Object.entries(incoming.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      else socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy()); upstream.on('close', () => socket.destroy());
  }
  server.on('connect', (req, socket, head) => tunnel(req, socket, head, false));
  server.on('upgrade', (req, socket, head) => tunnel(req, socket, head, true));
  return server;
}
