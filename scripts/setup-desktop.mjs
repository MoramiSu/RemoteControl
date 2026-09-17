import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {discoverSetupTasks,verifySetupChoice} from '../src/setup-discovery.mjs';
try{
const path=new URL('../.private/config.json',import.meta.url);
const config=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
if(config.sourceThreadId&&config.targetThreadId&&config.targetTitle){console.log('已有会话配置，保持不变。');process.exit(0);}
if(existsSync(new URL('../.private/bridge.sqlite',import.meta.url)))throw Error('检测到旧绑定但配置不完整，请手动迁移，向导不会覆盖。');
console.log('正在读取 Codex 会话列表……');
const found=await discoverSetupTasks();
found.tasks.forEach((t,i)=>console.log(`${i+1}. ${t.title.replace(/[\r\n\x00-\x1f\x7f]/g,' ').slice(0,130)}`));
const rl=createInterface({input:process.stdin,output:process.stdout});
try{
 const answer=(await rl.question('请选择要遥控的会话编号（会话标题仅供选择）：')).trim();
 if(!/^[1-9][0-9]*$/.test(answer))throw Error('请填写列表中的数字编号');
 const selected=await verifySetupChoice(found,Number(answer)-1);
 const temp=new URL('../.private/config.setup.tmp',import.meta.url);
 writeFileSync(temp,JSON.stringify({...config,...selected,mode:'desktop-test'},null,2));
 renameSync(temp,path);
 console.log('已核验并保存会话，接下来启动飞书配对。');
}finally{rl.close();}
}catch(error){console.error(error.message);process.exitCode=1;}
