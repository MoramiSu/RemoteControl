// Prepared stop controller. Enable only after a same-task transport is verified.
export function initializeStops(store) {
 store.db.exec(`CREATE TABLE IF NOT EXISTS stop_requests(inbox_id INTEGER PRIMARY KEY REFERENCES inbox(id),target_id TEXT NOT NULL,turn_id TEXT,state TEXT NOT NULL CHECK(state IN ('requested','dispatched','confirmed','finished','failed','unknown')),expires_at INTEGER NOT NULL)`);
}
export function requestStop(store,inboxId,target,now=Date.now()) {
 return store.transaction(()=>{
  const row=store.get(inboxId);
  if(!row || row.target_id!==target || row.original_text!=='/rc stop')throw Error('invalid_stop_request');
  const inserted=store.db.prepare("INSERT OR IGNORE INTO stop_requests VALUES(?,?,NULL,'requested',?)").run(inboxId,target,now+60000);
  if(!inserted.changes)return;
  store.db.prepare("UPDATE inbox SET delivery='cancelled' WHERE id=?").run(inboxId);
  // A stop must not be immediately followed by another queued task.
  store.pause(row.tenant_id,row.chat_id,true);
  store.db.prepare('UPDATE outbox SET body=? WHERE inbox_id=?').run('已收到停止请求，已暂停后续投递；正在核对当前任务。恢复请发送 /rc resume。',inboxId);
 });
}
export class StopWorker {
 constructor(store,adapter,target,transport){Object.assign(this,{store,adapter,target,transport});initializeStops(store);}
 finish(row,state,text) {
  this.store.transaction(()=>{
   this.store.db.prepare('UPDATE stop_requests SET state=? WHERE inbox_id=?').run(state,row.inbox_id);
   this.store.db.prepare('INSERT OR IGNORE INTO outbox(inbox_id,dedup_key,body) VALUES(?,?,?)').run(row.inbox_id,`stop-result:${row.inbox_id}`,text);
  });
 }
 async tick(now=Date.now()) {
  const row=this.store.db.prepare("SELECT * FROM stop_requests WHERE target_id=? AND state IN ('requested','dispatched') ORDER BY inbox_id LIMIT 1").get(this.target);
  if(!row)return false;
  if(now>=row.expires_at){this.finish(row,'unknown','停止结果待核实；不会自动重试，后续投递保持暂停。请在桌面检查。');return true;}
  let page;
  try { page=await this.adapter.read(); } catch {return true;}
  if(page.thread?.id!==this.target){this.finish(row,'failed','无法确认绑定任务身份，未继续停止操作；请在桌面检查。');return true;}
  if(row.state==='dispatched') {
   const turn=page.turns.find(t=>t.id===row.turn_id);
   if(turn?.status==='interrupted')this.finish(row,'confirmed','已停止：已确认目标轮次 interrupted。后续投递仍暂停，恢复请发送 /rc resume。');
   else if(['completed','failed'].includes(turn?.status))this.finish(row,'finished','目标轮次已结束，但没有确认是停止操作导致。后续投递仍暂停。');
   return true;
  }
  const active=page.turns.filter(t=>t.status==='inProgress');
  if(active.length===0 && ['idle','notLoaded'].includes(page.thread.status?.type)) {this.finish(row,'finished','当前没有正在执行的轮次，无需停止。后续投递已暂停。');return true;}
  if(active.length!==1){this.finish(row,'failed','无法唯一识别执行中的轮次，未点击停止。后续投递保持暂停。');return true;}
  if(!this.transport){this.finish(row,'failed','停止通道尚未通过验证，未点击停止。请在桌面停止；后续投递已暂停。');return true;}
  // Persist the exact turn before the side effect; recovery only observes it.
  this.store.db.prepare("UPDATE stop_requests SET state='dispatched',turn_id=? WHERE inbox_id=?").run(active[0].id,row.inbox_id);
  try {await this.transport({threadId:this.target,turnId:active[0].id});} catch { /* May already have clicked: read and confirm, never replay. */ }
  return true;
 }
}
