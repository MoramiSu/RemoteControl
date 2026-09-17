import {initializeProjects} from './projects.mjs';

export function initializeTasks(store) {
 store.db.exec(`CREATE TABLE IF NOT EXISTS authorized_tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,creation_inbox_id INTEGER NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS selection_revisions(tenant_id TEXT NOT NULL,chat_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(tenant_id,chat_id));
 CREATE TABLE IF NOT EXISTS creation_requests(inbox_id INTEGER PRIMARY KEY REFERENCES inbox(id),requested_title TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','creating','verifying','completed','unknown','failed')),thread_id TEXT,title TEXT,base_revision INTEGER NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS task_catalog(id TEXT PRIMARY KEY,title TEXT NOT NULL,state TEXT NOT NULL,checked_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS task_lists(tenant_id TEXT NOT NULL,chat_id TEXT NOT NULL,user_id TEXT NOT NULL,items_json TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,chat_id,user_id));`);initializeProjects(store);
}
export function taskTitle(store,id){return store.db.prepare('SELECT title FROM task_catalog WHERE id=?').get(id)?.title??id;}
export function selectionRevision(store,tenant,chat){return store.db.prepare('SELECT revision FROM selection_revisions WHERE tenant_id=? AND chat_id=?').get(tenant,chat)?.revision??0;}
export function bumpSelection(store,tenant,chat){store.db.prepare('INSERT INTO selection_revisions VALUES(?,?,1) ON CONFLICT(tenant_id,chat_id) DO UPDATE SET revision=revision+1').run(tenant,chat);}

