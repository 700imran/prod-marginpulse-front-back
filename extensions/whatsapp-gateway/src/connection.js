// Baileys wiring. `baileys` is injected (the real module in server.js, a fake in tests) so the reconnect/backoff/session
// logic below is exercised without WhatsApp. NOT covered by tests (needs a real phone): the actual QR pairing and delivery.
export function createConnection({ baileys: b, authDir, onMessage, onQr, log = console, metrics, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random, now = Date.now, logger, sendLimit = { max: 20, windowMs: 60_000 } }) {
  let sock = null, state = "starting", qr = null, attempt = 0, stopped = false, generation = 0;
  const sent = [];
  metrics?.describe("mp_wa_connection_up", "1 while the WhatsApp session is connected", "gauge");
  metrics?.describe("mp_wa_reconnects_total", "Reconnect attempts, by disconnect status code");
  metrics?.set("mp_wa_connection_up", 0);

  const backoff = () => Math.min(60_000, 1000 * 2 ** attempt++) * (0.5 + random() / 2);

  async function connect() {
    const gen = ++generation;
    try {
      const { state: auth, saveCreds } = await b.useMultiFileAuthState(authDir);
      let version; try { ({ version } = await b.fetchLatestBaileysVersion()); } catch { /* keep the library's bundled version */ }
      const s = b.default({ auth, version, logger, browser: b.Browsers.macOS("Desktop"), syncFullHistory: false, markOnlineOnConnect: false });
      sock = s;
      s.ev.on("creds.update", saveCreds);
      s.ev.on("connection.update", async (u) => {
        if (gen !== generation) return; // a newer socket superseded this one
        if (u.qr) { qr = u.qr; state = "qr"; onQr?.(u.qr); }
        if (u.connection === "open") { state = "open"; qr = null; attempt = 0; metrics?.set("mp_wa_connection_up", 1); log.info?.(JSON.stringify({ level: "info", msg: "wa_connected" })); }
        if (u.connection === "close") {
          metrics?.set("mp_wa_connection_up", 0);
          const code = u.lastDisconnect?.error?.output?.statusCode;
          if (code === b.DisconnectReason.loggedOut) { state = "logged_out"; log.error?.(JSON.stringify({ level: "error", msg: "wa_logged_out", hint: "The phone unlinked this session. Delete the auth directory and restart to scan a new QR." })); return; }
          if (stopped) return;
          state = "reconnecting"; metrics?.inc("mp_wa_reconnects_total", { reason: String(code ?? "unknown") });
          const delay = code === b.DisconnectReason.restartRequired ? 0 : backoff();
          log.warn?.(JSON.stringify({ level: "warn", msg: "wa_disconnected", code, retryInMs: Math.round(delay) }));
          await sleep(delay);
          if (!stopped && gen === generation) connect();
        }
      });
      s.ev.on("messages.upsert", ({ messages, type }) => {
        if (type !== "notify") return; // history/append sync is not new mail
        for (const m of messages) {
          Promise.resolve(onMessage(m, {
            download: () => b.downloadMediaMessage(m, "buffer", {}, { logger, reuploadRequest: s.updateMediaMessage }),
            sendText: (to, text) => sendText(to, text),
          })).catch((e) => log.error?.(JSON.stringify({ level: "error", msg: "wa_handler_failed", error: String(e?.message ?? e) })));
        }
      });
    } catch (e) {
      // e.g. corrupt auth dir, transient network failure while starting: retry with backoff instead of crashing the process.
      state = "reconnecting"; metrics?.inc("mp_wa_reconnects_total", { reason: "start_error" });
      const delay = backoff();
      log.error?.(JSON.stringify({ level: "error", msg: "wa_start_failed", error: String(e?.message ?? e), retryInMs: Math.round(delay) }));
      await sleep(delay);
      if (!stopped && gen === generation) return connect();
    }
  }

  async function sendText(to, text) {
    if (state !== "open" || !sock) throw new Error("WhatsApp is not connected");
    if (!/^\d{8,15}$/.test(String(to))) throw new Error("invalid recipient");
    const t = now(); while (sent.length && t - sent[0] > sendLimit.windowMs) sent.shift();
    if (sent.length >= sendLimit.max) throw new Error("send rate limit reached (protects the number from being flagged)");
    sent.push(t);
    await sock.sendMessage(`${to}@s.whatsapp.net`, { text: String(text).slice(0, 1000) });
  }

  return { start: connect, sendText, getState: () => state, getQr: () => qr, stop() { stopped = true; try { sock?.end?.(undefined); } catch { /* ignore */ } } };
}
