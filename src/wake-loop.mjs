import {setTimeout as sleep} from 'node:timers/promises';

// One consumer per signal. A true result drains another queued job immediately.
export async function runWakeLoop({signal,tick,stopped,onError,interval=1000,cooldown=()=>0}){
  while(!stopped()){
    let more=false;
    try{more=await tick()===true;}catch(error){onError(error);}
    if(stopped())break;
    const delay=cooldown();
    if(delay>0)await sleep(delay);
    else if(!more)await signal.wait(interval);
  }
}
