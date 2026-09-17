import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,utimesSync,linkSync,symlinkSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeStore} from '../src/store.ts';
import {ReplySender} from '../src/reply-sender.mjs';
import {localOutputLinks,snapshotArtifact,LIMITS} from '../src/artifacts.mjs';
import {mergeRolloutItems} from '../src/rollout-evidence.mjs';

function fixture(t){const root=mkdtempSync(join(tmpdir(),'rc-artifact-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const cwd=join(root,'task');mkdirSync(cwd);return {root,cwd};}
function setup(t,path=':memory:'){
  const store=new BridgeStore(path);t.after(()=>store.close());store.bind('tenant','chat','owner','target');const {id}=store.receive({messageId:'m',tenantId:'tenant',userId:'owner',chatId:'chat',text:'生成附件'});
  store.db.prepare("UPDATE outbox SET status='sent'").run();store.db.prepare('UPDATE inbox SET received_at=?').run(Date.now()-10000);store.claim('target',true,[]);store.markDelivery(id,'delivered','turn');return {store,id};
}
const options={appId:'app',instanceId:'artifacts-test',titleFor:()=> '任务 A'};
const imageClient=()=>({im:{image:{create:async()=>({image_key:'img_ok'})},file:{create:async()=>({file_key:'file_ok'})},message:{create:async()=>({code:0,data:{message_id:'om_ok'}})}}});
const link=path=>`[下载成果](<${path.replaceAll('\\','/')}>)`;
async function drain(sender,store){for(let i=0;i<30&&store.pendingReplies().length;i++)await sender.tick();}

test('only explicit local links are candidates; code, quotations, external URLs and source lines are excluded',()=>{
  const text='[报告](<D:/task/report.pdf>)\n![图](D:/task/a.png)\n[源码](D:/task/app.py:12)\n[网站](https://example.com/a.pdf)\n\n> [引用](D:/other.txt)\n\n```md\n[示例](D:/fake.pdf)\n```';
  assert.deepEqual(localOutputLinks(text).map(l=>l.path),['D:/task/report.pdf','D:/task/a.png']);
});
test('snapshot rejects escape, protected files, stale output, empty and oversized files',t=>{
  const {root,cwd}=fixture(t);const context={cwd,receivedAt:Date.now()-1000};writeFileSync(join(cwd,'report.txt'),'hello');
  assert.equal(snapshotArtifact({path:'report.txt'},context).bytes.toString(),'hello');
  writeFileSync(join(root,'outside.txt'),'outside');assert.throws(()=>snapshotArtifact({path:'../outside.txt'},context),/outside_task/);
  mkdirSync(join(cwd,'.private'));writeFileSync(join(cwd,'.private','secret.txt'),'secret');assert.throws(()=>snapshotArtifact({path:'.private/secret.txt'},context),/protected_path/);
  assert.throws(()=>snapshotArtifact({path:'report.txt:secret'},context),/invalid_path/);
  assert.throws(()=>snapshotArtifact({path:'\\\\host\\share\\report.txt'},context),/invalid_path/);
  assert.throws(()=>snapshotArtifact({path:'report.txt'},context,{...LIMITS,file:4}),/size_limit/);
  writeFileSync(join(cwd,'empty.txt'),'');assert.throws(()=>snapshotArtifact({path:'empty.txt'},context),/size_limit/);
  utimesSync(join(cwd,'report.txt'),new Date(0),new Date(0));
  assert.equal(snapshotArtifact({path:'report.txt'},context).bytes.toString(),'hello');
  assert.throws(()=>snapshotArtifact({path:'report.txt'},{...context,receivedAt:statSync(join(cwd,'report.txt')).birthtimeMs+1}),/not_current_output/);
});
test('hard links and directory junctions cannot escape the task boundary',t=>{
  const {root,cwd}=fixture(t);const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'a.txt'),'private');
  linkSync(join(outside,'a.txt'),join(cwd,'hard.txt'));assert.throws(()=>snapshotArtifact({path:'hard.txt'},{cwd,receivedAt:0}),/not_regular_file/);
  symlinkSync(outside,join(cwd,'jump'),process.platform==='win32'?'junction':'dir');assert.throws(()=>snapshotArtifact({path:'jump/a.txt'},{cwd,receivedAt:0}),/linked_path|outside_task/);
});
test('outcome snapshots image and document once, with task identity; source edits cannot alter payload',async t=>{
  const {cwd}=fixture(t),{store,id}=setup(t);writeFileSync(join(cwd,'figure.png'),'test-image');writeFileSync(join(cwd,'report.txt'),'report v1');
  const text=link(join(cwd,'figure.png'))+'\n'+link(join(cwd,'report.txt'));
  store.recordOutcome(id,'turn','completed',text,{threadId:'target',cwd});store.recordOutcome(id,'turn','completed',text,{threadId:'target',cwd});
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM reply_artifacts').get().n,2);writeFileSync(join(cwd,'report.txt'),'report v2');
  const uploads=[],messages=[];const client=imageClient();client.im.file.create=async r=>{uploads.push(r.data.file.toString());return {file_key:'file_ok'}};client.im.message.create=async r=>{messages.push(r.data);return {code:0,data:{message_id:'ok'}}};
  await drain(new ReplySender(store,client,options),store);assert.deepEqual(uploads,['report v1']);assert.ok(messages.some(m=>m.msg_type==='file'));assert.ok(messages.some(m=>m.content.includes('"tag":"img"')));assert.equal(store.pendingReplies().length,0);assert.ok(store.db.prepare('SELECT * FROM reply_artifacts').all().every(a=>a.state==='sent'&&a.bytes==null));
});
test('missing or mismatched task context emits an explicit notice without any file upload',async t=>{
  const {cwd}=fixture(t),{store,id}=setup(t);writeFileSync(join(cwd,'report.txt'),'x');store.recordOutcome(id,'turn','completed',link(join(cwd,'report.txt')),{threadId:'wrong',cwd});
  const client=imageClient();client.im.file.create=async()=>assert.fail('must not upload');const sent=[];client.im.message.create=async r=>{sent.push(r.data.content);return {code:0,data:{message_id:'ok'}}};await drain(new ReplySender(store,client,options),store);assert.match(sent.join(''),/无法核对任务目录/);
});
test('per-reply attachment count is bounded and overflow is reported once',t=>{
  const {cwd}=fixture(t),{store,id}=setup(t);const links=[];for(let i=0;i<12;i++){const path=join(cwd,`file${i}.txt`);writeFileSync(path,'x');links.push(link(path));}
  store.recordOutcome(id,'turn','completed',links.join('\n'),{threadId:'target',cwd});const artifacts=store.db.prepare('SELECT * FROM reply_artifacts').all();assert.equal(artifacts.length,9);assert.equal(artifacts.filter(a=>a.state==='captured').length,8);assert.equal(artifacts.at(-1).error,'count_limit');
});
test('message timeout after file upload reuses file key, bytes and UUID across database reopen',async t=>{
  const {root,cwd}=fixture(t),path=join(root,'db.sqlite');let store=new BridgeStore(path);store.bind('tenant','chat','owner','target');const {id}=store.receive({messageId:'m',tenantId:'tenant',userId:'owner',chatId:'chat',text:'file'});store.db.prepare('UPDATE inbox SET received_at=?').run(Date.now()-1000);store.db.prepare("UPDATE outbox SET status='sent'").run();store.claim('target',true,[]);store.markDelivery(id,'delivered','turn');writeFileSync(join(cwd,'a.txt'),'durable');store.recordOutcome(id,'turn','completed',link(join(cwd,'a.txt')),{threadId:'target',cwd});
  let now=1000,uploads=0,fail=true;const sent=[];const client=imageClient();client.im.file.create=async()=>{uploads++;return {file_key:'file_stable'}};client.im.message.create=async r=>{if(r.data.msg_type==='file'){sent.push(r.data);if(fail)throw Error('timeout');}return {code:0,data:{message_id:'ok'}}};
  try{const sender=new ReplySender(store,client,{...options,now:()=>now});await assert.rejects(drain(sender,store));}finally{store.close();}
  rmSync(join(cwd,'a.txt'));store=new BridgeStore(path);try{now+=16000;fail=false;await drain(new ReplySender(store,client,{...options,now:()=>now}),store);assert.equal(uploads,1);assert.deepEqual(sent[0],sent[1]);assert.equal(store.pendingReplies().length,0);}finally{store.close();}
});
test('upload retry is limited, preserves snapshot, and reports expiry',async t=>{
  const {cwd}=fixture(t),{store,id}=setup(t);writeFileSync(join(cwd,'a.txt'),'x');store.recordOutcome(id,'turn','completed',link(join(cwd,'a.txt')),{threadId:'target',cwd});let now=1000,uploads=0;const sent=[];const client=imageClient();client.im.file.create=async()=>{uploads++;throw Error('network')};client.im.message.create=async r=>{sent.push(r.data.content);return {code:0,data:{message_id:'ok'}}};const sender=new ReplySender(store,client,{...options,now:()=>now});await assert.rejects(drain(sender,store));await sender.tick();assert.equal(uploads,1);now+=300001;await drain(sender,store);assert.match(sent.join(''),/资源上传重试超时/);assert.equal(store.pendingReplies().length,0);
});
test('upload permission denial returns a specific notice and releases snapshot',async t=>{
  const {cwd}=fixture(t),{store,id}=setup(t);writeFileSync(join(cwd,'a.txt'),'x');store.recordOutcome(id,'turn','completed',link(join(cwd,'a.txt')),{threadId:'target',cwd});const client=imageClient();client.im.file.create=async()=>{throw {response:{data:{code:99991672}}}};await drain(new ReplySender(store,client,options),store);const a=store.db.prepare('SELECT * FROM reply_artifacts').get();assert.equal(a.error,'upload_permission');assert.equal(a.bytes,null);assert.equal(store.pendingReplies().length,0);
});
test('only identity-checked rollout supplies per-turn artifact workspace',()=>{
  const page={thread:{id:'target'},turns:[{id:'turn',items:[]}]};const rows=[{type:'session_meta',payload:{id:'target',cwd:'D:/initial'}},{type:'turn_context',payload:{turn_id:'turn',cwd:'D:/task'}}].map(JSON.stringify).join('\n');assert.deepEqual(mergeRolloutItems(page,rows).artifactContexts.turn,{threadId:'target',cwd:'D:/task'});
});
