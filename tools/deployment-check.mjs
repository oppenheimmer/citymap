import { readFile, readdir, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { loadEnv } from 'vite';
const { values } = parseArgs({ options: { offline: { type: 'boolean' } } });
const failures = [], checks = [];
function check(ok, name) { (ok ? checks : failures).push(name); }
check(process.versions.node.split('.')[0] === '24', 'Node 24 runtime');
const html = await readFile('dist/index.html', 'utf8');
check(html.includes('/assets/') && html.includes('id="app"'), 'Root Svelte artifact');
const files = await readdir('dist/assets');
const entry = html.match(/<script[^>]+src="\/assets\/([^"]+)"/)?.[1];
check(!!entry, 'Hashed entry script');
if (entry) {
  const source = await readFile(`dist/assets/${entry}`, 'utf8');
  check(gzipSync(source).length <= 100_000, 'Entry JavaScript under 100 KB gzip');
  check(!source.includes('Medium sample') && !source.includes('Large sample') && !source.includes('http://127.0.0.1:4173/data'), 'Test controls/provider absent');
  const env = { ...loadEnv('production', process.cwd(), ''), ...process.env };
  for (const key of ['R2_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'SEARCH_PROVIDER_API_KEY']) if (env[key]) check(!source.includes(env[key]), `${key} stays server-only`);
  if (!values.offline) {
    const provider = new URL(env.SEARCH_PROVIDER_URL || 'https://nominatim.openstreetmap.org/search');
    check(provider.protocol === 'https:', 'HTTPS production search provider');
    if (provider.hostname === 'nominatim.openstreetmap.org') {
      check(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_SEARCH_BUCKET'].every(key => !!env[key]), 'Shared private R2 search configuration');
      check(!env.R2_DATA_BUCKET || env.R2_DATA_BUCKET !== env.R2_SEARCH_BUCKET, 'Private search bucket distinct from public datasets');
    }
    check(!!env.APP_ORIGIN && new URL(env.APP_ORIGIN).protocol === 'https:', 'Production app origin');
    if (env.VITE_CITY_DATA_BASE_URL) check(new URL(env.VITE_CITY_DATA_BASE_URL).protocol === 'https:', 'HTTPS public R2 delivery origin');
  }
}
for (const name of ['roads.worker-', 'svg.worker-', 'SceneController-', 'exports-']) check(files.some(file => file.startsWith(name)), `${name} lazy artifact`);
const fixtures = await readdir('dist/fixtures');
check(fixtures.length === 1 && fixtures[0] === 'small.json', 'Only small sample ships');
check((await stat('dist/fixtures/small.json')).size < 100_000, 'Sample under 100 KB');
const config = JSON.parse(await readFile('vercel.json', 'utf8'));
check(config.outputDirectory === 'dist' && config.installCommand === 'npm ci', 'Vercel single-package build');
check(config.functions?.['api/search.ts']?.maxDuration === 30, 'Bounded Vercel search function');
console.log(JSON.stringify({ mode: values.offline ? 'artifact-only' : 'deployment-environment', passed: checks, failures }, null, 2));
if (failures.length) process.exitCode = 1;
