import {DatabaseSync} from 'node:sqlite';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
export function mergeRolloutItems(page,jsonl) {
  const rows=jsonl.split('\n');const events=[];
  for(let i=0;i<rows.length;i++){
    if(!rows[i].trim())continue;
    try{events.push(JSON.parse(rows[i]));}catch(e){if(i!==rows.length-1)throw new Error('rollout_invalid');}
  }
  const meta=events.find(x=>x.type==='session_meta');
  if(meta?.payload?.id!==page.thread.id)throw new Error('rollout_identity_mismatch');
  const turns=new Map(page.turns.map(t=>[t.id,{...t,items:[...(t.items??[])]}]));
  for(const e of events){
    const p=e.payload;
    if(e.type!=='event_msg' || p?.type!=='item_completed' || p.thread_id!==page.thread.id)continue;
    const turn=turns.get(p.turn_id);if(!turn)continue;
    const item=p.item;let normalized;
    if(item?.type==='FunctionCallOutput' && item.namespace==='codex_app' && item.name==='send_message_to_thread' && typeof item.output==='string')normalized={type:'functionCallOutput',id:item.id,namespace:item.namespace,name:item.name,output:{text:item.output,truncated:false}};
    if(item?.type==='AgentMessage' && ['final_answer','final'].includes(item.phase) && Array.isArray(item.content) && item.content.every(c=>c.type==='Text' && typeof c.text==='string'))normalized={type:'agentMessage',id:item.id,text:item.content.map(c=>c.text).join(''),phase:item.phase};
    if(!normalized || typeof normalized.id!=='string')continue;
    const prior=turn.items.find(x=>x.id===normalized.id);
    if(prior){
      const a=prior.type==='agentMessage'?prior.text:prior.output?.text;
      const b=normalized.type==='agentMessage'?normalized.text:normalized.output.text;
      if(a!==b)throw new Error('rollout_api_conflict');
    }else turn.items.push(normalized);
  }
  const artifactContexts={};
  for(const turn of turns.values()){
    const context=events.filter(e=>e.type==='turn_context'&&e.payload?.turn_id===turn.id).at(-1)?.payload;
    const cwd=context?.cwd??meta.payload.cwd;
    if(typeof cwd==='string')artifactContexts[turn.id]={threadId:page.thread.id,cwd};
  }
  return {...page,turns:[...turns.values()],artifactContexts};
}
export function supplementFromLocalRollout(page) {
  const codexRoot=join(homedir(),'.codex');
  const db=new DatabaseSync(join(codexRoot,'state_5.sqlite'),{readOnly:true});let path;
  try{path=db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(page.thread.id)?.rollout_path;}finally{db.close();}
  if(typeof path!=='string')throw new Error('rollout_missing');
  const root=realpathSync.native(join(codexRoot,'sessions'));const full=realpathSync.native(path);const rel=relative(root,full);
  if(rel.startsWith('..') || isAbsolute(rel) || !full.endsWith('.jsonl'))throw new Error('rollout_path_invalid');
  if(statSync(full).size>64*1024*1024)throw new Error('rollout_size_limit');
  return mergeRolloutItems(page,readFileSync(full,'utf8'));
}

