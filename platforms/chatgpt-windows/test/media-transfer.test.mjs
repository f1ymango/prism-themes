import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { transferVideo, MEDIA_CHUNK_BYTES } from '../src/media-transfer.mjs';
import { wallpaperExpression } from '../src/wallpaper.mjs';

const owner = 'transfer-owner-123';
const metadata = bytes => ({ name: 'sample.mp4', mime: 'video/mp4', kind: 'video', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
function rendererFixture() {
  const timers = new Map();
  const context = createContext({ atob, Uint8Array, crypto: { randomUUID }, location: { protocol: 'app:' },
    document: { getElementById: () => null, querySelectorAll: () => [], documentElement: { hasAttribute: () => false, getAttribute: () => null } },
    setTimeout: callback => { const id = randomUUID(); timers.set(id,callback); return id; }, clearTimeout: id => timers.delete(id),
  });
  runInContext('globalThis.top=globalThis',context);
  const run = (action, extra = {}) => runInContext(wallpaperExpression(action,{runId:owner,...extra}),context);
  const messages = [];
  let appliedBytes;
  return { context, timers, run, messages, get appliedBytes(){return appliedBytes;}, renderer: { evaluate: async expression => {
    messages.push(expression.length);
    if(expression.includes('})("apply",')) {
      appliedBytes=Buffer.concat(context.__prismWallpaperTransferV1.parts.map(part=>Buffer.from(part)));
      await run('transfer-abort',{transferId:context.__prismWallpaperTransferV1.id});
      return { visible:true };
    }
    return runInContext(expression,context);
  } } };
}
async function fileFixture(bytes) {
  const base=resolve('.prism-probe/media-transfer-tests');await mkdir(base,{recursive:true});
  const folder=await mkdtemp(join(base,'file-')),file=join(folder,'sample.mp4');await writeFile(file,bytes);return file;
}

test('video transfer sends bounded messages and reproduces bytes exactly',async()=>{
  const bytes=Buffer.alloc(MEDIA_CHUNK_BYTES*2+17,0x7b),file=await fileFixture(bytes),fixture=rendererFixture();
  const result=await transferVideo(fixture.renderer,file,metadata(bytes),{runId:owner});
  assert.equal(result.visible,true);assert.deepEqual(fixture.appliedBytes,bytes);
  assert.ok(Math.max(...fixture.messages)<800000);
  assert.equal(fixture.context.__prismWallpaperTransferV1,undefined);assert.equal(fixture.timers.size,0);
});

test('a changed file aborts before apply and releases pending chunks',async()=>{
  const bytes=Buffer.from('original media'),file=await fileFixture(Buffer.from('modified media')),fixture=rendererFixture();
  await assert.rejects(transferVideo(fixture.renderer,file,metadata(bytes),{runId:owner}),/changed/);
  assert.equal(fixture.appliedBytes,undefined);assert.equal(fixture.context.__prismWallpaperTransferV1,undefined);assert.equal(fixture.timers.size,0);
});

test('a cancelled transfer releases chunks without replacing the wallpaper',async()=>{
  const bytes=Buffer.alloc(MEDIA_CHUNK_BYTES*2),file=await fileFixture(bytes),fixture=rendererFixture();let checks=0;
  await assert.rejects(transferVideo(fixture.renderer,file,metadata(bytes),{runId:owner},{shouldAbort:()=>++checks>1}),/cancelled/);
  assert.equal(fixture.appliedBytes,undefined);assert.equal(fixture.context.__prismWallpaperTransferV1,undefined);assert.equal(fixture.timers.size,0);
});

test('transfer ownership, ordering, size bounds, cancellation and expiry are enforced',async()=>{
  const f=rendererFixture(),{transferId}=await f.run('transfer-start',{image:metadata(Buffer.alloc(2))});
  await assert.rejects(f.run('transfer-abort',{runId:'foreign-owner-123',transferId}),/different owner/);
  await assert.rejects(f.run('transfer-chunk',{transferId,index:1,dataBase64:'AA=='}),/out-of-order/);
  await assert.rejects(f.run('transfer-chunk',{transferId,index:0,dataBase64:'AAAA'}),/declared size/);
  await assert.rejects(f.run('apply',{image:{transferId}}),/incomplete/);
  await f.run('remove');assert.equal(f.context.__prismWallpaperTransferV1,undefined);assert.equal(f.timers.size,0);
  await f.run('transfer-start',{image:metadata(Buffer.alloc(1))});
  [...f.timers.values()][0]();assert.equal(f.context.__prismWallpaperTransferV1,undefined);assert.equal(f.timers.size,0);
});
