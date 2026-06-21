const fs = require("node:fs");

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: node wc.js <file>\n");
  process.exit(1);
}

let buf;
try {
  buf = fs.readFileSync(file);
} catch (err) {
  process.stderr.write(`cannot read ${file}: ${err.message}\n`);
  process.exit(1);
}

const text = buf.toString("utf8");
const lines = (text.match(/\n/g) || []).length;
const words = text.split(/\s+/).filter(Boolean).length;
const bytes = buf.length;
process.stdout.write(`${lines} ${words} ${bytes}\n`);
