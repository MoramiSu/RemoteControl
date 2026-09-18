import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeStore} from '../src/store.ts';
import {ReceiveService} from '../src/receive-service.mjs';
import {parseTextEvent,classify} from '../src/feishu-events.mjs';
const event=(text,id='m1',user='ou_owner')=>({app_id:'cli_test',tenant_key:'tenant',sender:{sender_type:'user',tenant_key:'tenant',sender_id:{open_id:user}},message:{message_id:id,chat_id:'chat',chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}});
function fixture(t){const s=new BridgeStore(':memory:');t.after(()=>s.close());return new ReceiveService(s,{appId:'cli_test',targetThreadId:'test-target',pairCode:'random-test-code',expiresAt:2000});}
test('pairing requires private user, unexpired secret and matching app',t=>{const s=fixture(t);assert.equal(s.accept(event('/rc pair wrong'),1000).accepted,false);assert.equal(s.accept(event('/rc pair random-test-code'),3000).accepted,false);const e=event('/rc pair random-test-code');e.message.chat_type='group';assert.equal(s.accept(e,1000).accepted,false);e.message.chat_type='p2p';e.app_id='cli_other';assert.equal(s.accept(e,1000).accepted,false)});
test('pairing binds exact identity; token redacted; others rejected',t=>{const s=fixture(t);assert.equal(s.accept(event('/rc pair random-test-code'),1000).accepted,true);assert.equal(s.store.get(1).original_text,'/rc pair [redacted]');assert.equal(s.accept(event('hello','m2','stranger'),1000).accepted,false);assert.equal(s.accept(event('/rc pair random-test-code'),1000).duplicate,true);assert.equal(s.store.pendingReplies().length,1)});
test('ordinary text preserved; prefix commands never queued as desktop input',t=>{const s=fixture(t);s.accept(event('/rc pair random-test-code'),1000);s.accept(event('停止\n 原文  ','m2'),1000);assert.equal(s.store.get(2).original_text,'停止\n 原文  ');assert.equal(s.store.get(2).delivery,'queued');s.accept(event('/rc stop','m3'),1000);assert.equal(s.store.get(3).delivery,'cancelled');assert.equal(classify('请不要停止'),'text')});
test('pair, receipt and reply rollback together on database failure',t=>{const s=fixture(t);s.store.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'test failure'); END");assert.throws(()=>s.accept(event('/rc pair random-test-code'),1000));assert.equal(s.binding,undefined);assert.equal(s.store.db.prepare('SELECT COUNT(*) n FROM bindings').get().n,0);assert.equal(s.store.db.prepare('SELECT COUNT(*) n FROM inbox').get().n,0)});
test('malformed or conflicting tenant payload is rejected',()=>{const e=event('hello');e.message.content='bad';assert.equal(parseTextEvent(e,'cli_test'),null);e.message.content='{"text":"hello"}';e.sender.tenant_key='other';assert.equal(parseTextEvent(e,'cli_test'),null)});

test('status reflects live runtime and persisted pause and queue without becoming task input',t=>{
 const s=fixture(t);s.mode='desktop-test';s.getRuntime=()=>({desktop:'connection_error',connection:'connected'});
 s.accept(event('/rc pair random-test-code'),1000);
 s.accept(event('queued task','m2'),1000);
 s.accept(event('/rc pause','m3'),1000);
 s.accept(event('/rc status','m4'),1000);
 const reply=s.store.pendingReplies().find(r=>r.inbox_id===4).body;
 assert.match(reply,/飞书：已连接/);assert.match(reply,/连接失败，正在重试/);assert.match(reply,/遥控：已暂停/);assert.match(reply,/排队：1 条/);
 assert.equal(s.store.get(4).delivery,'cancelled');
 assert.equal(s.accept(event('/rc status','m4'),1000).duplicate,true);
 assert.equal(s.store.pendingReplies().filter(r=>r.inbox_id===4).length,1);
});

test('task selects a session; retired use command cannot become task input',()=>{assert.equal(classify('/rc task 2'),'use');assert.equal(classify('/rc task'),'use');assert.equal(classify('/rc tasks'),'tasks');assert.equal(classify('/rc use 2'),'unknown_command');assert.equal(classify('/rc use'),'unknown_command');assert.equal(classify('task 2'),'text')});
