export function initializeUsage(store){store.db.exec("CREATE TABLE IF NOT EXISTS usage_requests(inbox_id INTEGER PRIMARY KEY REFERENCES inbox(id),done INTEGER NOT NULL DEFAULT 0)");}
export function formatUsage(data,now=new Date()){
  const time=v=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(v);
  const buckets=data?.rateLimitsByLimitId&&Object.keys(data.rateLimitsByLimitId).length?Object.entries(data.rateLimitsByLimitId):data?.rateLimits?[['codex',data.rateLimits]]:[];
  const lines=['Codex 账户剩余用量（账户共享）'];
  if(!buckets.length)lines.push('当前用量数据不可用。');
  for(const [id,b] of buckets){
    if(!b){lines.push(`${id}：数据不可用`);continue;}
    lines.push(b.limitName||id);
    for(const [key,fallback] of [['primary','主要窗口'],['secondary','次要窗口']]){
      const w=b[key],minutes=w?.windowDurationMins;
      const label=minutes===300?'5 小时':minutes===10080?'每周':typeof minutes==='number'?`${minutes} 分钟`:fallback;
      const remaining=typeof w?.usedPercent==='number'&&Number.isFinite(w.usedPercent)?`${Math.round(Math.max(0,Math.min(100,100-w.usedPercent))*10)/10}%`:'未知';
      const reset=typeof w?.resetsAt==='number'&&Number.isFinite(w.resetsAt)&&w.resetsAt>0?`；重置 ${time(new Date(w.resetsAt*1000))}`:'';
      lines.push(`${label}：剩余 ${remaining}${reset}`);
    }
  }
  lines.push(`查询时间 ${time(now)}（北京时间）`);return lines.join('\n');
}
export class UsageWorker{
  constructor(store,fetchUsage){this.store=store;this.fetchUsage=fetchUsage;initializeUsage(store);}
  async tick(){
    const row=this.store.db.prepare('SELECT inbox_id FROM usage_requests WHERE done=0 ORDER BY inbox_id LIMIT 1').get();if(!row)return;
    let body;try{body=formatUsage(await this.fetchUsage());}catch{body='用量查询失败：无法读取当前 Codex 账户额度。请稍后重试 /rc usage。';}
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT OR IGNORE INTO outbox(inbox_id,dedup_key,body) VALUES(?,?,?)').run(row.inbox_id,`usage:${row.inbox_id}`,body);
      this.store.db.prepare('UPDATE usage_requests SET done=1 WHERE inbox_id=?').run(row.inbox_id);
    });
  }
}
