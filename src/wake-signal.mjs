// Single-consumer signal: coalesce bursts and retain wakeups arriving during work.
export class WakeSignal {
  pending=false;
  waiter=null;
  wake(){this.pending=true;this.waiter?.();}
  wait(ms){
    if(this.pending){this.pending=false;return Promise.resolve();}
    return new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);this.waiter=null;this.pending=false;resolve();};
      const timer=setTimeout(finish,ms);
      this.waiter=finish;
    });
  }
}
