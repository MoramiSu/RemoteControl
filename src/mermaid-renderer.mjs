import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function renderMermaid(source) {
  if(typeof source!=='string'||source.length>20000||/%%\s*\{|^\s*---/m.test(source))return Promise.reject(Error('Unsupported diagram configuration'));
  return new Promise((resolve,reject)=>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|USERPROFILE|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)));
    const child=spawn(process.execPath,[fileURLToPath(new URL('./render-mermaid-child.mjs',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],env});
    let output=[],size=0,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const kill=()=>{if(child.pid&&process.platform==='win32')spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill());else child.kill('SIGKILL');};
    const timer=setTimeout(()=>{kill();finish(Error('Diagram render timeout'));},25000);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024){kill();finish(Error('Diagram too large'));}else output.push(chunk);});
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',()=>finish(Error('Diagram renderer unavailable')));
    child.on('close',code=>{const png=Buffer.concat(output);if(code!==0||!png.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))finish(Error('Diagram render failed'));else finish(null,png);});
    child.stdin.end(source);
  });
}
