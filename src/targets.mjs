import {initialTasks} from './desktop-config.mjs';
// Legacy names retained for adapter/test compatibility.
export const TEST_TARGET=initialTasks[0].id;
export const SWITCH_TARGET=initialTasks[1]?.id??'00000000-0000-4000-8000-000000000003';
export const ALLOWED_TASKS=new Map(initialTasks.map(t=>[t.id,t.title]));

export function allowedTasks(store){return new Map([...ALLOWED_TASKS,...store.db.prepare('SELECT id,title FROM selected_project_tasks').all().map(t=>[t.id,t.title]),...store.db.prepare('SELECT id,title FROM authorized_tasks').all().map(t=>[t.id,t.title])]);}
