import {taskTitle} from './tasks.mjs';
const desktopNames={starting:'正在连接',disabled:'未启用',idle:'空闲',busy:'忙碌',running:'执行中',delivering:'正在投递',delivery_unknown:'投递待核实',turn_missing:'目标轮次待核实',reply_incomplete:'完整回复待核实',reply_pending:'等待读取最终回复',needs_attention:'等待桌面处理',connection_error:'连接失败，正在重试',completed:'已完成',interrupted:'已停止',failed:'执行失败'};
export function statusText(store,target,runtime={}) {
  const binding=store.db.prepare('SELECT paused FROM bindings WHERE target_id=? LIMIT 1').get(target);
  const queued=store.db.prepare("SELECT count(*) AS n FROM inbox WHERE target_id=? AND delivery='queued'").get(target).n;
  const uncertain=store.db.prepare("SELECT count(*) AS n FROM inbox WHERE target_id=? AND delivery='delivery_unknown'").get(target).n;
  const latest=store.db.prepare("SELECT delivery,execution FROM inbox WHERE target_id=? AND delivery!='cancelled' ORDER BY id DESC LIMIT 1").get(target);
  const connection=runtime.connection==='connected'?'已连接':runtime.connection??'待确认';
  return [`绑定任务：${taskTitle(store,target)}`,`飞书：${connection}`,`Codex：${desktopNames[runtime.desktop]??'状态待确认'}`,`遥控：${binding?.paused?'已暂停':'已启用'}`,`排队：${queued} 条；投递待核实：${uncertain} 条`,latest?`最近消息：${({queued:'排队中',delivering:'投递中',delivery_unknown:'投递待核实',delivery_failed:'投递失败',delivered:'已送达'})[latest.delivery]??latest.delivery}；执行：${desktopNames[latest.execution]??({not_started:'未开始',unknown:'待确认'})[latest.execution]??'待确认'}`:'暂无任务消息','停止与截图尚未接入，请在桌面处理。'].join('\n');
}
