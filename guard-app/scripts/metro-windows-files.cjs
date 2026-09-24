const fs = require('node:fs');
const path = require('node:path');

// Windows cloud placeholders can be reported as links by readdir even though
// lstat identifies regular files. Metro otherwise attempts readlink on them.
function normalizeEntries(directory, entries) {
  if (!Array.isArray(entries)) return entries;
  return entries.map((entry) => {
    if (typeof entry.isSymbolicLink !== 'function' || !entry.isSymbolicLink()) return entry;
    try {
      const stat = fs.lstatSync(path.join(String(directory), String(entry.name)));
      if (stat.isSymbolicLink()) return entry;
      const normalized = Object.create(entry);
      for (const method of ['isFile', 'isDirectory', 'isSymbolicLink', 'isBlockDevice', 'isCharacterDevice', 'isFIFO', 'isSocket']) {
        normalized[method] = () => stat[method]();
      }
      return normalized;
    } catch {
      return entry; // Preserve normal handling for files removed during a scan.
    }
  });
}

function install() {
  if (process.platform !== 'win32' || fs.__surakshaCloudEntries) return;
  Object.defineProperty(fs, '__surakshaCloudEntries', { value: true });
  const readdirSync = fs.readdirSync;
  const readdir = fs.readdir;
  fs.readdirSync = function (directory, options) {
    return normalizeEntries(directory, readdirSync.call(this, directory, options));
  };
  fs.readdir = function (directory, ...args) {
    const callback = args.pop();
    return readdir.call(this, directory, ...args, (error, entries) => {
      callback(error, error ? entries : normalizeEntries(directory, entries));
    });
  };
}

module.exports = { install, normalizeEntries };
