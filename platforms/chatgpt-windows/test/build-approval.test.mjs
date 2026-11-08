import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuild, approvedBuild, addApproval, BUILD_CONTRACT } from '../src/native/build-approval.mjs';
const build={package:'OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0',image:'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe',executableSha256:'a'.repeat(64),archiveSha256:'b'.repeat(64)};
test('approval requires the exact package, image, fingerprint and current renderer contract',()=>{
  const cache=addApproval(null,{...build,contract:BUILD_CONTRACT,passed:true,checks:{imageVisible:true,settingsChanged:true,restored:true,installedFilesUnchanged:true,listenerClosed:true}});
  assert.ok(approvedBuild(cache,build));
  assert.equal(approvedBuild(cache,{...build,archiveSha256:'c'.repeat(64)}),null);
  assert.equal(approvedBuild(cache,{...build,package:build.package.replace('4239','4240')}),null);
  assert.equal(approvedBuild({schema:1,builds:[{...cache.builds[0],contract:0}]},build),null);
});
test('invalid identities and incomplete probes cannot become approvals',()=>{
  assert.throws(()=>validateBuild({...build,package:'Other.App_1_x64__publisher'}));
  assert.throws(()=>addApproval(null,{...build,contract:BUILD_CONTRACT,checks:{imageVisible:true,restored:false}}));
});
