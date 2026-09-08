import { CdpClient, getElementPoint } from '../client.js';
export async function waitForCommand(client: CdpClient, args: string[]) {
  const target = args[1];
  if (!target) throw new Error('wait-for requires a target');
  const timeout = 10000;
  const start = Date.now();
  let found = false;
  while (Date.now() - start < timeout) {
    try { await getElementPoint(client, target); found = true; console.log(`Found ${target}`); break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!found) { throw new Error(`Timeout waiting for ${target}`); }
}