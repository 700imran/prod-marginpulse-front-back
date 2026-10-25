import { resolveApiBaseUrl } from './BillingView';

describe('resolveApiBaseUrl', () => {
  const originalValue = process.env.REACT_APP_API_URL;

  beforeEach(() => {
    delete process.env.REACT_APP_API_URL;
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://app.marginpulse.in' },
      writable: true,
    });
  });

  afterAll(() => {
    if (originalValue === undefined) {
      delete process.env.REACT_APP_API_URL;
    } else {
      process.env.REACT_APP_API_URL = originalValue;
    }
  });

  it('uses the current origin when no environment API URL is configured', () => {
    expect(resolveApiBaseUrl()).toBe('https://app.marginpulse.in');
  });

  it('strips trailing slashes from a configured API URL', () => {
    process.env.REACT_APP_API_URL = 'https://api.marginpulse.in/';
    expect(resolveApiBaseUrl()).toBe('https://api.marginpulse.in');
  });
});
