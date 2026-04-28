// ===================================================================
// DB ABSTRACTION LAYER
// ===================================================================
// A thin wrapper that delegates to the active adapter.
// The rest of the app imports `db` and calls db.from(), db.channel(),
// db.rpc() — never touching the raw backend SDK directly.
//
// Usage:
//   import db from './db.js';
//   db.setAdapter(someAdapter);     // called once at connect time
//   const { data } = await db.from('projects').select('*');
// ===================================================================

let _adapter = null;

const db = {
  /** Install a backend adapter (supabase, pocketbase, rest …) */
  setAdapter(adapter) { _adapter = adapter; },

  /** True once an adapter has been installed */
  get connected() { return _adapter !== null; },

  /** Query builder — delegates to adapter.from(table) */
  from(table) {
    if (!_adapter) throw new Error('db: no adapter set — call db.setAdapter() first');
    return _adapter.from(table);
  },

  /** Realtime channel (optional — adapter may not support it) */
  channel(name) {
    if (!_adapter?.channel) throw new Error('db: adapter does not support realtime channels');
    return _adapter.channel(name);
  },

  /** Remote procedure call (optional) */
  rpc(fn, params) {
    if (!_adapter?.rpc) throw new Error('db: adapter does not support rpc');
    return _adapter.rpc(fn, params);
  },
};

export default db;
