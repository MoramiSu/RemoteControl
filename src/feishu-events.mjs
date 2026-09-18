export function parseMessageEvent(data, appId) {
  if(data?.app_id && data.app_id!==appId) return null;
  if(data?.sender?.sender_type!=='user' || data?.message?.chat_type!=='p2p' || !['text','image','file'].includes(data.message.message_type)) return null;
  const tenant=data.sender.tenant_key ?? data.tenant_key;
  if(data.tenant_key && data.sender.tenant_key && data.tenant_key!==data.sender.tenant_key) return null;
  const fields={messageId:data.message.message_id,tenantId:tenant,userId:data.sender.sender_id?.open_id,chatId:data.message.chat_id};
  if(!Object.values(fields).every(v=>typeof v==='string' && v.length>0)) return null;
  try {
    const body=JSON.parse(data.message.content),kind=data.message.message_type;
    if(kind==='text')return typeof body.text==='string'?{...fields,text:body.text}:null;
    const key=kind==='image'?body.image_key:body.file_key,name=kind==='image'?'image':body.file_name;
    if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{1,256}$/.test(key)||typeof name!=='string'||!name||name.length>512)return null;
    const attachment={kind,key,name};return {...fields,text:'飞书附件元数据：'+JSON.stringify(attachment),attachment};
  } catch {return null;}
}
export function parseTextEvent(data,appId){return data?.message?.message_type==='text'?parseMessageEvent(data,appId):null;}
export function classify(text) {
  if(!text.startsWith('/rc ')) return 'text';
  const cmd=text.slice(4);
  if(cmd==='project' || cmd.startsWith('project '))return 'project';
  if(cmd==='new' || cmd.startsWith('new '))return 'new';
  // Keep the persisted operation name for pending commands from older versions.
  if(cmd==='task' || cmd.startsWith('task '))return 'use';
  return ['projects','usage','status','pause','resume','stop','screenshot','tasks','current','help'].includes(cmd) ? cmd : 'unknown_command';
}



