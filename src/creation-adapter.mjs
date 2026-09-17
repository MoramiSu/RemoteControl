import {DesktopAdapter} from './desktop-adapter.mjs';
export class CreationAdapter {
 constructor(){this.client=new DesktopAdapter();}
 async prepare(project){await this.client.connect();const catalog=await this.client.request('tools/list',{});if(!catalog.tools.some(t=>t.name==='create_thread'))throw Error('create_tool_missing');if(project){const data=await this.client.call('list_projects',{});const p=data.projects?.find(p=>p.projectId===project.projectId&&p.hostId==='local'&&p.projectKind==='local');if(!p||p.path!==project.path||p.isGitRepository!==project.isGitRepository)throw Error('project_changed');}}
 create(title,project){return this.client.call('create_thread',{target:project?{type:'project',projectId:project.projectId,environment:{type:project.isGitRepository?'worktree':'local'}}:{type:'projectless'},title,prompt:'这是用户通过飞书明确要求创建的本地任务。等待用户后续要求；本轮只回复“已就绪”，不要调用工具、读取文件或执行任何操作。'});}
 async readCreated(threadId,project){if(project){const list=await this.client.call('list_threads',{limit:50});if(![...(list.pinnedThreads??[]),...(list.threads??[])].some(t=>t.id===threadId&&t.kind==='codex'&&t.hostId==='local'&&t.projectId===project.projectId))throw Error('created_project_unverified');}return this.client.call('read_thread',{threadId,turnLimit:1,includeOutputs:false});}
 close(){this.client.close();}
}

