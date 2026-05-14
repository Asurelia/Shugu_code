export const api = new Proxy({}, { get(_, k) { return new Proxy({}, { get() { return k; } }); } });
