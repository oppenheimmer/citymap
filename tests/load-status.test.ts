import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeLoad, formatBytes, STALL_SECONDS } from '../src/lib/load-status.ts';

const download = { stage: 'download' as const, message: 'Downloading live roads…' };

test('a known size gives a determinate bar with bytes, percentage and elapsed time', () => {
  const activity = describeLoad(download, { bytes: 512 * 1024, total: 2 * 1024 * 1024 }, 0, 9_000, 12_400);
  assert.equal(activity.text, 'Downloading live roads… · 512 KB of 2.0 MB (25%) · 12 s');
  assert.deepEqual([activity.value, activity.max, activity.warning], [512 * 1024, 2 * 1024 * 1024, undefined]);
});

test('unknown or exceeded sizes stay indeterminate and show bytes received', () => {
  for (const transfer of [{ bytes: 3 * 1024 * 1024 }, { bytes: 3 * 1024 * 1024, total: 1024 * 1024 }]) {
    const activity = describeLoad(download, transfer, 0, 0, 1_000);
    assert.equal(activity.max, undefined); assert.equal(activity.value, undefined);
    assert.match(activity.text, /3\.0 MB received · 1 s$/);
  }
  assert.equal(describeLoad(null, null, 0, 0, 0).text, 'Starting… · 0 s');
  assert.match(describeLoad({ stage: 'download', message: 'Loading cached road chunks…', completedChunks: 3, totalChunks: 10 }, { bytes: 0, total: 10 }, 0, 0, 0).text, /3 of 10 chunks/);
  assert.equal(formatBytes(1536), '2 KB'); assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('network stages warn after a silent interval; processing stages do not', () => {
  const idle = STALL_SECONDS * 1000;
  assert.equal(describeLoad(download, { bytes: 10 }, 0, 0, idle - 1).warning, undefined);
  assert.match(describeLoad(download, { bytes: 10 }, 0, 0, idle + 1000).warning!, /No data for 16 s/);
  assert.match(describeLoad({ stage: 'download', message: 'Waiting for the road service…' }, null, 0, 0, idle).warning!, /No response after 15 s/);
  assert.match(describeLoad({ stage: 'cache', message: 'Looking for a cached city dataset…' }, null, 0, 0, idle).warning!, /No response/);
  assert.equal(describeLoad({ stage: 'project', message: 'Indexing and projecting roads…' }, { bytes: 10 }, 0, 0, idle * 4).warning, undefined);
});
