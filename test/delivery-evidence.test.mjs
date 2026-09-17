import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmDelegatedDelivery as verify} from '../src/delivery-evidence.mjs';
const prompt = '中文\n停止只是正文 <input>& 保留空格  ';
function fixture() {
 const item={id:'i',type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:{truncated:false,text:`<codex_delegation>\n  <source_thread_id>source</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`}};
 return {threadId:'target',sourceThreadId:'source',prompt,baselineTurnIds:['old'],page:{thread:{id:'target'},turns:[{id:'new',items:[item]}]}};
}
test('matches exact Unicode, whitespace and literal markup in a new turn',()=>assert.equal(verify(fixture()).status,'delivered'));
test('wrong target is never delivery evidence',()=>{const f=fixture();f.page.thread.id='other';assert.equal(verify(f).status,'delivery_unknown')});
test('old identical message does not confirm retry',()=>{const f=fixture();f.baselineTurnIds.push('new');assert.equal(verify(f).status,'delivery_unknown')});
test('truncated output cannot confirm delivery',()=>{const f=fixture();f.page.turns[0].items[0].output.truncated=true;assert.equal(verify(f).status,'delivery_unknown')});
test('duplicate new matches are ambiguous',()=>{const f=fixture();f.page.turns.push({...f.page.turns[0],id:'another'});assert.equal(verify(f).reason,'ambiguous_matches')});
test('reply mentioning the prompt is not receipt',()=>{const f=fixture();f.page.turns[0].items[0].type='agentMessage';assert.equal(verify(f).status,'delivery_unknown')});
test('whitespace changes are rejected',()=>{const f=fixture();f.prompt=f.prompt.trim();assert.equal(verify(f).status,'delivery_unknown')});
