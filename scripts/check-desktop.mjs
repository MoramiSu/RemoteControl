import {DesktopAdapter,SOURCE} from '../src/desktop-adapter.mjs';
import {desktopConfig,validateDesktopConfig} from '../src/desktop-config.mjs';
validateDesktopConfig(desktopConfig);
const adapter=new DesktopAdapter();
try{
 const source=await adapter.call('read_thread',{threadId:SOURCE,turnLimit:1,includeOutputs:false});
 if(source.thread?.id!==SOURCE||source.thread.kind!=='codex'||source.thread.hostId!=='local')throw Error('Source task identity mismatch');
 const target=await adapter.read();
 console.log(JSON.stringify({sourceVerified:true,targetVerified:true,targetTitle:target.thread.title,status:target.thread.status?.type}));
}finally{adapter.close();}
