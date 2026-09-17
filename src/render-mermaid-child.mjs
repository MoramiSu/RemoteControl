import puppeteer from 'puppeteer-core';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const require=createRequire(import.meta.url);
let browser;
try{
  const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
  const source=Buffer.concat(chunks).toString('utf8');
  if(source.length>20000||/%%\s*\{|^\s*---/m.test(source))throw Error('limit');
  const candidates=[join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),join(process.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe')];
  const executablePath=candidates.find(existsSync);if(!executablePath)throw Error('No renderer browser');
  browser=await puppeteer.launch({executablePath,headless:true,pipe:true,timeout:12000,args:['--disable-background-networking','--disable-component-update','--no-first-run']});
  const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',request=>request.abort());
  await page.setViewport({width:1500,height:1000,deviceScaleFactor:1.5});
  await page.setContent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; style-src \'unsafe-inline\'; img-src data:"><style>body{margin:16px;background:white;font-family:Microsoft YaHei,Arial}#diagram{display:inline-block;padding:16px}svg{max-width:none!important}</style><div id="diagram"></div>');
  const bundle=join(dirname(require.resolve('mermaid/package.json')),'dist/mermaid.min.js');
  await page.addScriptTag({content:readFileSync(bundle,'utf8')});
  await page.evaluate(async source=>{
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'default',fontFamily:'Microsoft YaHei,Arial',maxTextSize:20000,maxEdges:200,suppressErrorRendering:true,flowchart:{htmlLabels:false,useMaxWidth:false},secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','themeCSS','fontFamily']});
    const {svg}=await mermaid.render('rcDiagram',source);document.getElementById('diagram').innerHTML=svg;
  },source);
  const element=await page.$('#diagram');const box=await element.boundingBox();
  if(!box||box.width>5000||box.height>5000||box.width*box.height>8000000)throw Error('dimensions');
  const png=await element.screenshot({type:'png'});if(png.length>7*1024*1024)throw Error('size');
  process.stdout.write(png);
}catch{process.exitCode=1;}finally{await browser?.close();}
