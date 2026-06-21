function parseCsv(text) {
  const lines = String(text).split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const cells = line.split(",").map((c) => c.trim());
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = cells[idx] !== undefined ? cells[idx] : "";
    });
    rows.push(obj);
  }
  return rows;
}

module.exports = { parseCsv };
