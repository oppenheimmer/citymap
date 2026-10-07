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
  async request(method: 'GET' | 'HEAD' | 'PUT', key: string, body?: Buffer, headers: Record<string, string> = {}, signal?: AbortSignal, limit = 64 * 1024 * 1024): Promise<R2Response> {
    if (!key || key.startsWith('/') || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid R2 object key');
    const url = `https://${this.config.accountId}.r2.cloudflarestorage.com/${this.config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const signed = await this.signer.sign(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
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
}

export interface JSONStore {
  read(key: string): Promise<{ value: unknown; etag: string } | undefined>;
  comparePut(key: string, value: unknown, etag?: string): Promise<boolean>;
}
export function r2Store(client: R2): JSONStore {
  return {
    async read(key) {
      const response = await client.request('GET', key, undefined, {}, AbortSignal.timeout(8000), 1024 * 1024);
      if (response.status === 404) return;
      if (response.status !== 200 || !response.headers.get('ETag')) throw new Error('Private search storage unavailable');
      return { value: JSON.parse(response.body.toString('utf8')), etag: response.headers.get('ETag')! };
    },
    async comparePut(key, value, etag) {
      const response = await client.request('PUT', key, Buffer.from(JSON.stringify(value)), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) }, AbortSignal.timeout(8000), 1024 * 1024);
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
