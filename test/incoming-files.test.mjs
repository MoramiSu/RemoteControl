import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeStore} from '../src/store.ts';
import {ReceiveService} from '../src/receive-service.mjs';
import {IncomingWorker,downloadIncoming,verifyIncomingFile,INCOMING_LIMIT} from '../src/incoming-files.mjs';
import {DesktopWorker} from '../src/desktop-worker.mjs';
import {SOURCE} from '../src/desktop-adapter.mjs';
function event(kind='file',content={file_key:'file_user',file_name:'report.txt'},id='m',user='owner'){return {app_id:'app',tenant_key:'tenant',sender:{sender_type:'user',tenant_key:'tenant',sender_id:{open_id:user}},message:{message_id:id,chat_id:'chat',chat_type:'p2p',message_type:kind,content:JSON.stringify(content)}};}
function setup(t){const cwd=mkdtempSync(join(tmpdir(),'rc-input-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));const store=new BridgeStore(':memory:');t.after(()=>store.close());store.bind('tenant','chat','owner','target');const service=new ReceiveService(store,{appId:'app',targetThreadId:'target',mode:'desktop-test'});return {cwd,store,service};}
const context=cwd=>async id=>({threadId:id,cwd,idle:true});
test('authorized attachment metadata is durable and deduplicated before any download',t=>{
  const {store,service}=setup(t);assert.equal(service.accept(event()).accepted,true);assert.equal(service.accept(event()).duplicate,true);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM incoming_files').get().n,1);
  assert.equal(service.accept(event('file',{file_key:'x',file_name:'a.pdf'},'other','stranger')).accepted,false);assert.throws(()=>service.accept(event('file',{file_key:'changed',file_name:'report.txt'})));assert.equal(store.get(1).target_id,'target');assert.equal(store.claim('target',true,[]),null);
});
test('text waits behind download; task switch cannot retarget the attachment',async t=>{
  const {cwd,store,service}=setup(t);service.accept(event());service.accept(event('text',{text:'分析这份文件'},'next'));store.db.prepare("UPDATE bindings SET target_id='other'").run();assert.equal(store.claim('target',true,[]),null);
  const worker=new IncomingWorker(store,{}, {instanceId:'test',contextFor:context(cwd),download:async()=>Buffer.from('content')});await worker.tick();const row=store.claim('target',true,[]);assert.equal(row.id,1);assert.match(row.wire_text,/report.txt/);assert.equal(readFileSync(store.db.prepare('SELECT local_path FROM incoming_files').get().local_path,'utf8'),'content');assert.equal(store.get(2).original_text,'分析这份文件');
});
test('download uses authenticated message resource identity and stops oversized streams',async()=>{
  let request;const client={im:{messageResource:{get:async r=>{request=r;return {headers:{},getReadableStream:()=>Readable.from([Buffer.from('abc')])}}}}};
  assert.equal((await downloadIncoming(client,{message_id:'m',file_key:'key',kind:'file'})).toString(),'abc');assert.deepEqual(request,{path:{message_id:'m',file_key:'key'},params:{type:'file'}});
  client.im.messageResource.get=async()=>({headers:{},getReadableStream:()=>Readable.from([Buffer.alloc(INCOMING_LIMIT),Buffer.from('x')])});await assert.rejects(downloadIncoming(client,{message_id:'m',file_key:'key',kind:'image'}),/too_large/);
});
test('pause holds download; hostile filenames are stored only under generated task inbox',async t=>{
  const {cwd,store,service}=setup(t);service.accept(event('file',{file_key:'key',file_name:'../../CON:report.txt'}));let calls=0;const worker=new IncomingWorker(store,{}, {instanceId:'test',contextFor:context(cwd),download:async()=>{calls++;return Buffer.from('safe')}});
  store.pause('tenant','chat',true);await worker.tick();assert.equal(calls,0);store.pause('tenant','chat',false);await worker.tick();const file=store.db.prepare('SELECT * FROM incoming_files').get();assert.equal(file.state,'ready');assert.ok(file.local_path.includes('.remotecontrol-inbox'));assert.match(file.name,/^file-/);assert.doesNotMatch(file.name,/[/\\:]/);
});
test('image bytes determine extension; non-images fail with a receipt and pause',async t=>{
  const {cwd,store,service}=setup(t);service.accept(event('image',{image_key:'img_key'}));const worker=new IncomingWorker(store,{}, {instanceId:'test',contextFor:context(cwd),download:async()=>Buffer.from('not an image')});await worker.tick();assert.equal(store.get(1).delivery,'delivery_failed');assert.equal(store.db.prepare('SELECT paused FROM bindings').get().paused,1);assert.ok(store.pendingReplies().some(r=>r.body.includes('无法识别图片格式')));
});
test('download retries are limited and expiry pauses subsequent task delivery',async t=>{
  const {cwd,store,service}=setup(t);service.accept(event());let now=1000,calls=0;const worker=new IncomingWorker(store,{}, {instanceId:'test',contextFor:context(cwd),now:()=>now,download:async()=>{calls++;throw Error('offline')}});await worker.tick();await worker.tick();assert.equal(calls,1);now+=300001;await worker.tick();assert.equal(store.get(1).delivery,'delivery_failed');assert.equal(store.db.prepare('SELECT paused FROM bindings').get().paused,1);
});
test('downloaded snapshot resumes without redownload and rejects user changes',async t=>{
  const {cwd,store,service}=setup(t);service.accept(event());let available=false,calls=0;const opts={instanceId:'test',contextFor:async id=>{if(!available)throw Error('offline');return {threadId:id,cwd,idle:true}},download:async()=>{calls++;return Buffer.from('snap')},now:()=>1000};await new IncomingWorker(store,{},opts).tick();assert.equal(store.db.prepare('SELECT state FROM incoming_files').get().state,'downloaded');
  available=true;await new IncomingWorker(store,{}, {...opts,now:()=>20000}).tick();const file=store.db.prepare('SELECT * FROM incoming_files').get();assert.equal(file.state,'ready');assert.equal(calls,1);writeFileSync(file.local_path,'changed');assert.throws(()=>verifyIncomingFile(store,store.get(1)),/file_changed/);
});
test('download error stream is consumed and exposes only safe permission diagnostics',async()=>{
  const body=Readable.from([Buffer.from(JSON.stringify({code:99991672,msg:'Missing im:message:readonly'}))]);
  const client={im:{messageResource:{get:async()=>{throw {response:{status:400,data:body}}}}}};
  await assert.rejects(downloadIncoming(client,{message_id:'m',file_key:'key',kind:'file'}),e=>e.reason==='download_failed'&&e.code===99991672&&e.requiredScopes.includes('im:message:readonly'));
  assert.equal(body.destroyed,true);
});
test('closing and reopening SQLite retains downloaded bytes and queued user text',async t=>{
  const cwd=mkdtempSync(join(tmpdir(),'rc-reopen-'));t.after(()=>{store.close();rmSync(cwd,{recursive:true,force:true});});const path=join(cwd,'state.sqlite');
  let store=new BridgeStore(path);store.bind('tenant','chat','owner','target');
  new ReceiveService(store,{appId:'app',targetThreadId:'target',mode:'desktop-test'}).accept(event());
  store.receive({messageId:'next',tenantId:'tenant',chatId:'chat',userId:'owner',text:'请分析附件'});
  await new IncomingWorker(store,{}, {instanceId:'test',now:()=>1000,contextFor:async()=>{throw Error('offline')},download:async()=>Buffer.from('persisted')}).tick();store.close();
  store=new BridgeStore(path);store.recover();let downloads=0;
  await new IncomingWorker(store,{}, {instanceId:'test',now:()=>20000,contextFor:context(cwd),download:async()=>{downloads++;throw Error('must not download')}}).tick();
  assert.equal(downloads,0);const file=store.db.prepare('SELECT * FROM incoming_files').get();assert.equal(file.state,'ready');assert.equal(readFileSync(file.local_path,'utf8'),'persisted');assert.equal(store.claim('target',true,[]).id,1);assert.equal(store.get(2).original_text,'请分析附件');
});
test('symlinked staging directory is rejected without writing outside task',async t=>{
  const {cwd,store,service}=setup(t);const outside=join(cwd,'outside');mkdirSync(outside);symlinkSync(outside,join(cwd,'.remotecontrol-inbox'),process.platform==='win32'?'junction':'dir');service.accept(event());await new IncomingWorker(store,{}, {instanceId:'test',contextFor:context(cwd),download:async()=>Buffer.from('content')}).tick();assert.equal(store.get(1).delivery,'delivery_failed');
});
test('delivery verifies the frozen attachment prompt rather than metadata text',async t=>{
  const {cwd,store,service}=setup(t);service.accept(event());await new IncomingWorker(store,{}, {instanceId:'test',contextFor:context(cwd),download:async()=>Buffer.from('content')}).tick();let sent;
  const adapter={read:async()=>({thread:{id:'target',status:{type:'idle'}},turns:sent?[{id:'new-turn',status:'inProgress',items:[{type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>${SOURCE}</source_thread_id>\n  <input>${sent}</input>\n</codex_delegation>`}}]}]:[]}),send:async text=>{sent=text}};
  await new DesktopWorker(store,adapter,'target').tick();assert.equal(store.get(1).delivery,'delivered');assert.equal(sent,store.get(1).wire_text);
});

