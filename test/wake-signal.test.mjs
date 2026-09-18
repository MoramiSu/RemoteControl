import test from 'node:test';
import assert from 'node:assert/strict';
import {WakeSignal} from '../src/wake-signal.mjs';
test('wake during work is retained; bursts coalesce without losing next notification',async()=>{
 const s=new WakeSignal();s.wake();s.wake();
 await s.wait(10000);assert.equal(s.pending,false);
 const wait=s.wait(10000);s.wake();await wait;
 s.wake();await s.wait(10000);assert.equal(s.waiter,null);
});
test('wakeable worker stays serial with notifications during an in-flight job',async()=>{
 const s=new WakeSignal(),queue=[1],seen=[];let active=0,max=0;
 async function tick(){active++;max=Math.max(max,active);seen.push(queue.shift());await new Promise(r=>setTimeout(r,5));active--;}
 const run=(async()=>{for(let i=0;i<3;i++){await s.wait(1000);await tick();if(queue.length)s.wake();}})();
 s.wake();await new Promise(r=>setTimeout(r,1));queue.push(2,3);s.wake();await run;
 assert.deepEqual(seen,[1,2,3]);assert.equal(max,1);
});
test('timeout remains a recovery fallback',async()=>{const s=new WakeSignal();await s.wait(5);assert.equal(s.waiter,null);s.wake();await s.wait(10000);});
