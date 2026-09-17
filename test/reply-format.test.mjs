import test from 'node:test';
import assert from 'node:assert/strict';
import {splitReplySource,buildReplyPlan} from '../src/reply-format.mjs';
import {BridgeStore} from '../src/store.ts';
import {ReplySender} from '../src/reply-sender.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function setup(t,path=':memory:'){
  const store=new BridgeStore(path);t.after(()=>store.close());store.bind('tenant','chat','owner','target');
  const {id}=store.receive({messageId:'m1',tenantId:'tenant',chatId:'chat',userId:'owner',text:'test'});
  store.db.prepare("UPDATE outbox SET status='sent'").run();store.claim('target',true,[]);store.markDelivery(id,'delivered','turn');
  return {store,id};
}
function client(send=async()=>({code:0,data:{message_id:'remote'}}),upload=async()=>({image_key:'img_test'})) {return {im:{message:{create:send},image:{create:upload}}};}
const options={appId:'app',instanceId:'instance',titleFor:()=> '测试任务'};

test('source chunks preserve CRLF Unicode, fenced diagrams and large tables across replay',t=>{
  const text='😀'.repeat(2100)+'\r\n```mermaid\r\nflowchart LR\r\n'+Array.from({length:170},(_,i)=>`A${i} --> A${i+1}\r\n`).join('')+'```\r\n| 名称 | 说明 |\r\n| --- | --- |\r\n'+('| a | '+'字'.repeat(80)+' |\r\n').repeat(30);
  const parts=splitReplySource(text);assert.equal(parts.join(''),text);assert.equal(parts.filter(p=>p.includes('```')).length,1);assert.equal(parts.filter(p=>p.includes('| a |')).length,1);
  const {store,id}=setup(t);store.recordOutcome(id,'turn','completed',text);store.recordOutcome(id,'turn','completed',text);assert.equal(store.pendingReplies().map(p=>p.body).join(''),text);
});
test('markdown, code, table and Mermaid produce typed content and an uploaded image',async()=>{
  let renders=0,uploads=0;
  const plan=await buildReplyPlan('# 标题\n\n**粗体**\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```mermaid\nflowchart LR\nA --> B\n```','任务',{render:async text=>{renders++;assert.match(text,/flowchart/);return Buffer.from('png');},upload:async()=>{uploads++;return 'img_test';}});
  const elements=plan.flatMap(p=>JSON.parse(p.content).body.elements);assert.equal(renders,1);assert.equal(uploads,1);assert.ok(elements.some(e=>e.tag==='table'));assert.ok(elements.some(e=>e.tag==='markdown'&&e.content.includes('```js')));assert.ok(elements.some(e=>e.tag==='img'));
});
test('short mixed replies stay together and whitespace-only source creates no blank message',async()=>{
  const text='Intro\n\n```js\ncode\n```\n\n```mermaid\nflowchart LR\nA-->B\n```\n\nEnd';
  assert.deepEqual(splitReplySource(text),[text]);assert.deepEqual(await buildReplyPlan('\r\n\n','任务'),[]);
});
test('replaying a pre-upgrade outcome does not add chunks using the new boundaries',t=>{
  const {store,id}=setup(t);const text='before\n```mermaid\n'+'A --> B\n'.repeat(300)+'```\nafter';const chars=Array.from(text);
  for(let i=0;i<chars.length;i+=2000)store.db.prepare('INSERT INTO outbox(inbox_id,dedup_key,body) VALUES(?,?,?)').run(id,i===0?`outcome:${id}:turn`:`outcome:${id}:turn:part:${i}`,chars.slice(i,i+2000).join(''));
  const before=store.pendingReplies();store.recordOutcome(id,'turn','completed',text);assert.deepEqual(store.pendingReplies(),before);
});
test('render or upload failure keeps source visible and cannot fetch arbitrary image links',async()=>{
  for(const dependency of ['render','upload']){
    const deps={render:async()=>Buffer.from('png'),upload:async()=> 'img_ok'};deps[dependency]=async()=>{throw Error('failure');};
    const plan=await buildReplyPlan('![secret](file:///private.txt)\n<at id=all>所有人</at>\n\n```mermaid\nflowchart LR\nA --> B\n```','任务',deps);
    const json=JSON.stringify(plan.map(p=>p.content));assert.match(json,/未能转为图片/);assert.match(json,/A --> B/);assert.doesNotMatch(json,/file:\/\/\/private/);assert.match(json,/&lt;at/);
  }
});
test('long code is bounded and remains complete; excess diagrams degrade explicitly',async()=>{
  const code='console.log("😀");\n'.repeat(1300),plan=await buildReplyPlan('```js\n'+code+'```','任务');
  assert.ok(plan.length>1);assert.ok(plan.every(p=>Buffer.byteLength(p.content)<20000));
  assert.equal(plan.flatMap(p=>JSON.parse(p.content).body.elements).map(e=>e.content.slice(e.content.indexOf('\n')+1,e.content.lastIndexOf('\n'))).join(''),code.trimEnd());
  let count=0;const diagrams=await buildReplyPlan(('```mermaid\nflowchart LR\nA --> B\n```\n\n').repeat(5),'任务',{render:async()=>{count++;return Buffer.from('png')},upload:async()=> 'img_x'});assert.equal(count,4);assert.match(JSON.stringify(diagrams),/未能转为图片/);
});
test('network ambiguity and restart reuse exact prepared payload, image key and UUID',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'rc-format-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'bridge.sqlite');
  let store=new BridgeStore(path);store.bind('tenant','chat','owner','target');const {id}=store.receive({messageId:'m',tenantId:'tenant',userId:'owner',chatId:'chat',text:'test'});store.db.prepare("UPDATE outbox SET status='sent'").run();store.claim('target',true,[]);store.markDelivery(id,'delivered','turn');store.recordOutcome(id,'turn','completed','```mermaid\nflowchart LR\nA --> B\n```');
  let uploads=0,clock=100000;const calls=[];let failed=true;
  const api=client(async request=>{calls.push(request.data);if(failed)throw Error('timeout');return {code:0,data:{message_id:'ok'}}},async()=>{uploads++;return {image_key:'img_x'}});
  let sender=new ReplySender(store,api,{...options,render:async()=>Buffer.from('png'),now:()=>clock});await assert.rejects(sender.tick());store.close();
  store=new BridgeStore(path);try{store.recover();sender=new ReplySender(store,api,{...options,render:async()=>{throw Error('must not rerender')},now:()=>clock});failed=false;clock+=16000;assert.equal(await sender.tick(),true);assert.deepEqual(calls[0],calls[1]);assert.equal(uploads,1);assert.equal(store.pendingReplies().length,0);}finally{store.close();}
});
test('explicit format rejection persists plain fallback; no fallback on timeout',async t=>{
  const {store,id}=setup(t);store.recordOutcome(id,'turn','completed','**reply**');const calls=[];
  const sender=new ReplySender(store,client(async request=>{calls.push(request.data);return calls.length===1?{code:230001}:{code:0,data:{message_id:'ok'}}}),options);
  assert.equal(await sender.tick(),false);assert.equal(await sender.tick(),true);assert.equal(calls[0].msg_type,'interactive');assert.equal(calls[1].msg_type,'text');assert.notEqual(calls[0].uuid,calls[1].uuid);assert.match(calls[1].content,/reply/);
});
test('an already-attempted legacy plain reply keeps the old UUID and exact text',async t=>{
  const {store,id}=setup(t);store.recordOutcome(id,'turn','completed','**legacy**');let request;
  const sender=new ReplySender(store,client(async r=>{request=r;return {code:0,data:{message_id:'ok'}}}),{...options,now:()=>20000});const row=store.pendingReplies()[0];store.db.prepare('INSERT INTO reply_attempts VALUES(?,?,?)').run(row.id,10000,19000);store.db.prepare('UPDATE outbox SET wire_body=? WHERE id=?').run('固定旧文本',row.id);
  await sender.tick();assert.equal(request.data.msg_type,'text');assert.equal(request.data.content,JSON.stringify({text:'固定旧文本'}));assert.equal(request.data.uuid,sender.uuid(row));
});
test('expired ambiguous reply stays pending while other inbox receipts can proceed',async t=>{
  const {store,id}=setup(t);store.recordOutcome(id,'turn','completed','**old**');let clock=1000;let fail=true;const api=client(async()=>{if(fail)throw Error('timeout');return {code:0,data:{message_id:'ok'}}});const sender=new ReplySender(store,api,{...options,now:()=>clock});await assert.rejects(sender.tick());
  store.receive({messageId:'m2',tenantId:'tenant',chatId:'chat',userId:'owner',text:'new'});clock+=300001;fail=false;await sender.tick();assert.equal(store.pendingReplies().length,1);assert.equal(store.pendingReplies()[0].inbox_id,id);
});
