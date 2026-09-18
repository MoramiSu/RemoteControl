import {WakeSignal} from './wake-signal.mjs';
import {runWakeLoop} from './wake-loop.mjs';
import {ProjectWorker} from './projects.mjs';
import {validateDesktopConfig} from './desktop-config.mjs';
import {UsageWorker} from './usage.mjs';
import {ReplySender} from './reply-sender.mjs';
import {IncomingWorker} from './incoming-files.mjs';
import {CreationWorker} from './creation-worker.mjs';
import {CreationAdapter} from './creation-adapter.mjs';
import {DesktopAdapter,TEST_TARGET} from './desktop-adapter.mjs';
import {MultiWorker} from './multi-worker.mjs';
import {allowedTasks} from './targets.mjs';
import * as lark from '@larksuiteoapi/node-sdk';
import {readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {BridgeStore} from './store.ts';
import {ReceiveService} from './receive-service.mjs';
const privateUrl=new URL('../.private/',import.meta.url);
const config=JSON.parse(readFileSync(new URL('config.json',privateUrl),'utf8').replace(/^\uFEFF/,''));
validateDesktopConfig(config);
const secret=process.env.RC_APP_SECRET; delete process.env.RC_APP_SECRET;
if(!/^cli_[A-Za-z0-9]+$/.test(config.appId) || !secret || !['receive-only','desktop-test'].includes(config.mode)) throw new Error('Local setup missing or unsupported mode');
const lock=createServer(socket=>socket.destroy());
const lockPath='\\\\.\\pipe\\remotecontrol-feishu-'+createHash('sha256').update(config.appId).digest('hex').slice(0,24);
await new Promise((resolve,reject)=>{lock.once('error',()=>reject(new Error('A receiver for this app is already running, or the local lock is unavailable')));lock.listen(lockPath,resolve);});
const store=new BridgeStore(fileURLToPath(new URL('bridge.sqlite',privateUrl)));
store.db.exec('CREATE TABLE IF NOT EXISTS reply_attempts(outbox_id INTEGER PRIMARY KEY,first_at INTEGER NOT NULL,next_at INTEGER NOT NULL)');
store.db.exec('CREATE TABLE IF NOT EXISTS instance_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
if(!store.db.prepare('PRAGMA table_info(outbox)').all().some(c=>c.name==='wire_body'))store.db.exec('ALTER TABLE outbox ADD COLUMN wire_body TEXT');
const existingApp=store.db.prepare("SELECT value FROM instance_meta WHERE key='app_id'").get();
if(existingApp && existingApp.value!==config.appId)throw new Error('Database belongs to a different app');
store.db.prepare('INSERT OR IGNORE INTO instance_meta(key,value) VALUES(?,?)').run('app_id',config.appId);
store.db.prepare('INSERT OR IGNORE INTO instance_meta(key,value) VALUES(?,?)').run('instance_id',randomBytes(16).toString('hex'));
const instanceId=store.db.prepare("SELECT value FROM instance_meta WHERE key='instance_id'").get().value;
store.recover();
if(config.mode==='desktop-test'){
  if(config.targetThreadId!==TEST_TARGET)throw new Error('Only the dedicated test task is allowed');
  store.transaction(()=>{
    const activated=store.db.prepare("SELECT value FROM instance_meta WHERE key='desktop_test_activated'").get();
    if(!activated){
      store.db.prepare("UPDATE inbox SET delivery='cancelled',error='Received before desktop activation; not executed' WHERE delivery='queued'").run();
      store.db.prepare('INSERT INTO instance_meta(key,value) VALUES(?,?)').run('desktop_test_activated',String(Date.now()));
    }
  });
}
const worker=config.mode==='desktop-test'?new MultiWorker(store):null;
const creationAdapter=worker?new CreationAdapter():null;
const creator=creationAdapter?new CreationWorker(store,creationAdapter):null;creator?.recover();
let pairCode=randomBytes(16).toString('hex');
const pairExpires=Date.now()+10*60*1000;
let binding=store.db.prepare('SELECT * FROM bindings LIMIT 1').get();
if(binding && !allowedTasks(store).has(binding.target_id)) throw new Error('Existing target differs from configuration');
if(!binding) console.log('Pair within 10 minutes. Send this exact text in the bot private chat:\n/rc pair '+pairCode);
else console.log('Existing private-chat binding loaded.');
const silentLogger={error(){},warn(){},info(){},debug(){},trace(){}};
const client=new lark.Client({appId:config.appId,appSecret:secret,domain:lark.Domain.Feishu,logger:silentLogger});
const incoming=worker?new IncomingWorker(store,client,{instanceId,contextFor:async id=>{
  const adapter=new DesktopAdapter(id,allowedTasks(store));
  try{const page=await adapter.read();return {threadId:page.thread.id,cwd:page.thread.cwd,idle:['idle','notLoaded'].includes(page.thread.status?.type)};}finally{adapter.close();}
}}):null;
const usage=new UsageWorker(store,async()=>{const adapter=new DesktopAdapter();try{return await adapter.call('get_usage_limits',{});}finally{adapter.close();}});
const projectWorker=new ProjectWorker(store,new DesktopAdapter());
const projectSignal=new WakeSignal(),replySignal=new WakeSignal();
let lastOutboxId=store.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM outbox').get().id;
function wakeReplies(){const id=store.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM outbox').get().id;if(id!==lastOutboxId){lastOutboxId=id;replySignal.wake();}}
let ws,stopping=false,received=0,replies=0,sendFailures=0;
function saveStatus() {binding=store.db.prepare('SELECT * FROM bindings LIMIT 1').get();writeFileSync(new URL('status.json',privateUrl),JSON.stringify({updatedAt:new Date().toISOString(),mode:config.mode,desktop:worker?.stateFor(binding?.target_id)??'disabled',connection:ws?.getConnectionStatus().state??'starting',paired:!!binding,received,replies,sendFailures,targetThreadId:binding?.target_id??config.targetThreadId}));}
const service=new ReceiveService(store,{appId:config.appId,targetThreadId:config.targetThreadId,pairCode,expiresAt:pairExpires,mode:config.mode,getRuntime:(id)=>({desktop:worker?.stateFor(id),connection:ws?.getConnectionStatus().state})});
function receive(data) {
  const result=service.accept(data);binding=service.binding;
  if(result.accepted && !result.duplicate) {received++;projectSignal.wake();wakeReplies();console.log('Authorized message persisted.');}
}ws=new lark.WSClient({appId:config.appId,appSecret:secret,domain:lark.Domain.Feishu,logger:silentLogger,onReady(){console.log('Feishu long connection ready.');},onReconnecting(){console.log('Feishu reconnecting.');},onReconnected(){console.log('Feishu reconnected.');},onError(){console.error('Feishu connection failed. Check local credentials and app settings.');}});
const sender=new ReplySender(store,client,{appId:config.appId,instanceId,titleFor:id=>allowedTasks(store).get(id)??id});
function pump(){return runWakeLoop({signal:replySignal,stopped:()=>stopping,
  tick:async()=>{try{if(await sender.tick())replies++;}finally{saveStatus();}},
  cooldown:()=>sender.lastTickHadWork?1000:0,
  onError:()=>{sendFailures++;console.error('Local receipt or reply failed; pending record retained.');}
});}
async function work(){while(!stopping){try{if(worker)await worker.tick();}catch{console.error('Task worker failed; pending messages retained.');}wakeReplies();await new Promise(r=>setTimeout(r,1500));}}
async function createWork(){while(!stopping){try{await creator?.tick();}catch{console.error('Creation verification pending; no automatic recreation.');creationAdapter?.close();}wakeReplies();await new Promise(r=>setTimeout(r,1500));}}
async function incomingWork(){while(!stopping){try{await incoming?.tick();}catch{console.error('Attachment preparation pending; persisted record retained.');}wakeReplies();await new Promise(r=>setTimeout(r,1500));}}
async function usageWork(){while(!stopping){try{await usage.tick();}catch{console.error('Usage query pending.');}wakeReplies();await new Promise(r=>setTimeout(r,1000));}}
function projectWork(){return runWakeLoop({signal:projectSignal,stopped:()=>stopping,
  tick:async()=>{try{return await projectWorker.tick();}finally{wakeReplies();}},
  onError:()=>console.error('Project operation pending.')
});}
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{stopping=true;projectSignal.wake();replySignal.wake();ws.close();});
try {
  const dispatcher=new lark.EventDispatcher({logger:silentLogger}).register({'im.message.receive_v1':receive});
  await ws.start({eventDispatcher:dispatcher});
  await Promise.all([pump(),work(),createWork(),incomingWork(),usageWork(),projectWork()]);
} finally {ws.close();worker?.close();creationAdapter?.close();projectWorker.client.close();store.close();lock.close();}




