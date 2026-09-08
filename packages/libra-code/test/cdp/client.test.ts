import { describe, it, expect, vi } from 'vitest';
import { CdpClient } from '../../src/cdp/client.js';

describe('CdpClient', () => {
  it('initializes correctly', () => {
    // Mock global WebSocket
    globalThis.WebSocket = class WebSocket {
      onmessage: any;
      onopen: any;
      onerror: any;
      constructor(public url: string) {}
      send() {}
      close() {}
    } as any;
    
    const client = new CdpClient('ws://localhost:18800');
    expect(client).toBeDefined();
    
    let fired = false;
    client.on('Test.event', () => { fired = true; });
    
    // Simulate incoming message
    const ws = (client as any).ws;
    ws.onmessage({ data: JSON.stringify({ method: 'Test.event', params: {} }) });
    
    expect(fired).toBe(true);
  });
});
