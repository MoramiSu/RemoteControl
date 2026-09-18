import {bumpSelection,selectionRevision} from './tasks.mjs';
export function initializeProjects(store){store.db.exec(`
 CREATE TABLE IF NOT EXISTS project_choices(tenant TEXT,chat TEXT,project_json TEXT,needs_task INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(tenant,chat));
 CREATE TABLE IF NOT EXISTS project_lists(tenant TEXT,chat TEXT,kind TEXT,items TEXT,expires INTEGER,PRIMARY KEY(tenant,chat,kind));
 CREATE TABLE IF NOT EXISTS project_commands(inbox_id INTEGER PRIMARY KEY REFERENCES inbox(id),command TEXT,revision INTEGER,done INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS global_selection_pending(tenant TEXT,chat TEXT,PRIMARY KEY(tenant,chat));
 CREATE TABLE IF NOT EXISTS selected_project_tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL);
 `);for(const column of ['project_json','client_thread_id'])if(!store.db.prepare('PRAGMA table_info(creation_requests)').all().some(c=>c.name===column))store.db.exec(`ALTER TABLE creation_requests ADD COLUMN ${column} TEXT`);}
export function selectedProject(store,tenant,chat){const r=store.db.prepare('SELECT * FROM project_choices WHERE tenant=? AND chat=?').get(tenant,chat);return r?{...JSON.parse(r.project_json),needsTask:!!r.needs_task}:null;}
export function globalSelectionPending(store,tenant,chat){return !!store.db.prepare('SELECT 1 FROM global_selection_pending WHERE tenant=? AND chat=?').get(tenant,chat);}
export function queueProjectCommand(store,id,command,m){store.db.prepare('INSERT INTO project_commands(inbox_id,command,revision) VALUES(?,?,?)').run(id,command,selectionRevision(store,m.tenantId,m.chatId));}
const localProjects=data=>(data.projects??[]).filter(p=>p.projectKind==='local'&&p.hostId==='local'&&typeof p.projectId==='string'&&typeof p.label==='string'&&typeof p.isGitRepository==='boolean');
export class ProjectWorker{
 constructor(store,client){Object.assign(this,{store,client});initializeProjects(store);}
 async tick(now=Date.now()){
  const db=this.store.db,row=db.prepare('SELECT c.*,i.tenant_id,i.chat_id,i.original_text FROM project_commands c JOIN inbox i ON i.id=c.inbox_id WHERE done=0 ORDER BY inbox_id LIMIT 1').get();if(!row)return;
  const tenant=row.tenant_id,chat=row.chat_id;
  const save=(kind,items)=>db.prepare('INSERT INTO project_lists VALUES(?,?,?,?,?) ON CONFLICT(tenant,chat,kind) DO UPDATE SET items=excluded.items,expires=excluded.expires').run(tenant,chat,kind,JSON.stringify(items),now+300000);
  const pick=(kind,n)=>{const list=db.prepare('SELECT * FROM project_lists WHERE tenant=? AND chat=? AND kind=?').get(tenant,chat,kind);if(!list||now>=list.expires)throw Error('列表已过期，请重新列出后选择。');const item=JSON.parse(list.items)[n-1];if(!item)throw Error('编号无效，请按最新列表选择。');return item;};
  const unchanged=()=>{if(selectionRevision(this.store,tenant,chat)!==row.revision)throw Error('选择已变化，本条操作未生效，请重新发送。');};
  let body;let failed=false;
  try{
   unchanged();const current=selectedProject(this.store,tenant,chat);
   if(row.command==='projects'){
    const projects=localProjects(await this.client.call('list_projects',{}));unchanged();save('projects',projects);
    body=projects.length?'0. 全局（/rc project 0）\n本机项目：\n'+projects.map((p,i)=>`${i+1}. ${p.label}`).join('\n')+'\n/rc project 编号 选择；列表有效 5 分钟。':'0. 全局（/rc project 0）\n没有可用的本机项目。';
   }else if(row.command==='project'){
    if(row.original_text==='/rc project 0'){
     if(current)db.prepare('INSERT OR IGNORE INTO global_selection_pending VALUES(?,?)').run(tenant,chat);db.prepare('DELETE FROM project_choices WHERE tenant=? AND chat=?').run(tenant,chat);db.prepare('DELETE FROM project_lists WHERE tenant=? AND chat=? AND kind=\'tasks\'').run(tenant,chat);bumpSelection(this.store,tenant,chat);body='已回到 global 全局模式。/rc tasks 选择独立会话，或 /rc new 名称 新建。'+(globalSelectionPending(this.store,tenant,chat)?'选择会话前不投递正文。':'');
    }else{
     const m=/^\/rc project ([1-9][0-9]*)$/.exec(row.original_text);if(!m)throw Error('用法：/rc projects，然后 /rc project 编号；/rc project 0 回到全局。');
     const p=pick('projects',Number(m[1]));const live=localProjects(await this.client.call('list_projects',{})).find(x=>x.projectId===p.projectId);unchanged();if(!live||live.path!==p.path||live.label!==p.label)throw Error('项目已变化，请重新发送 /rc projects。');
     db.prepare('INSERT INTO project_choices VALUES(?,?,?,1) ON CONFLICT(tenant,chat) DO UPDATE SET project_json=excluded.project_json,needs_task=1').run(tenant,chat,JSON.stringify(live));
     db.prepare('DELETE FROM task_lists WHERE tenant_id=? AND chat_id=?').run(tenant,chat);db.prepare('DELETE FROM project_lists WHERE tenant=? AND chat=? AND kind=\'tasks\'').run(tenant,chat);bumpSelection(this.store,tenant,chat);body=`已选择项目「${live.label}」。发送 /rc tasks 选择任务，或 /rc new 名称 新建。`;
    }
   }else if(row.command==='tasks'){
    const scope=current?'project':'global';
    const list=await this.client.call('list_threads',{limit:50});unchanged();
    const rows=[...new Map([...(list.pinnedThreads??[]),...(list.threads??[])].filter(t=>t.kind==='codex'&&t.hostId==='local'&&(scope==='global'?t.projectId==null:t.projectId===current.projectId)).map(t=>[t.id,{id:t.id,title:t.title,projectId:t.projectId??null,scope}])).values()];save('tasks',rows);
    body=(scope==='global'?'全局独立会话：\n':`项目「${current.label}」任务：\n`)+(rows.length?rows.map((t,i)=>`${i+1}. ${t.title}`).join('\n')+'\n/rc task 编号 切换；以最新列表为准，有效 5 分钟。':'暂无列出的任务，可用 /rc new 名称 新建。')+'\n包含置顶任务及最近 50 条中的本机 Codex 会话；较旧任务可先在桌面打开。';
   }else if(row.command==='use'){
    const m=/^\/rc (?:task|use) ([1-9][0-9]*)$/.exec(row.original_text);if(!m)throw Error('请先 /rc tasks，再 /rc task 编号。');const choice=pick('tasks',Number(m[1]));if(current?choice.scope!=='project'||choice.projectId!==current.projectId:choice.scope!=='global'||choice.projectId!=null)throw Error('项目已变化，请重新列出任务。');
    const catalog=await this.client.call('list_threads',{limit:50});const live=[...(catalog.pinnedThreads??[]),...(catalog.threads??[])].find(t=>t.id===choice.id&&t.kind==='codex'&&t.hostId==='local'&&(t.projectId??null)===(choice.projectId??null)&&t.title===choice.title);if(!live)throw Error('任务归属无法核验，请重新列出任务。');
    let destination=null;if(choice.projectId){destination=localProjects(await this.client.call('list_projects',{})).find(p=>p.projectId===choice.projectId);if(!destination)throw Error('项目无法核验，未切换。');}
    const page=await this.client.call('read_thread',{threadId:choice.id,turnLimit:1,includeOutputs:false});unchanged();if(page.thread?.id!==choice.id||page.thread.title!==choice.title||page.thread.kind!=='codex'||page.thread.hostId!=='local')throw Error('任务身份无法核验，未切换。');
    this.store.transaction(()=>{db.prepare('INSERT INTO selected_project_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title').run(choice.id,choice.title);db.prepare('INSERT INTO task_catalog VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,state=excluded.state,checked_at=excluded.checked_at').run(choice.id,choice.title,page.thread.status?.type??'starting',now);db.prepare('UPDATE bindings SET target_id=? WHERE tenant_id=? AND chat_id=?').run(choice.id,tenant,chat);
     if(destination)db.prepare('INSERT INTO project_choices VALUES(?,?,?,0) ON CONFLICT(tenant,chat) DO UPDATE SET project_json=excluded.project_json,needs_task=0').run(tenant,chat,JSON.stringify(destination));else db.prepare('DELETE FROM project_choices WHERE tenant=? AND chat=?').run(tenant,chat);
     db.prepare('DELETE FROM global_selection_pending WHERE tenant=? AND chat=?').run(tenant,chat);bumpSelection(this.store,tenant,chat);});body=`已切换到「${choice.title}」。`;
   }
  }catch(e){failed=true;body=/^(列表|编号|选择|用法|项目|任务|请先)/.test(e.message)?e.message:'项目操作失败，请确认桌面连接后重试。';}finally{if(failed)this.client.close();}
  this.store.transaction(()=>{db.prepare('INSERT OR IGNORE INTO outbox(inbox_id,dedup_key,body) VALUES(?,?,?)').run(row.inbox_id,`project:${row.inbox_id}`,body??'操作未执行。');db.prepare('UPDATE project_commands SET done=1 WHERE inbox_id=?').run(row.inbox_id);});return true;
 }
}




