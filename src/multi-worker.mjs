import {DesktopAdapter} from './desktop-adapter.mjs';
import {DesktopWorker} from './desktop-worker.mjs';
import {allowedTasks} from './targets.mjs';
import {initializeTasks} from './tasks.mjs';
export class MultiWorker {
 constructor(store){this.store=store;initializeTasks(store);this.workers=new Map();this.sync();}
 sync(){this.allowed=allowedTasks(this.store);for(const[id]of this.allowed)if(!this.workers.has(id))this.workers.set(id,new DesktopWorker(this.store,new DesktopAdapter(id,this.allowed),id));}
 stateFor(id){return this.workers.get(id)?.state??'disabled';}
 async tick(){this.sync();await Promise.allSettled([...this.workers].map(async([id,worker])=>{
  try {await worker.tick();} catch {worker.state='connection_error';worker.adapter.close();
   const rows=this.store.db.prepare("SELECT id FROM inbox WHERE target_id=? AND (delivery IN ('queued','delivering','delivery_unknown') OR (delivery='delivered' AND execution NOT IN ('completed','interrupted','failed')))").all(id);
   for(const row of rows)worker.notify(row.id,`connection:${row.id}`,'对应 Codex 任务暂时无法核验，已保留消息并等待连接恢复；未重新投递。');
  }
  this.store.db.prepare('INSERT INTO task_catalog VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,state=excluded.state,checked_at=excluded.checked_at').run(id,this.allowed.get(id),worker.state,Date.now());
 }));}
 close(){for(const worker of this.workers.values())worker.adapter.close();}
}
