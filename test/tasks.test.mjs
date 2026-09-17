import {ProjectWorker} from '../src/projects.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeStore} from '../src/store.ts';
import {ReceiveService} from '../src/receive-service.mjs';
import {DesktopWorker} from '../src/desktop-worker.mjs';
import {SOURCE} from '../src/desktop-adapter.mjs';
import {TEST_TARGET as A,SWITCH_TARGET as B,ALLOWED_TASKS} from '../src/targets.mjs';
const event=(text,id,user='owner')=>({app_id:'cli_test',sender:{sender_type:'user',tenant_key:'t',sender_id:{open_id:user}},message:{message_id:id,chat_id:'c',chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}});
function setup(t){const s=new BridgeStore(':memory:');t.after(()=>s.close());s.bind('t','c','owner',A);const opts={appId:'cli_test',targetThreadId:A,mode:'desktop-test',getRuntime:()=>({desktop:'idle'})};const service=new ReceiveService(s,opts);for(const[id,title]of ALLOWED_TASKS)s.db.prepare('INSERT INTO task_catalog VALUES(?,?,?,?)').run(id,title,'idle',1000);return {s,service,opts};}
async function choose(service,s,id,messageId='use',now=1001){
 const client={close(){},call:async(name,args)=>name==='list_threads'?{threads:[...ALLOWED_TASKS].map(([id,title])=>({id,title,kind:'codex',hostId:'local',projectId:null}))}:{thread:{id:args.threadId,title:ALLOWED_TASKS.get(args.threadId),kind:'codex',hostId:'local',status:{type:'idle'}}}};
 const worker=new ProjectWorker(s,client);service.accept(event('/rc tasks','list-'+messageId),now);await worker.tick(now);const list=JSON.parse(s.db.prepare("SELECT items FROM project_lists WHERE kind='tasks'").get().items);const result=service.accept(event('/rc use '+(list.findIndex(x=>x.id===id)+1),messageId),now);await worker.tick(now);return result;
}
test('switch freezes queued targets and duplicate use cannot replay after service restart',async t=>{
 const {s,service,opts}=setup(t);service.accept(event('A original','a'),1001);await choose(service,s,B);service.accept(event('B original','b'),1002);await choose(service,s,A,'back');const restored=new ReceiveService(s,opts);assert.equal(restored.accept(event('/rc use 2','use'),1003).duplicate,true);assert.equal(restored.binding.target_id,A);assert.deepEqual(s.db.prepare("SELECT original_text,target_id FROM inbox WHERE delivery='queued' ORDER BY id").all().map(r=>[r.original_text,r.target_id]),[['A original',A],['B original',B]]);
});
test('unknown sender and missing list never change binding',async t=>{
 const {s,service}=setup(t);assert.equal(service.accept(event('/rc use 2','intruder','other'),1002).accepted,false);service.accept(event('/rc use 999','invalid'),1002);const worker=new ProjectWorker(s,{call:async()=>{throw Error('should not call')},close(){}});await worker.tick(1002);assert.equal(s.db.prepare('SELECT target_id FROM bindings').get().target_id,A);assert.match(s.pendingReplies().at(-1).body,/列表已过期/);
});
test('switch retains pause and control commands never become work',async t=>{const {s,service}=setup(t);service.accept(event('/rc pause','pause'),1001);await choose(service,s,B);assert.equal(s.db.prepare('SELECT paused FROM bindings').get().paused,1);service.accept(event('task','text'),1002);assert.equal(s.claim(B,true,[]),null);assert.equal(s.db.prepare("SELECT count(*) n FROM inbox WHERE delivery='queued'").get().n,1);});
test('old queued task runs after switch and replies retain original target',async t=>{
 const {s,service}=setup(t);service.accept(event('for A','a'),1001);await choose(service,s,B);service.accept(event('for B','b'),1002);const pages=new Map([A,B].map(id=>[id,{thread:{id,status:{type:'idle'}},turns:[]}]));const calls=[];const adapter=id=>({read:async()=>pages.get(id),send:async prompt=>{calls.push([id,prompt]);pages.set(id,{thread:{id,status:{type:'idle'}},turns:[{id:'turn-'+id,status:'completed',items:[{type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:{text:`<codex_delegation>\n  <source_thread_id>${SOURCE}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`,truncated:false}},{type:'agentMessage',phase:'final_answer',text:'reply '+prompt}]}]});}});const wa=new DesktopWorker(s,adapter(A),A),wb=new DesktopWorker(s,adapter(B),B);await wa.tick();await wb.tick();await wb.tick();await wa.tick();assert.deepEqual(calls,[[A,'for A'],[B,'for B']]);assert.deepEqual(s.pendingReplies().filter(r=>r.dedup_key.startsWith('outcome:')).map(r=>[r.target_id,r.body]),[[B,'reply for B'],[A,'reply for A']]);
});
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('binding and recent list survive database close and reopen',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'rc-switch-')),file=join(directory,'bridge.sqlite');let s=new BridgeStore(file);t.after(()=>{s.close();for(const name of ['bridge.sqlite','bridge.sqlite-wal','bridge.sqlite-shm']){try{unlinkSync(join(directory,name));}catch(e){if(e.code!=='ENOENT')throw e;}}rmdirSync(directory);});s.bind('t','c','owner',A);const opts={appId:'cli_test',targetThreadId:A,mode:'desktop-test'};let service=new ReceiveService(s,opts);service.accept(event('before restart','old'),1001);await choose(service,s,B);s.close();s=new BridgeStore(file);service=new ReceiveService(s,opts);assert.equal(service.binding.target_id,B);assert.equal(JSON.parse(s.db.prepare("SELECT items FROM project_lists WHERE kind='tasks'").get().items).length,2);service.accept(event('after restart','new'),1002);assert.deepEqual(s.db.prepare("SELECT target_id FROM inbox WHERE delivery='queued' ORDER BY id").all().map(r=>r.target_id),[A,B]);
});

