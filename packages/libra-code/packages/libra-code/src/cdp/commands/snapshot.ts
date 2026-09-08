import { writeFileSync } from 'node:fs';
import { CdpClient } from '../client.js';
export async function snapshotCommand(client: CdpClient, args: string[]) {
  await client.send('Page.enable');
  const res = await client.send('Page.captureSnapshot', { format: 'mhtml' });
  const outPath = args[1] || `/tmp/cdp_snapshot_${Date.now()}.mhtml`;
  writeFileSync(outPath, res.data, 'utf-8');
  console.log(outPath);
}