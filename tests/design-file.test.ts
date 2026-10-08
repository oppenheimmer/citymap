import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designFile } from '../src/lib/design-file.ts';
import { DEFAULT_DESIGN } from '../src/lib/domain.ts';
import { parseUrl } from '../src/lib/url-state.ts';

test('saved settings export preserves Unicode, camera, palette and immutable identity without geometry', () => {
  const boundary = { key:'osm-relation-9007199254740993',name:'東京',kind:'city',osmType:'relation' as const,osmId:'9007199254740993',areaId:'9007202854740993',revision:'a'.repeat(64),manifestSha256:'b'.repeat(64) };
  const design = { ...DEFAULT_DESIGN,roadColor:'#123456',camera:{left:-1,bottom:-2,right:3,top:4},label:{...DEFAULT_DESIGN.label,text:'東京 & <Map>',x:0.2,y:0.7} };
  const file = JSON.parse(designFile({id:'1',name:'Saved 東京',boundary,design,savedAt:'2026-10-09T00:00:00.000Z'},'https://city.example','/'));
  assert.equal(file.format,'citymap-design'); assert.equal(file.version,1);
  assert.equal(file.boundary.osmId,boundary.osmId); assert.equal(file.boundary.revision,boundary.revision);
  assert.deepEqual(file.design,design); assert.equal(file.geometry,undefined);
  assert.deepEqual(parseUrl(new URL(file.link).search).design,design);
});
test('a corrupt saved boundary cannot be exported as a misleading restore link', () => {
  const record = {id:'1',name:'Bad',savedAt:'',boundary:{key:'bad',name:'Bad',kind:'city',areaId:'invalid'},design:DEFAULT_DESIGN};
  assert.throws(() => designFile(record,'https://city.example','/'),/invalid/);
});
