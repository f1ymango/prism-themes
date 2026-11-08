import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { approvedBuild, addApproval } from '../../src/native/build-approval.mjs';
import { saveJson } from '../../src/preferences.mjs';
const { values }=parseArgs({options:{cache:{type:'string'},candidate:{type:'string'},approval:{type:'string'}}});
let cache;
try{cache=JSON.parse(await readFile(values.cache,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(values.approval){
  const approval=JSON.parse(await readFile(values.approval,'utf8'));
  if(!approval.passed)throw new Error('Cannot cache a failed build probe');
  await saveJson(values.cache,addApproval(cache,approval));
}else{
  const candidate=JSON.parse(await readFile(values.candidate,'utf8'));
  console.log(JSON.stringify({approved:!!approvedBuild(cache,candidate)}));
}
