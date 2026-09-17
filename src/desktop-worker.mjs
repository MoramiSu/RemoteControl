import {confirmDelegatedDelivery} from './delivery-evidence.mjs';
import {TEST_TARGET,SOURCE} from './desktop-adapter.mjs';
import {verifyIncomingFile,failureText} from './incoming-files.mjs';
export class DesktopWorker {
  constructor(store,adapter,targetId=TEST_TARGET){Object.assign(this,{store,adapter,targetId});this.state='starting';}
  notify(id,key,text){this.store.db.prepare('INSERT INTO outbox(inbox_id,dedup_key,body) VALUES(?,?,?) ON CONFLICT(dedup_key) DO NOTHING').run(id,key,text);}
  verify(row,page){return confirmDelegatedDelivery({page,threadId:this.targetId,sourceThreadId:SOURCE,prompt:row.wire_text??row.original_text,baselineTurnIds:JSON.parse(row.baseline_json)});}
  delivered(row,evidence){this.store.transaction(()=>{
    this.store.db.prepare("UPDATE inbox SET delivery='delivered',turn_id=?,execution='unknown' WHERE id=? AND delivery IN ('delivering','delivery_unknown')").run(evidence.turnId,row.id);

  });}
  async tick(){
    const page=await this.adapter.read();
    const active=this.store.db.prepare("SELECT * FROM inbox WHERE target_id=? AND (delivery IN ('delivering','delivery_unknown') OR (delivery='delivered' AND execution NOT IN ('completed','interrupted','failed'))) ORDER BY id LIMIT 1").get(this.targetId);
    if(active){
      if(active.delivery!=='delivered'){
        const evidence=this.verify(active,page);
        if(evidence.status==='delivered')this.delivered(active,evidence);
        else {this.state='delivery_unknown';this.notify(active.id,`unknown:${active.id}`,'投递待核实，已暂停后续投递，不会自动重发。');return;}
      }
      const row=this.store.get(Number(active.id));const turn=page.turns.find(t=>t.id===row.turn_id);
      if(!turn){this.state='turn_missing';return;}
      if(['completed','interrupted','failed'].includes(turn.status)){
        const finals=(turn.items??[]).filter(i=>i.type==='agentMessage' && ['final_answer','final'].includes(i.phase));
        if(finals.some(i=>i.truncated || i.textTruncated || typeof i.text!=='string')){this.state='reply_incomplete';this.notify(row.id,`incomplete:${row.id}`,'任务已结束，但完整回复待核实，暂未回传正文。');return;}
        const text=turn.status==='interrupted'?'任务已停止：已确认 interrupted。':turn.status==='failed'?'任务执行失败。请在对应任务中查看具体原因。':finals.map(i=>i.text).join('\n\n');
        if(turn.status==='completed' && !text){this.state='reply_pending';return;}
        this.store.recordOutcome(Number(row.id),row.turn_id,turn.status,text,page.artifactContexts?.[row.turn_id]);
        this.state=turn.status;return;
      }
      this.state='running';
      if(page.thread.status?.activeFlags?.length){this.state='needs_attention';this.notify(row.id,`attention:${row.id}`,'Codex 有待处理状态，请在桌面查看；程序不会代为批准。');}
      return;
    }
    const idle=['idle','notLoaded'].includes(page.thread.status?.type);
    this.state=idle?'idle':'busy';
    const row=this.store.claim(this.targetId,idle,page.turns.map(t=>t.id));if(!row)return;
    this.state='delivering';
    try{verifyIncomingFile(this.store,row);}catch(e){this.store.markDelivery(Number(row.id),'delivery_failed');this.store.pause(row.tenant_id,row.chat_id,true);this.notify(row.id,`incoming-changed:${row.id}`,`附件未送达：${failureText(e.reason??'file_changed')}。已暂停后续投递，请核对后用 /rc resume 恢复。`);return;}
    if(row.original_text.length>12000){this.store.markDelivery(Number(row.id),'delivery_failed');this.notify(row.id,"oversize:"+row.id,'消息过长，本轮未投递；请拆分后发送。');return;}
    try {
      // No retry around this side effect, including timeout or connection loss.
      await this.adapter.send(row.wire_text??row.original_text);
      const after=await this.adapter.read();const evidence=this.verify(row,after);
      if(evidence.status==='delivered')this.delivered(row,evidence);
      else this.store.markDelivery(Number(row.id),'delivery_unknown');
    } catch {
      if(this.store.get(Number(row.id)).delivery==='delivering')this.store.markDelivery(Number(row.id),'delivery_unknown');
    }
  }
}




