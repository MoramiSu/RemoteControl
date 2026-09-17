import {createHash} from 'node:crypto';
import {buildReplyPlan,textChunks} from './reply-format.mjs';
import {renderMermaid} from './mermaid-renderer.mjs';
import {artifactPlan,artifactReady} from './artifacts.mjs';

export class ReplySender {
  constructor(store,client,{appId,instanceId,titleFor,render=renderMermaid,now=Date.now}){
    Object.assign(this,{store,client,appId,instanceId,titleFor,render,now});
    store.db.exec(`CREATE TABLE IF NOT EXISTS reply_preparations(outbox_id INTEGER PRIMARY KEY REFERENCES outbox(id));
      CREATE TABLE IF NOT EXISTS reply_payloads(outbox_id INTEGER NOT NULL REFERENCES outbox(id),part TEXT NOT NULL,
        msg_type TEXT NOT NULL,content TEXT NOT NULL,fallback_text TEXT,uuid TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',first_at INTEGER,next_at INTEGER,remote_id TEXT,error TEXT,
        PRIMARY KEY(outbox_id,part));
      CREATE TABLE IF NOT EXISTS reply_attempts(outbox_id INTEGER PRIMARY KEY,first_at INTEGER NOT NULL,next_at INTEGER NOT NULL);`);
    if(!store.db.prepare('PRAGMA table_info(outbox)').all().some(c=>c.name==='wire_body'))store.db.exec('ALTER TABLE outbox ADD COLUMN wire_body TEXT');
  }
  uuid(row,suffix=''){return createHash('sha256').update(this.appId+':'+this.instanceId+':'+row.dedup_key+suffix).digest('hex').slice(0,32);}
  async prepare(row){
    const db=this.store.db;if(db.prepare('SELECT 1 FROM reply_preparations WHERE outbox_id=?').get(row.id))return;
    const title=this.titleFor(row.target_id),wireBody=row.wire_body??(row.delivery==='cancelled'?row.body:`【${title}】\n${row.body}`);
    db.prepare('UPDATE outbox SET wire_body=? WHERE id=? AND wire_body IS NULL').run(wireBody,row.id);
    const legacy=db.prepare('SELECT * FROM reply_attempts WHERE outbox_id=?').get(row.id);
    // Never change the type, body or UUID of a send attempted by an older receiver.
    let plan;
    if(row.artifact_id){plan=await artifactPlan(this.store,row,this.client,title,this.now());}
    else if(!legacy&&row.dedup_key.startsWith('outcome:')){
      plan=await buildReplyPlan(row.body,title,{render:this.render,upload:async png=>{
        try{const result=await this.client.im.image.create({data:{image_type:'message',image:png}});return result?.image_key;}
        catch(error){const failure=Error('Image upload failed');if(error?.response?.data?.code===99991672)failure.kind='upload_permission';throw failure;}
      }});
    }else plan=[{msg_type:'text',content:JSON.stringify({text:wireBody}),fallback:null}];
    this.store.transaction(()=>{
      plan.forEach((item,i)=>db.prepare('INSERT INTO reply_payloads(outbox_id,part,msg_type,content,fallback_text,uuid,first_at,next_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id,String(i).padStart(6,'0'),item.msg_type,item.content,item.fallback??null,this.uuid(row,legacy?'':`:format-v1:${i}`),legacy?.first_at??null,legacy?.next_at??null));
      db.prepare('INSERT INTO reply_preparations(outbox_id) VALUES(?)').run(row.id);
    });
  }
  fallback(row,payload){
    // Only invoked for an explicit content rejection. Timeouts keep the original payload.
    const parts=textChunks('格式化消息被飞书拒绝，以下为文字版：\n'+payload.fallback_text);
    this.store.transaction(()=>{
      this.store.db.prepare("UPDATE reply_payloads SET status='replaced',error='format_rejected' WHERE outbox_id=? AND part=?").run(row.id,payload.part);
      parts.forEach((text,i)=>{
        const part=payload.part+'/text/'+String(i).padStart(6,'0');
        this.store.db.prepare('INSERT INTO reply_payloads(outbox_id,part,msg_type,content,uuid) VALUES(?,?,?,?,?)').run(row.id,part,'text',JSON.stringify({text}),this.uuid(row,`:format-v1:${part}`));
      });
    });
  }
  async tick(){
    const db=this.store.db,now=this.now();
    // An expired ambiguous reply must not block every later receipt in the chat.
    const blocked=new Set();
    const row=this.store.pendingReplies().find(row=>{
      if(blocked.has(row.inbox_id))return false;
      if(!artifactReady(db,row,now)){blocked.add(row.inbox_id);return false;}
      const p=db.prepare("SELECT * FROM reply_payloads WHERE outbox_id=? AND status='pending' ORDER BY part LIMIT 1").get(row.id);
      const ready=!p||p.first_at==null||(now>=p.next_at&&now-p.first_at<300000);
      if(!ready)blocked.add(row.inbox_id);return ready;
    });
    if(!row)return false;
    await this.prepare(row);
    const p=db.prepare("SELECT * FROM reply_payloads WHERE outbox_id=? AND status='pending' ORDER BY part LIMIT 1").get(row.id);
    if(p){
      if(p.first_at!=null&&(now<p.next_at||now-p.first_at>=300000))return false;
      db.prepare('UPDATE reply_payloads SET first_at=COALESCE(first_at,?),next_at=? WHERE outbox_id=? AND part=?').run(now,now+15000,row.id,p.part);
      let result;
      try{result=await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:row.chat_id,msg_type:p.msg_type,content:p.content,uuid:p.uuid}});}
      catch(error){
        // SDK may reject HTTP 400 with the explicit API error in response.data.
        const rejected=error?.response?.data;
        if(p.fallback_text&&rejected?.code===230001&&!rejected?.data?.message_id){this.fallback(row,p);return false;}
        throw Error('Reply send unconfirmed');
      }
      if(result?.code!==0||!result?.data?.message_id){
        if(p.fallback_text&&result?.code===230001&&!result?.data?.message_id){this.fallback(row,p);return false;}
        throw Error('Reply send unconfirmed');
      }
      db.prepare("UPDATE reply_payloads SET status='sent',remote_id=? WHERE outbox_id=? AND part=?").run(result.data.message_id,row.id,p.part);
    }
    const remaining=db.prepare("SELECT 1 FROM reply_payloads WHERE outbox_id=? AND status='pending'").get(row.id);
    if(!remaining){this.store.transaction(()=>{
      db.prepare("UPDATE outbox SET status='sent',attempts=attempts+1,remote_id=(SELECT remote_id FROM reply_payloads WHERE outbox_id=? AND status='sent' ORDER BY part DESC LIMIT 1) WHERE id=?").run(row.id,row.id);
      if(row.artifact_id){
        const replaced=db.prepare("SELECT 1 FROM reply_payloads WHERE outbox_id=? AND status='replaced'").get(row.id);
        db.prepare("UPDATE reply_artifacts SET state=?,error=?,bytes=NULL WHERE id=? AND state='uploaded'").run(replaced?'failed':'sent',replaced?'message_rejected':null,row.artifact_id);
      }
    });return true;}
    return false;
  }
}
