import {marked} from 'marked';
import {openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,basename,extname,parse,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';

export const LIMITS={count:8,file:20*1024*1024,image:8*1024*1024,total:50*1024*1024};
const extensions=new Set('png jpg jpeg webp gif pdf doc docx xls xlsx ppt pptx csv tsv txt md json html css js mjs cjs ts tsx jsx py sql yaml yml zip svg'.split(' '));
const images=new Set(['.png','.jpg','.jpeg','.webp','.gif']);
const denied=/(^\.|^(?:node_modules|id_rsa|id_ed25519)$|^(?:auth|credentials?|secrets?|tokens?)(?:[._-].*)?$|\.(?:pem|key|pfx|p12|sqlite|db)$)/i;
const equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const fail=reason=>{throw Object.assign(Error(reason),{reason});};
function within(root,file){const rel=relative(root,file);return !!rel&&!rel.startsWith('..')&&!isAbsolute(rel);}

export function localOutputLinks(text){
  const links=[],seen=new Set();
  for(const block of marked.lexer(text,{gfm:true})){
    if(['code','blockquote','html'].includes(block.type))continue;
    marked.walkTokens([block],token=>{
      if(!['link','image'].includes(token.type))return;
      let href=token.href;if(typeof href!=='string'||/[#?]|:\d+(?::\d+)?$/.test(href))return;
      if(/^[a-z][a-z0-9+.-]*:/i.test(href)&&!/^file:/i.test(href)&&!(/^[a-z]:[\\/]/i.test(href)))return;
      // No network shares, device paths, alternate data streams or URL fetching.
      if(/^file:/i.test(href)){try{const url=new URL(href);if(url.hostname)fail('network_path');href=fileURLToPath(url);}catch{return;}}
      else {try{href=decodeURIComponent(href);}catch{return;}}
      if(!href||seen.has(href))return;seen.add(href);
      if(!extname(href))return;
      links.push({path:href,label:token.text||basename(href)});
    });
  }
  return links;
}

export function snapshotArtifact(link,{cwd,receivedAt},limits=LIMITS){
  if(typeof cwd!=='string'||!isAbsolute(cwd))fail('scope_unverified');
  const root=realpathSync.native(cwd);
  if(root.split(/[\\/]/).some(piece=>/^\.(?:private|ssh|aws|azure|gnupg|git)$/i.test(piece)))fail('protected_path');
  if(equal(root,parse(root).root)||equal(root,homedir()))fail('scope_too_broad');
  if(/^(?:\\\\|\/\/)/.test(link.path)||/[\x00-\x1f]/.test(link.path))fail('invalid_path');
  if(link.path.replace(/^[a-z]:/i,'').includes(':'))fail('invalid_path');
  const requested=resolve(cwd,link.path),full=realpathSync.native(requested);
  if(!within(root,full))fail('outside_task');
  const pieces=relative(root,full).split(/[\\/]/);
  if(pieces.some(piece=>denied.test(piece)))fail('protected_path');
  const ext=extname(full).toLowerCase();if(!extensions.has(ext.slice(1)))fail('unsupported_type');
  // Reject reparse points throughout the path and hard-linked files.
  let path=parse(requested).root;
  for(const piece of requested.slice(path.length).split(/[\\/]/).filter(Boolean)){path=join(path,piece);if(lstatSync(path).isSymbolicLink())fail('linked_path');}
  if(!equal(realpathSync.native(full),full))fail('linked_path');
  const before=lstatSync(full);if(!before.isFile()||before.nlink!==1)fail('not_regular_file');
  if(!Number.isFinite(receivedAt)||Math.max(before.mtimeMs,before.birthtimeMs)<receivedAt)fail('not_current_output');
  if(before.size===0||before.size>limits.file)fail('size_limit');
  const fd=openSync(full,'r');let bytes;
  try{
    const opened=fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)fail('file_changed');
    const buffer=Buffer.alloc(before.size+1);let read=0;
    while(read<buffer.length){const n=readSync(fd,buffer,read,buffer.length-read,null);if(!n)break;read+=n;}
    const after=fstatSync(fd),current=lstatSync(full);
    if(read!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||current.ino!==before.ino||current.dev!==before.dev||current.isSymbolicLink()||!equal(realpathSync.native(full),full))fail('file_changed');
    bytes=buffer.subarray(0,read);
  }finally{closeSync(fd);}
  return {name:basename(full),path:full,bytes,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),kind:images.has(ext)&&bytes.length<=limits.image?'image':'file'};
}

export function initializeArtifacts(db){
  db.exec(`CREATE TABLE IF NOT EXISTS reply_artifacts(id INTEGER PRIMARY KEY,inbox_id INTEGER NOT NULL REFERENCES inbox(id),turn_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,source_path TEXT NOT NULL,kind TEXT,sha256 TEXT,size INTEGER,bytes BLOB,state TEXT NOT NULL,error TEXT,
    remote_key TEXT,first_at INTEGER,next_at INTEGER,UNIQUE(inbox_id,turn_id,ordinal));`);
  if(!db.prepare('PRAGMA table_info(outbox)').all().some(c=>c.name==='artifact_id'))db.exec('ALTER TABLE outbox ADD COLUMN artifact_id INTEGER REFERENCES reply_artifacts(id)');
}

export function captureArtifacts(store,row,turnId,text,context){
  const links=localOutputLinks(text);let total=0;const seen=new Set();
  for(let ordinal=0;ordinal<Math.min(links.length,LIMITS.count+1);ordinal++){
    const link=links[ordinal];let artifact,error=null;
    try{
      if(ordinal>=LIMITS.count)fail('count_limit');
      if(context?.threadId!==row.target_id)fail('scope_unverified');
      artifact=snapshotArtifact(link,{cwd:context.cwd,receivedAt:Number(row.received_at)});
      const identity=process.platform==='win32'?artifact.path.toLowerCase():artifact.path;
      if(seen.has(identity))continue;seen.add(identity);
      if(total+artifact.size>LIMITS.total)fail('total_limit');total+=artifact.size;
    }catch(e){error=e.reason??'read_failed';artifact=null;}
    const name=artifact?.name??basename(link.path).slice(0,200);
    const saved=store.db.prepare('INSERT INTO reply_artifacts(inbox_id,turn_id,ordinal,name,source_path,kind,sha256,size,bytes,state,error) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(row.id,turnId,ordinal,name,artifact?.path??link.path,artifact?.kind??null,artifact?.sha256??null,artifact?.size??null,artifact?.bytes??null,error?'failed':'captured',error);
    store.db.prepare('INSERT INTO outbox(inbox_id,dedup_key,body,artifact_id) VALUES(?,?,?,?)').run(row.id,`artifact:${row.id}:${turnId}:${ordinal}`,`附件：${name}`,Number(saved.lastInsertRowid));
  }
}

const reasons={scope_unverified:'无法核对任务目录',scope_too_broad:'任务目录范围过大',invalid_path:'不支持此路径',outside_task:'文件不在当前任务目录内',protected_path:'受保护的文件或目录',unsupported_type:'暂不支持此文件类型',linked_path:'不传输链接或重解析路径',not_regular_file:'不是独立的普通文件',not_current_output:'文件并非本轮生成或更新',size_limit:'文件为空或超过 20 MB',count_limit:'本轮附件超过 8 个，其余未传输',total_limit:'本轮附件总量超过 50 MB',file_changed:'读取期间文件发生变化',read_failed:'文件不存在或无法读取',upload_permission:'飞书资源上传权限不足',upload_rejected:'飞书拒绝此资源',upload_expired:'资源上传重试超时',snapshot_invalid:'文件快照校验失败'};
export function artifactNotice(artifact){return `附件未发送：${artifact.name}\n原因：${reasons[artifact.error]??'上传失败'}。`;}

export function artifactReady(db,row,now){
  if(!row.artifact_id)return true;
  const a=db.prepare('SELECT state,first_at,next_at FROM reply_artifacts WHERE id=?').get(row.artifact_id);
  return !a||a.state!=='captured'||a.first_at==null||now>=a.next_at;
}

export async function artifactPlan(store,row,client,title,now){
  const db=store.db;let a=db.prepare('SELECT * FROM reply_artifacts WHERE id=? AND inbox_id=?').get(row.artifact_id,row.inbox_id);
  if(!a)throw Error('Missing artifact identity');
  const failure=reason=>{db.prepare("UPDATE reply_artifacts SET state='failed',error=?,bytes=NULL WHERE id=?").run(reason,a.id);a={...a,state:'failed',error:reason};};
  if(a.state==='captured'){
    if(a.first_at!=null&&now-a.first_at>=300000)failure('upload_expired');
    else{
      const bytes=Buffer.from(a.bytes??[]);
      if(bytes.length!==a.size||createHash('sha256').update(bytes).digest('hex')!==a.sha256)failure('snapshot_invalid');
      else{
        db.prepare('UPDATE reply_artifacts SET first_at=COALESCE(first_at,?),next_at=? WHERE id=?').run(now,now+15000,a.id);
        try{
          const response=a.kind==='image'?await client.im.image.create({data:{image_type:'message',image:bytes}}):await client.im.file.create({data:{file_type:'stream',file_name:a.name,file:bytes}});
          const key=a.kind==='image'?response?.image_key:response?.file_key;
          if(typeof key!=='string'||!key.startsWith(a.kind==='image'?'img_':'file_'))throw Error('Upload unconfirmed');
          db.prepare("UPDATE reply_artifacts SET state='uploaded',remote_key=? WHERE id=?").run(key,a.id);a={...a,state:'uploaded',remote_key:key};
        }catch(error){
          const code=error?.response?.data?.code;
          if(code===99991672)failure('upload_permission');
          else if([234001,234002,234003,234006,234007,234008,234009,230001].includes(code))failure('upload_rejected');
          else throw Error('Artifact upload unconfirmed');
        }
      }
    }
  }
  if(a.state==='failed')return [{msg_type:'text',content:JSON.stringify({text:`【${title}】\n${artifactNotice(a)}`}),fallback:null}];
  if(a.kind==='image')return [{msg_type:'interactive',content:JSON.stringify({schema:'2.0',header:{title:{tag:'plain_text',content:title.slice(0,120)}},body:{elements:[{tag:'div',text:{tag:'plain_text',content:a.name}},{tag:'img',img_key:a.remote_key,alt:{tag:'plain_text',content:a.name},preview:true}]}}),fallback:`图片回传失败：${a.name}`}];
  return [{msg_type:'text',content:JSON.stringify({text:`【${title}】\n附件：${a.name}（${Math.ceil(a.size/1024)} KB）`}),fallback:null},{msg_type:'file',content:JSON.stringify({file_key:a.remote_key}),fallback:null}];
}
