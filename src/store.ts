import {splitReplySource} from './reply-format.mjs';
import {initializeArtifacts,captureArtifacts} from './artifacts.mjs';
import {initializeIncoming,incomingBlocked} from './incoming-files.mjs';
import { DatabaseSync } from 'node:sqlite';

type Message = {messageId:string; tenantId:string; userId:string; chatId:string; text:string};
/** Prototype persistence only. The caller must hold the single receiver/worker lock. */
export class BridgeStore {
  db: DatabaseSync;
  constructor(path:string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bindings(tenant_id TEXT NOT NULL,chat_id TEXT NOT NULL,user_id TEXT NOT NULL,target_id TEXT NOT NULL,paused INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,chat_id));
      CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY,tenant_id TEXT NOT NULL,message_id TEXT NOT NULL,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,target_id TEXT NOT NULL,original_text TEXT NOT NULL,received_at INTEGER NOT NULL,delivery TEXT NOT NULL CHECK(delivery IN ('queued','delivering','delivered','delivery_unknown','delivery_failed','cancelled')),execution TEXT NOT NULL DEFAULT 'not_started',baseline_json TEXT,turn_id TEXT,error TEXT,UNIQUE(tenant_id,message_id));
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY,inbox_id INTEGER NOT NULL REFERENCES inbox(id),dedup_key TEXT NOT NULL UNIQUE,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent')),attempts INTEGER NOT NULL DEFAULT 0,remote_id TEXT);
      CREATE INDEX IF NOT EXISTS inbox_target_queue ON inbox(target_id,delivery,id);`);
    initializeArtifacts(this.db);
    initializeIncoming(this.db);
  }
  transaction<T>(action:()=>T):T { if(this.db.isTransaction) return action(); this.db.exec('BEGIN IMMEDIATE'); try {const value=action();this.db.exec('COMMIT');return value;} catch(e) {this.db.exec('ROLLBACK');throw e;} }
  bind(tenant:string,chat:string,user:string,target:string) {
    if (![tenant,chat,user,target].every(v=>typeof v==='string' && v.length>0)) throw new Error('Binding fields required');
    this.db.prepare('INSERT INTO bindings(tenant_id,chat_id,user_id,target_id) VALUES(?,?,?,?)').run(tenant,chat,user,target);
  }
  pause(tenant:string,chat:string,value:boolean) {this.db.prepare('UPDATE bindings SET paused=? WHERE tenant_id=? AND chat_id=?').run(value?1:0,tenant,chat);}
  receive(m:Message) {
    return this.transaction(()=>{
      const binding=this.db.prepare('SELECT * FROM bindings WHERE tenant_id=? AND chat_id=? AND user_id=?').get(m.tenantId,m.chatId,m.userId);
      if (!binding) throw new Error('Unbound or unauthorized sender');
      if (typeof m.text!=='string' || !m.messageId) throw new Error('Invalid message');
      const prior=this.db.prepare('SELECT * FROM inbox WHERE tenant_id=? AND message_id=?').get(m.tenantId,m.messageId);
      if (prior) {
        if(prior.original_text!==m.text || prior.user_id!==m.userId || prior.chat_id!==m.chatId) throw new Error('Conflicting duplicate');
        return {id:Number(prior.id),duplicate:true};
      }
      const result=this.db.prepare('INSERT INTO inbox(tenant_id,message_id,user_id,chat_id,target_id,original_text,received_at,delivery) VALUES(?,?,?,?,?,?,?,?)').run(m.tenantId,m.messageId,m.userId,m.chatId,binding.target_id,m.text,Date.now(),'queued');
      const id=Number(result.lastInsertRowid);
      this.db.prepare('INSERT INTO outbox(inbox_id,dedup_key,body) VALUES(?,?,?)').run(id,`received:${id}`,'已收到，已保存并进入队列。');
      return {id,duplicate:false};
    });
  }
  /** Persist the pre-send history before any desktop side effect. */
  claim(target:string, desktopIdle:boolean, baselineTurnIds:string[]) {
    if (!desktopIdle || !Array.isArray(baselineTurnIds) || !baselineTurnIds.every(x=>typeof x==='string')) return null;
    return this.transaction(()=>{
      const uncertain=this.db.prepare("SELECT id FROM inbox WHERE target_id=? AND (delivery IN ('delivering','delivery_unknown') OR (delivery='delivered' AND execution NOT IN ('completed','interrupted','failed'))) LIMIT 1").get(target);
      if(uncertain) return null;
      const next=this.db.prepare("SELECT i.* FROM inbox i JOIN bindings b ON i.tenant_id=b.tenant_id AND i.chat_id=b.chat_id WHERE i.target_id=? AND i.delivery='queued' AND b.paused=0 ORDER BY i.id LIMIT 1").get(target);
      if(!next) return null;
      if(incomingBlocked(this.db,Number(next.id))) return null;
      this.db.prepare("UPDATE inbox SET delivery='delivering',baseline_json=? WHERE id=? AND delivery='queued'").run(JSON.stringify(baselineTurnIds),next.id);
      return this.get(Number(next.id));
    });
  }
  markDelivery(id:number,state:'delivered'|'delivery_unknown'|'delivery_failed',turnId:string|null=null) {
    if (!['delivered','delivery_unknown','delivery_failed'].includes(state)) throw new Error('Invalid delivery state');
    if(state==='delivered' && !turnId) throw new Error('Verified turn required');
    const result=this.db.prepare("UPDATE inbox SET delivery=?,turn_id=?,execution=? WHERE id=? AND delivery='delivering'").run(state,turnId,state==='delivered'?'unknown':'not_started',id);
    if(Number(result.changes)!==1) throw new Error('Invalid delivery transition');
  }
  recordOutcome(id:number,turnId:string,state:'completed'|'interrupted'|'failed',text:string,artifactContext?:{threadId:string;cwd:string}) {
    if(!['completed','interrupted','failed'].includes(state)) throw new Error('Invalid terminal state');
    return this.transaction(()=>{
      const row=this.get(id);
      if(!row || row.delivery!=='delivered' || row.turn_id!==turnId) throw new Error('Outcome identity mismatch');
      if(['completed','interrupted','failed'].includes(String(row.execution)) && row.execution!==state) throw new Error('Conflicting terminal state');
      const key=`outcome:${id}:${turnId}`;
      const priorRows=this.db.prepare('SELECT body FROM outbox WHERE dedup_key=? OR dedup_key GLOB ? ORDER BY id').all(key,key+':part:*');
      const prior=priorRows.length?{body:priorRows.map(r=>String(r.body)).join('')}:null;
      if(prior && prior.body!==text) throw new Error('Conflicting final reply');
      this.db.prepare('UPDATE inbox SET execution=? WHERE id=?').run(state,id);
      if(prior) return; // Preserve previously persisted chunk boundaries across upgrades.
      let offset=0;
      for(const part of splitReplySource(text)){
        this.db.prepare('INSERT INTO outbox(inbox_id,dedup_key,body) VALUES(?,?,?) ON CONFLICT(dedup_key) DO NOTHING').run(id,offset===0?key:key+':part:'+offset,part);
        offset+=Array.from(part).length;
      }
      if(state==='completed')captureArtifacts(this,row,turnId,text,artifactContext);
    });
  }
  /** Call only at exclusive startup. Ambiguous desktop sends never become queued. */
  recover() { return this.transaction(()=>{
    const r=this.db.prepare("UPDATE inbox SET delivery='delivery_unknown',error='Restart during delivery; reconcile before any resend' WHERE delivery='delivering'").run();
    this.db.exec("UPDATE outbox SET status='pending' WHERE status='sending'");
    return Number(r.changes);
  }); }
  get(id:number) {return this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id);}
  pendingReplies() {return this.db.prepare("SELECT o.*,i.chat_id,i.tenant_id,i.target_id,i.delivery FROM outbox o JOIN inbox i ON i.id=o.inbox_id WHERE o.status='pending' ORDER BY o.id").all();}
  close() {this.db.close();}
}


