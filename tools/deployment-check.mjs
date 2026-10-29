import { readFile, readdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { loadEnv } from 'vite';
import { BUNDLED_CITIES } from '../src/lib/bundled-cities.ts';
import { backupProvider } from '../src/lib/live/providers.ts';
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
  check(!source.includes('Small sample') && !source.includes('Large sample') && !source.includes('http://127.0.0.1:4173/data') && !source.includes('https://backup.citymap.test/api/interpreter'), 'Test sample controls/provider absent');
  const env = { ...loadEnv('production', process.cwd(), ''), ...process.env };
  const scripts = (await Promise.all(files.filter(file => file.endsWith('.js')).map(file => readFile(`dist/assets/${file}`, 'utf8')))).join('\n');
  for (const key of ['R2_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'SEARCH_PROVIDER_API_KEY', 'R2_CACHE_ACCESS_KEY_ID', 'R2_CACHE_SECRET_ACCESS_KEY', 'CACHE_ADMIN_TOKEN']) if (env[key]) check(!scripts.includes(env[key]), `${key} stays server-only`);
  if (['R2_CACHE_ACCESS_KEY_ID', 'R2_CACHE_SECRET_ACCESS_KEY', 'CACHE_ADMIN_TOKEN'].some(key => !!env[key])) {
    check(['R2_ACCOUNT_ID', 'R2_DATA_BUCKET', 'R2_CACHE_ACCESS_KEY_ID', 'R2_CACHE_SECRET_ACCESS_KEY', 'APP_ORIGIN'].every(key => !!env[key]) && (env.CACHE_ADMIN_TOKEN || '').length >= 32, 'Complete optional R2 administration configuration');
    check(env.R2_DATA_BUCKET !== env.R2_SEARCH_BUCKET, 'R2 administration cannot use the search bucket');
    try { check(new URL(env.APP_ORIGIN).origin === env.APP_ORIGIN, 'R2 administration uses an exact app origin'); } catch { check(false, 'R2 administration uses an exact app origin'); }
  }
  check(['', '0', '1'].includes(env.VITE_LIVE_VIEWPORT || ''), 'Live viewport flag is unset, 1, or explicit rollback 0');
  check(!env.VITE_OVERPASS_CONCURRENCY || /^[1-4]$/.test(env.VITE_OVERPASS_CONCURRENCY), 'Live road concurrency is 1–4');
  try { backupProvider(env.VITE_OVERPASS_URL || 'https://overpass-api.de/api/interpreter', env.VITE_OVERPASS_FALLBACK_URL); check(true, 'Optional road backup is valid and independent'); }
  catch { check(false, 'Optional road backup is valid and independent'); }
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
for (const name of ['roads.worker-', 'svg.worker-', 'cells.worker-', 'viewport-', 'SceneController-', 'exports-']) check(files.some(file => file.startsWith(name)), `${name} lazy artifact`);
check(!(await readdir('dist')).includes('fixtures'), 'No sample fixtures ship');
// Map typefaces ship as hashed same-origin assets, with their Open Font Licenses.
check(['cmu-serif-regular-', 'cmu-serif-bold-italic-', 'fira-code-latin-400-'].every(name => files.some(file => file.startsWith(name) && file.endsWith('.woff2'))), 'Map typefaces ship');
for (const license of ['CMU-Serif-OFL.txt', 'Fira-Code-OFL.txt']) check(await readFile(`dist/fonts/${license}`, 'utf8').then(text => text.includes('SIL OPEN FONT LICENSE'), () => false), `${license} ships`);
for (const key of BUNDLED_CITIES) check(await readFile(`dist/data/v2/cities/${key}/latest.json`).then(() => true, () => false), `Bundled ${key} ships`);
const config = JSON.parse(await readFile('vercel.json', 'utf8'));
check(config.outputDirectory === 'dist' && config.installCommand === 'npm ci', 'Vercel single-package build');
check(config.functions?.['api/search.ts']?.maxDuration === 30, 'Bounded Vercel search function');
check(config.functions?.['api/cache.ts']?.maxDuration === 30, 'Bounded Vercel cache function');
// Vercel compiles the function with the nearest tsconfig; without rewriting, its `.ts` imports fail at runtime.
check(JSON.parse(await readFile('api/tsconfig.json', 'utf8')).compilerOptions?.rewriteRelativeImportExtensions === true, 'Search function imports compile to .js');
check(config.headers.some(rule => rule.source.endsWith('/latest.json')) && config.headers.some(rule => rule.source.startsWith('/data/') && rule.headers.some(header => header.value.includes('immutable'))), 'Bundled data cache headers');
console.log(JSON.stringify({ mode: values.offline ? 'artifact-only' : 'deployment-environment', passed: checks, failures }, null, 2));
if (failures.length) process.exitCode = 1;
