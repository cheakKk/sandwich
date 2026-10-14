// Deleting things, in one place. A session is deleted the same way whether the owner asked, a failed create is rolled back, or the
// retention sweep found it idle. Order matters: the sealed key goes first and the session is marked so nothing can wake it, then the
// worker stops, then the folders (chat, files, memory) are wiped, then the rows, then the database is scrubbed of old copies.
import { SID_RE } from './store.mjs';

export const RETENTION = { idleMs: 30 * 86400000, unfinishedMs: 3600000, sweepEveryMs: 3600000 };

export function createLifecycle({ store, driver, retention = {}, now = Date.now, log = () => {} }) {
  const ret = { ...RETENTION, ...retention };

  async function deleteSession(id) {
    if (!store.session(id)) return;
    store.update(id, { key_sealed: null, status: 'deleting' });
    await driver.stop(id);
    await driver.wipe(id);
    store.deleteSession(id);
    store.scrub();
  }

  async function deleteAccount(userId) {
    for (const s of store.allSessions().filter((x) => x.owner_id === userId)) await deleteSession(s.id);
    store.deleteUser(userId); // their web logins go with them
    store.scrub();
  }

  // One pass: expired tokens, abandoned and idle sessions, folders whose session is gone, half-finished deletes. Safe to run often.
  async function sweep() {
    const t = now(), done = { sessions: 0, folders: 0 };
    store.purge();
    for (const s of store.allSessions()) {
      const last = s.last_active ?? s.created ?? 0;
      const stuck = s.status === 'deleting' || ((s.status === 'new' || s.status === 'failed') && t - (s.created ?? 0) > ret.unfinishedMs);
      const idle = t - last > ret.idleMs && !driver.isRunning?.(s.id);
      if (stuck || idle) { try { await deleteSession(s.id); done.sessions++; } catch (e) { log('sweep: delete failed:', e.message); } }
    }
    const known = new Set(store.allSessions().map((s) => s.id));
    for (const id of driver.ids?.() ?? []) if (SID_RE.test(id) && !known.has(id)) { await driver.wipe(id); done.folders++; }
    store.scrub();
    return done;
  }

  const start = () => { const h = setInterval(() => sweep().catch((e) => log('sweep failed:', e.message)), ret.sweepEveryMs); h.unref(); return () => clearInterval(h); };
  return { deleteSession, deleteAccount, sweep, start };
}
