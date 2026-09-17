import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverSetupTasks,verifySetupChoice} from '../src/setup-discovery.mjs';
const thread=(id,title=id)=>({id,title,kind:'codex',hostId:'local'});
test('discovery retries stale source, filters remote tasks and deduplicates',async()=>{
 let closed=0;
 const found=await discoverSetupTasks({candidates:[thread('stale'),thread('source')],makeAdapter:id=>({
  async call(name){if(id==='stale')throw Error('gone');return name==='read_thread'?{thread:thread(id)}:{pinnedThreads:[thread('a')],threads:[thread('a'),thread('b'),{...thread('remote'),hostId:'other'},{...thread('chat'),kind:'chatgpt'}]};},
  close(){closed++;}
 })});
 assert.deepEqual(found,{sourceThreadId:'source',tasks:[{id:'a',title:'a'},{id:'b',title:'b'}]});assert.equal(closed,2);
});
test('selection verifies separate source and exact target identity',async()=>{
 let origin;
 const config=await verifySetupChoice({sourceThreadId:'a',tasks:[thread('a'),thread('b')]},0,{makeAdapter:(id,title,source)=>({
  async call(name,args){origin=args.threadId;assert.equal(source,'b');return {thread:thread(source)};},async read(){return {thread:thread(id,title)};},close(){}
 })});
 assert.equal(origin,'b');assert.equal(config.targetThreadId,'a');assert.equal(config.sourceThreadId,'b');
});
test('renamed target is rejected and adapter closed',async()=>{
 let closed=false;
 await assert.rejects(verifySetupChoice({sourceThreadId:'source',tasks:[thread('a')]},0,{makeAdapter:()=>({async call(){return {thread:thread('source')};},async read(){return {thread:thread('a','changed')};},close(){closed=true;}})}),/目标会话已变化/);
 assert.equal(closed,true);
});
test('invalid selection and single source task cannot be used',async()=>{
 const found={sourceThreadId:'a',tasks:[thread('a')]};
 await assert.rejects(verifySetupChoice(found,4),/无效/);
 await assert.rejects(verifySetupChoice(found,0),/独立会话/);
});
