import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { providerProxy } from './support/provider-proxy.ts';

test('local proxy rejects other origins and tunnels without making an upstream request', async t => {
  const blocked: string[] = [];
  const proxy = providerProxy(['http://127.0.0.1:8082'], url => blocked.push(url));
  proxy.listen(0,'127.0.0.1'); await once(proxy,'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const port = (proxy.address() as AddressInfo).port;
  for (const target of ['http://example.invalid/data','http://127.0.0.1:8099/data','http://127.0.0.1:8082@evil.invalid/data']) {
    const status = await new Promise<number>((resolve,reject) => {
      request({ host:'127.0.0.1',port,path:target }, response => { response.resume(); resolve(response.statusCode!); }).on('error',reject).end();
    });
    assert.equal(status,403);
  }
  const status = await new Promise<number>((resolve,reject) => {
    request({ host:'127.0.0.1',port,method:'CONNECT',path:'example.invalid:443' }).on('connect',(response,socket) => { socket.destroy(); resolve(response.statusCode!); }).on('error',reject).end();
  });
  assert.equal(status,403); assert.equal(blocked.length,4);
});

test('closing a proxied response propagates cancellation to the actual upstream', async t => {
  let arrived!: () => void, closed!: () => void;
  const active = new Promise<void>(resolve => { arrived = resolve; });
  const cancelled = new Promise<void>(resolve => { closed = resolve; });
  const source = createServer((_req,response) => { arrived(); response.on('close',closed); });
  source.listen(0,'127.0.0.1'); await once(source,'listening');
  const origin = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const proxy = providerProxy([origin],()=>assert.fail('Unexpected denied origin'));
  proxy.listen(0,'127.0.0.1'); await once(proxy,'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); source.closeAllConnections(); source.close(); });
  const client = request({ host:'127.0.0.1',port:(proxy.address() as AddressInfo).port,path:`${origin}/held` });
  client.on('error',()=>{}); client.end(); await active; client.destroy(); await cancelled;
});

test('proxy configuration accepts only explicit loopback HTTP ports', () => {
  for (const origin of ['https://127.0.0.1:8082','http://example.invalid:8082','http://127.0.0.1','http://user:password@127.0.0.1:8082']) assert.throws(() => providerProxy([origin],()=>{}));
});
