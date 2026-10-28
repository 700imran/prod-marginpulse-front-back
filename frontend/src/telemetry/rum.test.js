jest.mock('../security/tokenManager', () => ({ tokenManager: { getAccessToken: jest.fn(() => 'tok') } }));
const rum = require('./rum');
const { tokenManager } = require('../security/tokenManager');

beforeEach(() => { rum.__reset(); localStorage.clear(); global.fetch = jest.fn(() => Promise.resolve({ ok: true })); tokenManager.getAccessToken.mockReturnValue('tok'); });

test('feature load: first visit is cold, later visits are warm', async () => {
  rum.startFeature('gst'); rum.endFeature('gst'); await new Promise((r) => setTimeout(r, 60));
  rum.startFeature('gst'); rum.endFeature('gst'); await new Promise((r) => setTimeout(r, 60));
  const q = rum.__queue().filter((e) => e.t === 'feature');
  expect(q.map((e) => e.temp)).toEqual(['cold', 'warm']);
  expect(q[0].view).toBe('gst');
  expect(Number.isInteger(q[0].v) && q[0].v >= 0).toBe(true);
});

test('APP_READY is reported once', async () => {
  rum.markAppReady(); rum.markAppReady(); await new Promise((r) => setTimeout(r, 60));
  expect(rum.__queue().filter((e) => e.name === 'APP_READY')).toHaveLength(1);
});

test('errors are de-duplicated and capped, messages truncated', () => {
  for (let i = 0; i < 30; i++) rum.reportError('js', 'same');
  expect(rum.__queue()).toHaveLength(1);
  rum.reportError('js', 'x'.repeat(500));
  expect(rum.__queue()[1].msg.length).toBe(160);
  for (let i = 0; i < 30; i++) rum.reportError('promise', 'e' + i);
  expect(rum.__queue().length).toBeLessThanOrEqual(10);
});

test('flush sends an authenticated keepalive beacon with at most 25 events; nothing without a token', () => {
  for (let i = 0; i < 12; i++) { rum.startFeature('team'); rum.endFeature('team'); }
  rum.reportError('js', 'boom');
  rum.flush();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/v1\/telemetry$/);
  expect(init.keepalive).toBe(true);
  expect(init.headers.Authorization).toBe('Bearer tok');
  expect(JSON.parse(init.body).events.length).toBeLessThanOrEqual(25);

  rum.__reset(); global.fetch.mockClear(); tokenManager.getAccessToken.mockReturnValue('');
  rum.reportError('js', 'no token'); rum.flush();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('user can opt out and nothing is collected or sent', () => {
  localStorage.setItem('mp_telemetry_off', '1');
  rum.reportError('js', 'secret'); rum.flush();
  expect(rum.__queue()).toHaveLength(0);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('a failing network never throws into the app', () => {
  global.fetch = jest.fn(() => Promise.reject(new Error('offline')));
  rum.reportError('js', 'x');
  expect(() => rum.flush()).not.toThrow();
});
