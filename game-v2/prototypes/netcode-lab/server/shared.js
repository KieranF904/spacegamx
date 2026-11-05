// Loads the lab's shared files (the same ones the page loads with <script>) into this process. Each one hangs its part
// off globalThis.NL, so they run in the global scope, in order.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['sim.js', 'net.js', 'world.js', 'proto.js', 'labserver.js', 'labclient.js', 'harness.js'];
if (!globalThis.NL || !globalThis.NL.LabServer) {
  for (const f of FILES) vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: path.join(ROOT, f) });
}
module.exports = globalThis.NL;
