import {marked} from 'marked';

export function textChunks(text, limit=2000) {
  const chars=Array.from(text), result=[];
  for(let i=0;i<Math.max(1,chars.length);i+=limit)result.push(chars.slice(i,i+limit).join(''));
  return result;
}

// Keep source bytes and fenced diagrams intact; transport applies its own size limits.
export function splitReplySource(text) {
  // Persist the complete outcome. Only the transport planner decides card boundaries.
  // Existing outbox chunks are preserved by recordOutcome's replay check.
  return [text];
}

// Feishu-specific HTML can mention users or embed remote resources. Display it literally.
function safeMarkdown(text) {
  return text.replace(/!\[([^\]]*)\]\([^\n]*?\)/g,(_,alt)=>`[图片引用：${alt||'未命名'}]`)
    .replace(/<[^>\n]*>/g,tag=>tag.replace(/</g,'&lt;').replace(/>/g,'&gt;'));
}
const md=text=>({tag:'markdown',content:safeMarkdown(text)||'（空回复）'});
function card(title,elements){return {msg_type:'interactive',content:JSON.stringify({schema:'2.0',header:{template:'blue',title:{tag:'plain_text',content:title.slice(0,120)}},body:{elements}})};}
function literalCode(text,lang='text') {
  const runs=text.match(/`+/g)??[];const fence='`'.repeat(Math.max(3,...runs.map(s=>s.length+1)));
  return {tag:'markdown',content:`${fence}${/^[a-z0-9_+-]{1,25}$/i.test(lang)?lang:'text'}\n${text}\n${fence}`};
}

export async function buildReplyPlan(text,title,{render,upload}={}){
  if(!text.trim())return [];
  const plan=[];let elements=[],source='',diagramCount=0;
  function flush(){if(elements.length){plan.push({...card(title,elements),fallback:`【${title}】\n${source}`});elements=[];source='';}}
  function append(element,raw){
    if(elements.length>=12||Buffer.byteLength(JSON.stringify([...elements,element]))>18000)flush();
    if(Buffer.byteLength(JSON.stringify(element))>18000){
      flush();for(const part of textChunks(raw))plan.push({msg_type:'text',content:JSON.stringify({text:`【${title}】\n${part}`}),fallback:null});return;
    }
    elements.push(element);source+=raw;
  }
  for(const token of marked.lexer(text,{gfm:true})){
    const raw=token.raw??'';
    if(token.type==='space'){source+=raw;continue;}
    if(token.type==='code'&&token.lang?.trim().toLowerCase()==='mermaid'){
      diagramCount++;
      try{
        if(diagramCount>4||token.text.length>20000)throw Error('图形超过本次渲染限制');
        const png=await render(token.text);const key=await upload(png);
        if(typeof key!=='string'||!key.startsWith('img_'))throw Error('图片上传未确认');
        append({tag:'img',img_key:key,alt:{tag:'plain_text',content:'Mermaid 流程图'},preview:true},raw);
      }catch(error){
        const notice=error?.kind==='upload_permission'?'⚠️ 飞书图片上传权限未开通（im:resource:upload），下面保留流程图源码。':'⚠️ 流程图未能转为图片（可能是语法、渲染限制或上传权限问题），下面保留源码。';
        append(md(notice),notice+'\n');
        for(const part of textChunks(token.text))append(literalCode(part,'text'),part+'\n');
      }
    }else if(token.type==='code'){
      for(const part of textChunks(token.text))append(literalCode(part,token.lang),part+'\n');
    }else if(token.type==='table'&&token.header.length<=8){
      const columns=token.header.map((cell,i)=>({name:`c${i}`,display_name:cell.text,data_type:'text'}));
      for(let i=0;i<token.rows.length;i+=10){
        const rows=token.rows.slice(i,i+10);
        const fallback=[token.header,...rows].map(row=>row.map(cell=>cell.text).join(' | ')).join('\n');
        append({tag:'table',page_size:10,columns,rows:rows.map(row=>Object.fromEntries(row.map((cell,j)=>[`c${j}`,cell.text])))},fallback);
      }
      if(!token.rows.length)append(md(raw),raw);
    }else{
      for(const part of textChunks(raw))append(md(part),part);
    }
  }
  flush();if(!plan.length)plan.push({msg_type:'text',content:JSON.stringify({text:`【${title}】\n${text}`}),fallback:null});
  return plan;
}
