import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeStore} from '../src/store.ts';
import {ReceiveService} from '../src/receive-service.mjs';
import {UsageWorker,formatUsage} from '../src/usage.mjs';
import {classify} from '../src/feishu-events.mjs';
test('usage formatting prefers named buckets and treats missing limits as unknown',()=>{
 const text=formatUsage({rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{primary:{usedPercent:33,windowDurationMins:300,resetsAt:1789195022},secondary:{usedPercent:88,windowDurationMins:10080}}}},new Date('2026-09-12T00:00:00Z'));
 assert.match(text,/剩余 67%/);assert.match(text,/剩余 12%/);assert.match(text,/09\/12 08:00/);assert.match(formatUsage({rateLimits:{primary:null}}),/剩余 未知/);assert.doesNotMatch(text,/剩余 1%/);
});
test('authorized usage command is durable, deduplicated and works while paused without task delivery',async()=>{
 const store=new BridgeStore(':memory:');try{
 store.bind('t','c','u','target');store.pause('t','c',true);
 const service=new ReceiveService(store,{appId:'app',targetThreadId:'target',mode:'desktop-test'});
 const event={app_id:'app',sender:{sender_type:'user',tenant_key:'t',sender_id:{open_id:'u'}},message:{message_id:'m',chat_id:'c',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'/rc usage'})}};
 assert.equal(service.accept(event).accepted,true);assert.equal(service.accept(event).duplicate,true);assert.equal(store.get(1).delivery,'cancelled');
 let calls=0;const worker=new UsageWorker(store,async()=>{calls++;return {rateLimits:{primary:{usedPercent:25}}}});await worker.tick();await worker.tick();assert.equal(calls,1);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE dedup_key='usage:1'").get().n,1);
 event.sender.sender_id.open_id='stranger';event.message.message_id='other';assert.equal(service.accept(event).accepted,false);
 assert.equal(classify('正文中的 /rc usage'),'text');
 }finally{store.close();}
});
test('query failure returns a receipt without leaking API errors',async()=>{
 const store=new BridgeStore(':memory:');try{store.bind('t','c','u','x');const r=store.receive({tenantId:'t',chatId:'c',userId:'u',messageId:'m',text:'/rc usage'});const worker=new UsageWorker(store,async()=>{throw Error('secret')});store.db.prepare('INSERT INTO usage_requests(inbox_id) VALUES(?)').run(r.id);await worker.tick();const body=store.db.prepare("SELECT body FROM outbox WHERE dedup_key='usage:1'").get().body;assert.match(body,/查询失败/);assert.doesNotMatch(body,/secret/);}finally{store.close();}
});
