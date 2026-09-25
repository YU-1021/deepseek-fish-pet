const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const file = () => path.join(app.getPath('userData'), 'memory.json');

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, '')); }
  catch { return { medium: [], long: [] }; }
}

function save(m) {
  try { fs.writeFileSync(file(), JSON.stringify(m, null, 2)); } catch {}
}

module.exports = { load, save, file };
