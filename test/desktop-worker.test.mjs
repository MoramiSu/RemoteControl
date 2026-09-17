import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeStore} from '../src/store.ts';
import {DesktopWorker} from '../src/desktop-worker.mjs';
import {TEST_TARGET,SOURCE} from '../src/desktop-adapter.mjs';
const prompt='闭环验证 原文\n不改写';
function setup(t){const s=new BridgeStore(':memory:');t.after(()=>s.close());s.bind('tenant','chat','owner',TEST_TARGET);s.receive({messageId:'m',tenantId:'tenant',chatId:'chat',userId:'owner',text:prompt});return s;}
function page(status='idle',turns=[]){return {thread:{id:TEST_TARGET,status:{type:status}},turns};}
function sentTurn(status='inProgress',text='最终原文'){return {id:'new',status,items:[{id:'input',type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>${SOURCE}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`}},...(status==='completed'?[{type:'agentMessage',phase:'final_answer',text}]:[])]};}
test('busy desktop leaves message queued',async t=>{const s=setup(t);let sends=0;const w=new DesktopWorker(s,{read:async()=>page('active'),send:async()=>sends++});await w.tick();assert.equal(sends,0);assert.equal(s.get(1).delivery,'queued')});
test('exact delivery then final reply enters outbox once',async t=>{const s=setup(t);let sent=false;let complete=false;const w=new DesktopWorker(s,{read:async()=>sent?page(complete?'idle':'active',[sentTurn(complete?'completed':'inProgress')]):page(),send:async text=>{assert.equal(text,prompt);sent=true;}});await w.tick();assert.equal(s.get(1).delivery,'delivered');complete=true;await w.tick();await w.tick();assert.equal(s.get(1).execution,'completed');assert.equal(s.pendingReplies().filter(x=>x.body==='最终原文').length,1)});
test('ambiguous send never retries and blocks following messages',async t=>{const s=setup(t);let sends=0;const w=new DesktopWorker(s,{read:async()=>page(),send:async()=>{sends++;throw Error('timeout')}});await w.tick();await w.tick();assert.equal(sends,1);assert.equal(s.get(1).delivery,'delivery_unknown')});
test('after crash a persisted matching send is reconciled without resend',async t=>{const s=setup(t);s.claim(TEST_TARGET,true,[]);s.recover();let sends=0;const w=new DesktopWorker(s,{read:async()=>page('idle',[sentTurn('completed')]),send:async()=>sends++});await w.tick();assert.equal(sends,0);assert.equal(s.get(1).execution,'completed')});
test('unloaded existing task can resume through same-id send tool',async t=>{const s=setup(t);let sent=false;const w=new DesktopWorker(s,{read:async()=>sent?page('active',[sentTurn()]):page('notLoaded'),send:async()=>{sent=true}});await w.tick();assert.equal(s.get(1).delivery,'delivered')});
