// Tiny Prometheus registry (text exposition format 0.0.4). The sidecar is a long-lived process, so — unlike the Worker —
// it CAN be scraped: Prometheus job `whatsapp-gateway`, bearer token = WA_GATEWAY_TOKEN.
const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
export function createMetrics() {
  const series = new Map(); // key -> {name, labels, value}
  const help = new Map();
  const key = (n, l) => n + JSON.stringify(Object.entries(l).sort());
  return {
    describe(name, text, type = "counter") { help.set(name, { text, type }); },
    inc(name, labels = {}, by = 1) { const k = key(name, labels), s = series.get(k); if (s) s.value += by; else series.set(k, { name, labels, value: by }); },
    set(name, value, labels = {}) { series.set(key(name, labels), { name, labels, value }); },
    get(name, labels = {}) { return series.get(key(name, labels))?.value ?? 0; },
    render() {
      const byName = new Map();
      for (const s of series.values()) (byName.get(s.name) ?? byName.set(s.name, []).get(s.name)).push(s);
      let out = "";
      for (const [name, list] of byName) {
        const h = help.get(name); if (h) out += `# HELP ${name} ${h.text}\n# TYPE ${name} ${h.type}\n`;
        for (const s of list) { const l = Object.entries(s.labels); out += `${name}${l.length ? `{${l.map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}` : ""} ${s.value}\n`; }
      }
      return out;
    },
  };
}
