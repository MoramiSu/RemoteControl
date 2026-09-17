import {DatabaseSync} from 'node:sqlite';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DesktopAdapter} from './desktop-adapter.mjs';

export function localCandidates(root=join(homedir(),'.codex')){
 const db=new DatabaseSync(join(root,'state_5.sqlite'),{readOnly:true});
 try{return db.prepare('SELECT id,title FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 12').all().filter(t=>typeof t.id==='string'&&typeof t.title==='string');}finally{db.close();}
}
export async function discoverSetupTasks({candidates=localCandidates(),makeAdapter=(id,title)=>new DesktopAdapter(id,new Map([[id,title]]),id)}={}){
 for(const candidate of candidates){
  const adapter=makeAdapter(candidate.id,candidate.title);
  try{
   const source=await adapter.call('read_thread',{threadId:candidate.id,turnLimit:1,includeOutputs:false});
   if(source.thread?.id!==candidate.id||source.thread.kind!=='codex'||source.thread.hostId!=='local')continue;
   const catalog=await adapter.call('list_threads',{limit:50});
   const tasks=[...new Map([...(catalog.pinnedThreads??[]),...(catalog.threads??[])].filter(t=>t.kind==='codex'&&t.hostId==='local'&&typeof t.id==='string'&&typeof t.title==='string').map(t=>[t.id,{id:t.id,title:t.title}])).values()];
   if(tasks.length)return {sourceThreadId:candidate.id,tasks};
  }catch{}finally{adapter.close();}
 }
 throw Error('无法读取桌面会话。请打开 Codex 并进入一个已有任务，然后重试；也可能是桌面版本尚不兼容。');
}
export async function verifySetupChoice(discovery,index,{makeAdapter=(id,title,source)=>new DesktopAdapter(id,new Map([[id,title]]),source)}={}){
 const target=discovery.tasks[index];if(!target)throw Error('无效会话编号');
 // Keep the metadata source separate from the target being controlled.
 const source=discovery.sourceThreadId!==target.id?discovery.sourceThreadId:discovery.tasks.find(t=>t.id!==target.id)?.id;
 if(!source)throw Error('请先在 Codex 再准备一个独立会话，然后重新运行安装向导。');
 const adapter=makeAdapter(target.id,target.title,source);
 try{
  const origin=await adapter.call('read_thread',{threadId:source,turnLimit:1,includeOutputs:false});
  if(origin.thread?.id!==source||origin.thread.hostId!=='local'||origin.thread.kind!=='codex')throw Error('来源会话无法核验');
  const page=await adapter.read();if(page.thread.id!==target.id||page.thread.title!==target.title)throw Error('目标会话已变化，请重新选择');
  return {sourceThreadId:source,targetThreadId:target.id,targetTitle:target.title};
 }finally{adapter.close();}
}
