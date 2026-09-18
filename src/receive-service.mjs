import {selectedProject,queueProjectCommand,globalSelectionPending} from './projects.mjs';
import {initializeUsage} from './usage.mjs';
import {queueCreation,pendingCreation} from './creation-worker.mjs';
import {initializeTasks,taskTitle} from './tasks.mjs';

import {statusText} from './status.mjs';
import {parseMessageEvent,classify} from './feishu-events.mjs';
import {registerIncoming,failureText} from './incoming-files.mjs';
export class ReceiveService {
  constructor(store,{appId,targetThreadId,pairCode,expiresAt,mode="receive-only",getRuntime=()=>({})}) {Object.assign(this,{store,appId,targetThreadId,pairCode,expiresAt,mode,getRuntime});initializeTasks(store);initializeUsage(store);this.binding=store.db.prepare('SELECT * FROM bindings LIMIT 1').get();}
  accept(data,now=Date.now()) {
    const m=parseMessageEvent(data,this.appId);if(!m)return {accepted:false};
    this.binding=this.store.db.prepare('SELECT * FROM bindings LIMIT 1').get();
    const b=this.binding;
    const pairing=!b;
    if(pairing) {if(now>this.expiresAt || m.text!=='/rc pair '+this.pairCode)return {accepted:false};}
    else if(b.tenant_id!==m.tenantId || b.user_id!==m.userId || b.chat_id!==m.chatId)return {accepted:false};
    const result=this.store.transaction(()=>{
      if(pairing)this.store.bind(m.tenantId,m.chatId,m.userId,this.targetThreadId);
      const prior=this.store.db.prepare('SELECT original_text FROM inbox WHERE tenant_id=? AND message_id=?').get(m.tenantId,m.messageId);
      // A repeated pairing event must not persist the one-time code.
      if(prior?.original_text==='/rc pair [redacted]')return {id:null,duplicate:true};
      const received=this.store.receive(pairing?{...m,text:'/rc pair [redacted]'}:m);
      if(received.duplicate)return received;
      const project=selectedProject(this.store,m.tenantId,m.chatId);
      const globalPending=globalSelectionPending(this.store,m.tenantId,m.chatId);
      const selectionPending=this.store.db.prepare("SELECT 1 FROM project_commands c JOIN inbox i ON i.id=c.inbox_id WHERE c.done=0 AND c.command IN ('project','use') AND i.tenant_id=? AND i.chat_id=? LIMIT 1").get(m.tenantId,m.chatId);
      const command=pairing?'pair':m.attachment?'attachment':classify(m.text);
      const waiting=this.store.db.prepare("SELECT 1 FROM inbox WHERE id<? AND target_id=? AND (delivery IN ('queued','delivering','delivery_unknown') OR (delivery='delivered' AND execution NOT IN ('completed','interrupted','failed'))) LIMIT 1").get(received.id,b?.target_id??this.targetThreadId);
      const runtime=this.getRuntime(b?.target_id??this.targetThreadId);
      const busy=waiting||['busy','running','delivering','needs_attention','delivery_unknown','connection_error'].includes(runtime.desktop);
      const suffix=b?.paused?'遥控已暂停。':busy?'已排队。':'';
      let body=this.mode==='desktop-test'?`已收到。${suffix}`:'已收到；当前仅收件，不投递。';
      if(command!=='text'&&command!=='attachment') {
        this.store.db.prepare("UPDATE inbox SET delivery='cancelled' WHERE id=?").run(received.id);
        body=command==='pair'?'配对成功。当前只测试收件，不执行 Codex 任务。':command==='status'?'连接正常；仅收件模式；已绑定阶段0测试任务。':command==='pause'?'已暂停新消息投递。':command==='resume'?'当前仍为收件测试模式，尚未开启 Codex 投递。':'此控制操作尚未接入常驻程序，未执行。';
        if(command==='status' && this.mode==='desktop-test')body=statusText(this.store,b.target_id,this.getRuntime(b.target_id));
        if(command==='resume' && this.mode==='desktop-test'){this.store.pause(m.tenantId,m.chatId,false);body='已恢复新消息投递。';}
        if(command==='new')body=selectionPending?'项目或任务仍在切换，请等结果后再新建。':this.mode==='desktop-test'?queueCreation(this.store,received.id,m,now):'收件测试模式暂不创建任务。';
        if(command==='current')body=`当前任务：「${taskTitle(this.store,b.target_id)}」` ;
        if(command==='help')body='/rc projects 项目列表\n/rc project 编号 选择项目\n/rc project 0 返回全局\n/rc new 名称 在所选项目新建（未选则独立任务）\n/rc tasks 当前范围的会话（全局仅独立会话）\n/rc task 2 切换任务\n/rc current 当前任务\n/rc status 状态\n/rc usage 剩余用量\n/rc pause 暂停\n/rc resume 恢复\n可先发送图片或文件（单个20 MB以内），再发送处理要求。\n普通消息原样投递；停止和截图未启用。';
        if(command==='usage'){this.store.db.prepare('INSERT INTO usage_requests(inbox_id) VALUES(?)').run(received.id);body='正在查询当前账户剩余用量。';}
        if(command==='pause')this.store.pause(m.tenantId,m.chatId,true);
      }
      if(command==='current'&&!project)body=globalPending?'global 全局模式：待选择独立会话。':'global 全局模式\n'+body;
      if(command==='current'&&project)body='项目：'+project.label+(project.needsTask?'（待选择任务）':'')+'\n'+body;
      const projectCommand=['projects','project','tasks','use'].includes(command);
      if(projectCommand){queueProjectCommand(this.store,received.id,command,m);body='正在查询。';}
      if(command==='attachment'){
        const error=registerIncoming(this.store,received.id,m.attachment);
        body=error?`附件未投递：${failureText(error)}。`:`已收到附件，待下载。${suffix}可发送处理要求。`;
        if(this.mode!=='desktop-test'){this.store.db.prepare("UPDATE inbox SET delivery='cancelled' WHERE id=?").run(received.id);body='附件消息已保存；收件测试模式不下载或投递附件。';}
      }
      if(['text','attachment'].includes(command) && pendingCreation(this.store,m.tenantId,m.chatId)){this.store.db.prepare("UPDATE inbox SET delivery='cancelled' WHERE id=?").run(received.id);body='新任务仍在创建，本条消息已保存但未投递。请等创建成功后重新发送。';}
      if(['text','attachment'].includes(command)&&(project?.needsTask||globalPending||selectionPending)){this.store.db.prepare("UPDATE inbox SET delivery='cancelled' WHERE id=?").run(received.id);body='请等项目切换完成，并 /rc tasks 选择任务或 /rc new 名称 新建；本条未投递。';}
      this.store.db.prepare('UPDATE outbox SET body=? WHERE inbox_id=?').run(body,received.id);
      // This receipt was just inserted in this transaction and has never been sent.
      if(command==='usage'||projectCommand)this.store.db.prepare('DELETE FROM outbox WHERE inbox_id=? AND dedup_key=?').run(received.id,`received:${received.id}`);
      return received;
    });
    this.binding=this.store.db.prepare('SELECT * FROM bindings LIMIT 1').get();
    if(pairing){this.binding=this.store.db.prepare('SELECT * FROM bindings LIMIT 1').get();this.pairCode='';}
    return {accepted:true,...result};
  }
}








