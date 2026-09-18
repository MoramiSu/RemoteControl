import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {WakeSignal} from '../src/wake-signal.mjs';
import {runWakeLoop} from '../src/wake-loop.mjs';

test('one notification drains queued commands without another poll; stop wakes idle loop',async()=>{
 const signal=new WakeSignal();let stopping=false,calls=0;const queue=[];
 const run=runWakeLoop({signal,stopped:()=>stopping,interval:10000,onError:e=>{throw e;},tick:async()=>{
   calls++;if(queue.length){queue.shift();return true;}
 }});
 await sleep(5);queue.push(1,2,3);signal.wake();
 await sleep(20);stopping=true;signal.wake();await run;
 assert.equal(queue.length,0);assert.equal(calls,5);
});

test('notifications during sends preserve cooldown and never overlap attempts',async()=>{
 const signal=new WakeSignal();let stopping=false,active=0,max=0;const starts=[];
 const run=runWakeLoop({signal,stopped:()=>stopping,interval:10000,cooldown:()=>30,onError:e=>{throw e;},tick:async()=>{
   starts.push(performance.now());active++;max=Math.max(max,active);signal.wake();await sleep(5);active--;
   if(starts.length===3)stopping=true;
 }});
 await run;assert.equal(max,1);assert.ok(starts[1]-starts[0]>=30);assert.ok(starts[2]-starts[1]>=30);
});

test('failed tick waits for fallback instead of spinning',async()=>{
 const signal=new WakeSignal();let stopping=false,calls=0,errors=0;
 const run=runWakeLoop({signal,stopped:()=>stopping,interval:20,onError:()=>errors++,tick:async()=>{
   calls++;if(calls===2)stopping=true;throw Error('injected');
 }});
 await run;assert.equal(calls,2);assert.equal(errors,2);
});
