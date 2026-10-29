import { AwsClient } from 'aws4fetch';
import { request as httpsRequest } from 'node:https';

export interface R2Config { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }
export interface R2Response { status: number; headers: Headers; body: Buffer }
export function r2Config(env: NodeJS.ProcessEnv, bucket: string): R2Config | undefined {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !bucket) return;
  if (!/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid R2 account or bucket configuration');
  return { accountId: env.R2_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, bucket };
}

export class R2 {
  private config: R2Config;
  private signer: AwsClient;
  constructor(config: R2Config) {
    this.config = config;
    this.signer = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: 'auto', service: 's3', retries: 0 });
  }
  async sign(method: 'GET' | 'HEAD' | 'PUT' | 'DELETE', key: string, body?: Buffer, headers: Record<string, string> = {}, query?: URLSearchParams): Promise<Request> {
    if ((!key && !(method === 'GET' && query?.get('list-type') === '2')) || key.startsWith('/') || key.includes('\\') || key && key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid R2 object key');
    const url = new URL(`https://${this.config.accountId}.r2.cloudflarestorage.com/${this.config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
    if (query) url.search = query.toString();
    return this.signer.sign(url.href, { method, headers: { ...headers, ...(body ? { 'Content-Length': String(body.byteLength) } : {}) }, body: body ? new Uint8Array(body) : undefined });
  }
  async request(method: 'GET' | 'HEAD' | 'PUT' | 'DELETE', key: string, body?: Buffer, headers: Record<string, string> = {}, signal?: AbortSignal, limit = 64 * 1024 * 1024, query?: URLSearchParams): Promise<R2Response> {
    const signed = await this.sign(method, key, body, headers, query);
    const timeout = AbortSignal.timeout(120_000);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return new Promise((resolve, reject) => {
      const req = httpsRequest(signed.url, { method, headers: Object.fromEntries(signed.headers.entries()), signal: abort }, response => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) response.destroy(new Error('R2 response exceeds byte limit')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          // Node HTTPS keeps stored gzip bytes intact for publication verification.
          resolve({ status: response.statusCode || 0, headers, body: Buffer.concat(chunks) });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
  async list(prefix: string, limit = 1000, cursor?: string, signal?: AbortSignal): Promise<R2Listing> {
    const query = new URLSearchParams({ 'list-type': '2', 'encoding-type': 'url', prefix, 'max-keys': String(limit) });
    if (cursor) query.set('continuation-token', cursor);
    const response = await this.request('GET', '', undefined, {}, signal, 2 * 1024 * 1024, query);
    if (response.status !== 200) throw new Error('R2 listing failed');
    return parseR2Listing(response.body.toString('utf8'), prefix);
  }
}

export interface R2Object { key: string; bytes: number; modified: string }
export interface R2Listing { objects: R2Object[]; cursor?: string }
/** ListObjectsV2 returns a small, fixed XML shape. Keys are requested URL-encoded. */
export function parseR2Listing(xml: string, prefix: string): R2Listing {
  if (xml.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<ListBucketResult[\s>]/.test(xml) || !xml.includes('</ListBucketResult>')) throw new Error('Invalid R2 listing');
  const field = (text: string, name: string) => {
    const matches = [...text.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
    if (matches.length !== 1) throw new Error('Invalid R2 listing field');
    return matches[0][1].replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity]!));
  };
  if (field(xml, 'EncodingType') !== 'url') throw new Error('R2 listing must encode keys');
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(match => {
    const key = decodeURIComponent(field(match[1], 'Key')), bytes = Number(field(match[1], 'Size')), modified = field(match[1], 'LastModified');
    if (!key.startsWith(prefix) || !Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(Date.parse(modified))) throw new Error('Invalid R2 object metadata');
    return { key, bytes, modified };
  });
  if ((xml.match(/<Contents>/g) || []).length !== objects.length || (xml.match(/<\/Contents>/g) || []).length !== objects.length) throw new Error('Incomplete R2 listing');
  const truncated = field(xml, 'IsTruncated');
  if (!['true', 'false'].includes(truncated) || objects.length > 1000 || new Set(objects.map(object => object.key)).size !== objects.length) throw new Error('Invalid R2 listing totals');
  const cursor = truncated === 'true' ? field(xml, 'NextContinuationToken') : undefined;
  if (truncated === 'true' && (!cursor || !objects.length)) throw new Error('Invalid R2 continuation');
  return { objects, cursor };
}

export interface JSONStore {
  read(key: string, signal?: AbortSignal): Promise<{ value: unknown; etag: string } | undefined>;
  comparePut(key: string, value: unknown, etag?: string, signal?: AbortSignal): Promise<boolean>;
}
export function r2Store(client: R2): JSONStore {
  return {
    async read(key, signal) {
      const response = await client.request('GET', key, undefined, {}, signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), 1024 * 1024);
      if (response.status === 404) return;
      if (response.status !== 200 || !response.headers.get('ETag')) throw new Error('Private search storage unavailable');
      return { value: JSON.parse(response.body.toString('utf8')), etag: response.headers.get('ETag')! };
    },
    async comparePut(key, value, etag, signal) {
      const response = await client.request('PUT', key, Buffer.from(JSON.stringify(value)), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) }, signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), 1024 * 1024);
      if ([409, 412].includes(response.status)) return false;
      if (![200, 201].includes(response.status)) throw new Error('Private search storage unavailable');
      return true;
    },
  };
}

export function memoryStore(): JSONStore {
  const values = new Map<string, { value: unknown; etag: string }>();
  let version = 0;
  return {
    async read(key) { const value = values.get(key); return value ? structuredClone(value) : undefined; },
    async comparePut(key, value, etag) {
      if (values.get(key)?.etag !== etag) return false;
      if (values.size > 512 && !key.startsWith('locks/')) values.delete([...values.keys()].find(key => !key.startsWith('locks/')) || '');
      values.set(key, { value: structuredClone(value), etag: `"${++version}"` }); return true;
    },
  };
}
