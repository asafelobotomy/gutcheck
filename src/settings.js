// settings.json: always a plain object, written atomically (temp file + rename) so a crash mid-write
// cannot leave half a file. A file that does not parse is kept aside as settings.json.bad rather
// than silently overwritten, so the user's choices (including read-only mode) can be recovered.
const fs = require('node:fs');

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function createSettingsStore(file, io = fs) {
  function load() {
    let text;
    try { text = io.readFileSync(file, 'utf8'); } catch { return {}; }
    try {
      const v = JSON.parse(text);
      if (isObject(v)) return v;
    } catch {}
    try { io.renameSync(file, file + '.bad'); } catch {}
    return {};
  }
  function save(s) {
    io.writeFileSync(file + '.tmp', JSON.stringify(s, null, 2));
    io.renameSync(file + '.tmp', file);
    return s;
  }
  const update = (patch) => save({ ...load(), ...(isObject(patch) ? patch : {}) });
  return { load, update };
}

module.exports = { createSettingsStore };
