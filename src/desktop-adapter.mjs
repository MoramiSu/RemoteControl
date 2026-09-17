import {supplementFromLocalRollout} from './rollout-evidence.mjs';
import {spawn,execFile} from 'node:child_process';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
import {TEST_TARGET,ALLOWED_TASKS} from './targets.mjs';
export {TEST_TARGET};
export {sourceThreadId as SOURCE} from './desktop-config.mjs';
import {sourceThreadId as SOURCE} from './desktop-config.mjs';
export class DesktopAdapter {
  constructor(targetId=TEST_TARGET,allowed=ALLOWED_TASKS,sourceThreadId=SOURCE){this.sourceThreadId=sourceThreadId;this.allowed=allowed;if(!allowed.has(targetId))throw Error('target_not_allowed');this.targetId=targetId;this.pending=new Map();this.seq=0;this.child=null;}
  close(){const c=this.child;this.child=null;c?.kill();for(const p of this.pending.values())p.reject(new Error('desktop_connection_closed'));this.pending.clear();}
  async connect(){
    if(this.child)return;
    const {stdout}=await run('powershell.exe',['-NoProfile','-ExecutionPolicy','RemoteSigned','-File',fileURLToPath(new URL('../scripts/discover-desktop.ps1',import.meta.url))],{windowsHide:true,timeout:15000});
    const endpoint=JSON.parse(stdout.replace(/^\uFEFF/,''));
    let lastError;
    for(const pipe of endpoint.pipes??[endpoint.pipe]){
    const child=spawn(process.execPath,[endpoint.server],{env:{...process.env,CODEX_APP_TOOLS_PIPE_PATH:pipe},stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child=child;child.stderr.resume();
    child.on('error',()=>{if(this.child===child)this.close();});child.on('exit',()=>{if(this.child===child)this.close();});
    createInterface({input:child.stdout}).on('line',line=>{
      try{const m=JSON.parse(line);const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);m.error?p.reject(new Error('desktop_rpc_error')):p.resolve(m.result);}}catch{this.close();}
    });
    try{await this.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'remotecontrol-local-test',version:'0.1.0'}});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
      const catalog=await this.request('tools/list',{});
      for(const name of ['read_thread','send_message_to_thread'])if(!catalog.tools.some(t=>t.name===name))throw new Error('desktop_tool_missing');
      return;
    }catch(e){this.close();lastError=e;}
    }
    throw lastError??Error('desktop_endpoint_unavailable');
  }
  request(method,params){const id=++this.seq;return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('desktop_timeout'));this.close();},20000);
    this.pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
    if(!this.child){this.pending.get(id).reject(new Error('desktop_disconnected'));this.pending.delete(id);return;}
    this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',e=>{if(e)this.close();});
  });}
  async call(name,args){await this.connect();const result=await this.request('tools/call',{name,arguments:args,_meta:{'openai/threadId':this.sourceThreadId}});if(result.isError)throw new Error('desktop_tool_failed');return JSON.parse(result.content.find(c=>c.type==='text').text);}
  async read(){
    let cursor;let page;const turns=[];
    for(let n=0;n<100;n++){
      const p=await this.call('read_thread',{threadId:this.targetId,turnLimit:10,includeOutputs:true,maxOutputCharsPerItem:20000,...(cursor?{cursor}:{})});
      if(p.thread?.id!==this.targetId || p.thread.title!==this.allowed.get(this.targetId))throw new Error('desktop_identity_mismatch');
      page??=p;turns.push(...p.turns);
      if(!p.page.hasMore)return supplementFromLocalRollout({...page,turns});
      if(!p.page.nextCursor || p.page.nextCursor===cursor)throw new Error('desktop_cursor_invalid');cursor=p.page.nextCursor;
    }
    throw new Error('desktop_history_incomplete');
  }
  async send(text){return this.call('send_message_to_thread',{threadId:this.targetId,prompt:text});}
}



