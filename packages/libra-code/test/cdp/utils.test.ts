import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dns from 'node:dns/promises';

vi.mock('node:dns/promises');

describe('cdp utils', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolves cdp hostname to IP', async () => {
    process.env.CHROME_CDP_URL = 'http://ronny-browser:18800';
    const utils = await import('../../src/cdp/utils.js');
    
    vi.mocked(dns.lookup).mockResolvedValue({ address: '172.18.0.8', family: 4 });
    await utils.initCdpUrl();
    expect(dns.lookup).toHaveBeenCalledWith('ronny-browser');
    expect(utils.CDP_URL).toBe('http://172.18.0.8:18800');
  });
});
