import test from 'node:test';import assert from 'node:assert/strict';
import {classify} from '../src/feishu-events.mjs';
import {globalSelectionPending} from '../src/projects.mjs';
import {BridgeStore} from '../src/store.ts';import {ReceiveService} from '../src/receive-service.mjs';import {ProjectWorker,selectedProject} from '../src/projects.mjs';import {allowedTasks,TEST_TARGET} from '../src/targets.mjs';import {CreationAdapter} from '../src/creation-adapter.mjs';import {CreationWorker} from '../src/creation-worker.mjs';
const p={projectId:'p',projectKind:'local',hostId:'local',label:'项目',path:'D:\\example',isGitRepository:true};
const task={id:'11111111-2222-4333-8444-555555555555',title:'项目任务',kind:'codex',hostId:'local',projectId:'p',status:{type:'idle'}};
function setup(t){const store=new BridgeStore(':memory:');t.after(()=>store.close());store.bind('t','c','u',TEST_TARGET);const service=new ReceiveService(store,{appId:'app',targetThreadId:TEST_TARGET,mode:'desktop-test'});let seq=0;const send=(text,id=String(++seq),user='u')=>service.accept({app_id:'app',sender:{sender_type:'user',tenant_key:'t',sender_id:{open_id:user}},message:{message_id:id,chat_id:'c',chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}},1000);const client={call:async name=>name==='list_projects'?{projects:[p,{...p,projectId:'remote',hostId:'other'}]}:name==='list_threads'?{threads:[task,{...task,id:'chat',kind:'chatgpt'},{...task,id:'wrong',projectId:'other'}]}:{thread:task},close(){}};const worker=new ProjectWorker(store,client);return {store,send,client,worker};}
test('removed aliases cannot switch scope or become task messages',async t=>{
 const f=setup(t);f.send('/rc projects');await f.worker.tick(1001);f.send('/rc project 1');await f.worker.tick(1002);
 for(const text of ['/rc project global','/rc project none','/rc recent']){const r=f.send(text);await f.worker.tick(1003);assert.equal(selectedProject(f.store,'t','c').projectId,'p');assert.equal(f.store.get(r.id).delivery,'cancelled');}
 assert.equal(classify('/rc recent'),'unknown_command');
});
test('project selection filters tasks, blocks old-target text and preserves prior queue and pause',async t=>{
 const f=setup(t);f.send('old','old');f.send('/rc projects');await f.worker.tick(1001);f.send('/rc project 1');const early=f.send('early');assert.equal(f.store.get(early.id).delivery,'cancelled');await f.worker.tick(1002);assert.equal(selectedProject(f.store,'t','c').needsTask,true);f.send('/rc tasks');await f.worker.tick(1003);const list=JSON.parse(f.store.db.prepare("SELECT items FROM project_lists WHERE kind='tasks'").get().items);assert.equal(list.length,1);f.store.pause('t','c',true);f.send('/rc use 1');await f.worker.tick(1004);assert.equal(f.store.db.prepare('SELECT target_id FROM bindings').get().target_id,task.id);assert.equal(f.store.db.prepare('SELECT paused FROM bindings').get().paused,1);assert.equal(f.store.get(1).target_id,TEST_TARGET);assert.equal(allowedTasks(f.store).get(task.id),task.title);const next=f.send('next');assert.equal(f.store.get(next.id).target_id,task.id);
});
test('expired and unauthorized selection cannot change binding; duplicate commands run once',async t=>{
 const f=setup(t);assert.equal(f.send('/rc projects','intruder','other').accepted,false);f.send('/rc projects','list');assert.equal(f.send('/rc projects','list').duplicate,true);await f.worker.tick(1001);f.send('/rc project 1');await f.worker.tick(400000);assert.equal(selectedProject(f.store,'t','c'),null);assert.equal(f.store.db.prepare('SELECT target_id FROM bindings').get().target_id,TEST_TARGET);
});
test('new request freezes project; git uses worktree and non-git local',async t=>{
 const f=setup(t);f.send('/rc projects');await f.worker.tick(1001);f.send('/rc project 1');await f.worker.tick(1002);f.send('/rc new test');const row=f.store.db.prepare('SELECT project_json FROM creation_requests').get();assert.equal(JSON.parse(row.project_json).projectId,'p');
 const adapter=new CreationAdapter();let args;adapter.client={call:async(name,a)=>{args=a;return {}}};await adapter.create('test',p);assert.deepEqual(args.target,{type:'project',projectId:'p',environment:{type:'worktree'}});await adapter.create('test',{...p,isGitRepository:false});assert.equal(args.target.environment.type,'local');
});
test('background worktree creation keeps client id and never retries creation',async t=>{
 const f=setup(t);f.send('/rc new test');let calls=0;const adapter={prepare:async()=>{},create:async()=>{calls++;return {clientThreadId:'pending-id'}},close(){}};const w=new CreationWorker(f.store,adapter);await w.tick(1002);w.recover();await w.tick(1003);assert.equal(calls,1);assert.equal(f.store.db.prepare('SELECT client_thread_id FROM creation_requests').get().client_thread_id,'pending-id');assert.equal(f.store.db.prepare('SELECT target_id FROM bindings').get().target_id,TEST_TARGET);
});
test('global default excludes project tasks; exiting invalidates list and blocks old project delivery',async t=>{
 const f=setup(t);const loose={...task,id:'loose',title:'独立任务',projectId:null};f.client.call=async(name,args)=>name==='list_projects'?{projects:[p]}:name==='list_threads'?{pinnedThreads:[loose],threads:[loose,task,{...loose,id:'remote',hostId:'remote'}]}:{thread:args.threadId===loose.id?loose:task};
 assert.equal(selectedProject(f.store,'t','c'),null);f.send('/rc tasks');await f.worker.tick(1001);let list=JSON.parse(f.store.db.prepare("SELECT items FROM project_lists WHERE kind='tasks'").get().items);assert.deepEqual(list.map(x=>x.id),['loose']);
 f.send('/rc projects');await f.worker.tick(1002);f.send('/rc project 1');await f.worker.tick(1003);f.send('/rc tasks');await f.worker.tick(1004);f.send('/rc use 1');await f.worker.tick(1005);assert.equal(f.store.db.prepare('SELECT target_id FROM bindings').get().target_id,task.id);const old=f.send('project work');
 f.send('/rc project 0');await f.worker.tick(1006);assert.equal(selectedProject(f.store,'t','c'),null);assert.equal(globalSelectionPending(f.store,'t','c'),true);assert.equal(f.store.db.prepare("SELECT items FROM project_lists WHERE kind='tasks'").get(),undefined);const blocked=f.send('do not send to old project');assert.equal(f.store.get(blocked.id).delivery,'cancelled');assert.equal(f.store.get(old.id).target_id,task.id);
 f.send('/rc tasks');await f.worker.tick(1007);f.send('/rc use 1');await f.worker.tick(1008);assert.equal(globalSelectionPending(f.store,'t','c'),false);const next=f.send('global work');assert.equal(f.store.get(next.id).target_id,'loose');
});
test('tasks respects current scope and stale cross-project snapshot cannot switch',async t=>{
 const f=setup(t);f.send('/rc tasks');await f.worker.tick(1001);assert.deepEqual(JSON.parse(f.store.db.prepare("SELECT items FROM project_lists WHERE kind='tasks'").get().items),[]);
 f.store.db.prepare("UPDATE project_lists SET items=? WHERE kind='tasks'").run(JSON.stringify([{id:task.id,title:task.title,projectId:'p',scope:'recent'}]));f.send('/rc use 1');await f.worker.tick(1002);assert.equal(f.store.db.prepare('SELECT target_id FROM bindings').get().target_id,TEST_TARGET);
 f.send('/rc projects');await f.worker.tick(1003);f.send('/rc project 1');await f.worker.tick(1004);f.send('/rc tasks');await f.worker.tick(1005);assert.equal(JSON.parse(f.store.db.prepare("SELECT items FROM project_lists WHERE kind='tasks'").get().items)[0].projectId,'p');
 f.send('/rc project 0');await f.worker.tick(1006);assert.equal(selectedProject(f.store,'t','c'),null);f.send('/rc new 独立任务');assert.equal(f.store.db.prepare('SELECT project_json FROM creation_requests').get().project_json,null);
 const worker=new CreationWorker(f.store,{prepare:async()=>{},create:async()=>({threadId:task.id,hostId:'local'}),readCreated:async()=>({thread:task})});await worker.tick(1007);assert.equal(globalSelectionPending(f.store,'t','c'),false);
});


