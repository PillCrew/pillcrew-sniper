const fs = require('fs');
const path = require('path');

/** Tiny JSON settings store. */
class Store {
  constructor(dir, name, defaults) {
    this.file = path.join(dir, name);
    this.data = { ...defaults };
    // A settings file that cannot be read is not a first run. Saying nothing means the app trades with defaults - a
    // ticket, a plan and a book of positions nobody chose - and the user never learns why.
    this.damaged = null;
    let text = null;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') this.damaged = `The settings file could not be read (${(err && (err.code || err.message)) || 'unknown error'}), so the defaults are in use.`;
    }
    if (text != null) {
      try {
        Object.assign(this.data, JSON.parse(text));
      } catch (err) {
        // The broken file is kept beside the real one: whatever the user had set is still recoverable by hand, and
        // the next write cannot quietly overwrite the only copy of it.
        this.damaged = `The settings file was damaged (${err.message}), so the defaults are in use. The damaged file was kept as ${name}.broken.`;
        try { fs.writeFileSync(this.file + '.broken', text); } catch (_) { /* nothing else can be done here */ }
      }
    }
  }
  get() { return this.data; }
  set(patch) {
    Object.assign(this.data, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Written beside the real file and renamed over it, exactly like the wallet: a crash, a full disk or a sync
    // client cannot leave a half-written file, and a half-written settings file is a book with no positions and a
    // plan nobody chose.
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.data;
  }
  /** Drop keys the app no longer uses, so an upgraded install does not keep carrying them forever. */
  unset(keys) {
    let touched = false;
    for (const k of keys) if (Object.prototype.hasOwnProperty.call(this.data, k)) { delete this.data[k]; touched = true; }
    if (touched) this.set({});
    return this.data;
  }
}

module.exports = { Store };
