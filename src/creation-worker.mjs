import {selectedProject} from './projects.mjs';
import {initializeTasks,selectionRevision,bumpSelection} from './tasks.mjs';
export function pendingCreation(store,tenant,chat){return store.db.prepare("SELECT c.* FROM creation_requests c JOIN inbox i ON i.id=c.inbox_id WHERE i.tenant_id=? AND i.chat_id=? AND c.state IN ('pending','creating','verifying') AND c.base_revision=? LIMIT 1").get(tenant,chat,selectionRevision(store,tenant,chat));}
export function queueCreation(store,id,m,now){
 const title=m.text.slice('/rc new'.length).trim();
 if(!title || Array.from(title).length>60 || /[\x00-\x1f\x7f]/.test(title))return '用法：/rc new 任务名称（1–60 个字符，不能换行）。';
 if(store.db.prepare("SELECT c.inbox_id FROM creation_requests c JOIN inbox i ON i.id=c.inbox_id WHERE i.tenant_id=? AND i.chat_id=? AND c.state IN ('pending','creating','verifying')").get(m.tenantId,m.chatId))return '已有创建请求正在处理，请等待创建结果。';
 const project=selectedProject(store,m.tenantId,m.chatId);
 store.db.prepare("INSERT INTO creation_requests(inbox_id,requested_title,state,base_revision,created_at,project_json) VALUES(?,?,'pending',?,?,?)").run(id,title,selectionRevision(store,m.tenantId,m.chatId),now,project?JSON.stringify(project):null);
 return `已收到创建「${title}」的请求。${project?`在项目「${project.label}」中新建`:'创建独立本地任务'}；请等“已创建并切换”后再发送正文，期间普通消息不会投递。`;
}
export class CreationWorker {
 constructor(store,adapter){Object.assign(this,{store,adapter});initializeTasks(store);}
 notify(row,text){this.store.db.prepare('INSERT OR IGNORE INTO outbox(inbox_id,dedup_key,body) VALUES(?,?,?)').run(row.inbox_id,`creation:${row.inbox_id}`,text);}
 finish(row,state,text){this.store.transaction(()=>{this.store.db.prepare('UPDATE creation_requests SET state=? WHERE inbox_id=?').run(state,row.inbox_id);this.notify(row,text);});}
 uncertain(row){this.finish(row,'unknown',`创建结果待核实（请求 ${row.inbox_id}），可能已经创建，不会自动重试。请先在桌面核对，避免重复新建。`);}
 recover(){for(const row of this.store.db.prepare("SELECT * FROM creation_requests WHERE state='creating'").all())this.uncertain(row);}
 async tick(now=Date.now()){
  let row=this.store.db.prepare("SELECT c.*,i.tenant_id,i.chat_id,i.user_id FROM creation_requests c JOIN inbox i ON i.id=c.inbox_id WHERE c.state IN ('pending','verifying') ORDER BY c.inbox_id LIMIT 1").get();
  if(!row)return;
  if(now-row.created_at>=300000){this.finish(row,'failed',row.thread_id?`任务已返回 ID ${row.thread_id}，但未能核验，未切换。请在桌面检查；不会重复创建。`:'连接 Codex 超时，尚未调用创建，未切换任务。请恢复连接后重新发送命令。');return;}
  if(row.state==='pending'){
   try{await this.adapter.prepare(row.project_json?JSON.parse(row.project_json):null);}catch{this.adapter.close?.();return;}
   this.store.db.prepare("UPDATE creation_requests SET state='creating' WHERE inbox_id=?").run(row.inbox_id);
   let result;
   try{result=await this.adapter.create(row.requested_title,row.project_json?JSON.parse(row.project_json):null);}catch{this.uncertain(row);return;}
   if(!result.threadId&&typeof result.clientThreadId==='string'){
    this.store.db.prepare('UPDATE creation_requests SET client_thread_id=? WHERE inbox_id=?').run(result.clientThreadId,row.inbox_id);
    this.finish(row,'unknown','已提交后台创建，工作目录仍在准备；尚未绑定，不会重复创建。请稍后 /rc tasks 选择新任务。');return;
   }
   if(typeof result.threadId!=='string'||!/^[-a-f0-9]{36}$/.test(result.threadId)||(result.hostId&&result.hostId!=='local')){this.uncertain(row);return;}
   this.store.db.prepare("UPDATE creation_requests SET state='verifying',thread_id=? WHERE inbox_id=?").run(result.threadId,row.inbox_id);
   row={...row,state:'verifying',thread_id:result.threadId};
  }
  let page;
  try{page=await this.adapter.readCreated(row.thread_id,row.project_json?JSON.parse(row.project_json):null);}catch{return;}
  if(page.thread?.id!==row.thread_id || page.thread.kind!=='codex' || page.thread.hostId!=='local' || typeof page.thread.title!=='string' || !page.thread.title.trim())return;
  this.store.transaction(()=>{
   const title=page.thread.title;
   this.store.db.prepare('INSERT INTO authorized_tasks VALUES(?,?,?)').run(row.thread_id,title,row.inbox_id);
   this.store.db.prepare('INSERT INTO task_catalog VALUES(?,?,?,?)').run(row.thread_id,title,page.thread.status?.type??'starting',now);
   const switched=selectionRevision(this.store,row.tenant_id,row.chat_id)===row.base_revision;
   if(switched){this.store.db.prepare('DELETE FROM global_selection_pending WHERE tenant=? AND chat=?').run(row.tenant_id,row.chat_id);if(row.project_json)this.store.db.prepare('UPDATE project_choices SET needs_task=0 WHERE tenant=? AND chat=?').run(row.tenant_id,row.chat_id);this.store.db.prepare('UPDATE bindings SET target_id=? WHERE tenant_id=? AND chat_id=? AND user_id=?').run(row.thread_id,row.tenant_id,row.chat_id,row.user_id);bumpSelection(this.store,row.tenant_id,row.chat_id);}
   this.store.db.prepare("UPDATE creation_requests SET state='completed',title=? WHERE inbox_id=?").run(title,row.inbox_id);
   const paused=this.store.db.prepare('SELECT paused FROM bindings WHERE tenant_id=? AND chat_id=?').get(row.tenant_id,row.chat_id)?.paused;
   this.notify(row,switched?`已创建并切换到「${title}」。可以发送任务正文。${paused?'遥控仍暂停，发送 /rc resume 后才会投递。':''}`:`已创建「${title}」并加入任务列表。你在创建期间切换了任务，已保留最新选择；可用 /rc tasks 查看。`);
  });
 }
}

