import {existsSync,readFileSync} from 'node:fs';
// Installation-specific identifiers must stay in private configuration.
const path=new URL('../.private/config.json',import.meta.url);
export const desktopConfig=existsSync(path)?JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,'')):{};
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export function validateDesktopConfig(config){
 if(!uuid.test(config.sourceThreadId??'')||!uuid.test(config.targetThreadId??'')||typeof config.targetTitle!=='string'||!config.targetTitle.trim())throw Error('Configure sourceThreadId, targetThreadId and targetTitle in .private/config.json');
 for(const task of config.bootstrapTasks??[])if(!uuid.test(task.id??'')||typeof task.title!=='string'||!task.title.trim())throw Error('Invalid bootstrap task');
}
// Synthetic identifiers allow offline tests without an account configuration.
export const sourceThreadId=desktopConfig.sourceThreadId??'00000000-0000-4000-8000-000000000001';
export const initialTasks=desktopConfig.targetTitle?[
 {id:desktopConfig.targetThreadId,title:desktopConfig.targetTitle},
 ...(desktopConfig.bootstrapTasks??[]).filter(t=>t.id!==desktopConfig.targetThreadId)
]:[
 {id:'00000000-0000-4000-8000-000000000002',title:'RemoteControl 阶段0测试'},
 {id:'00000000-0000-4000-8000-000000000003',title:'RemoteControl 切换测试'}
];
