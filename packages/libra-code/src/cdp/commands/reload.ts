import { CdpClient } from '../client.js';
export async function reloadCommand(client: CdpClient) {
  await client.send('Page.enable');
  await client.send('Page.reload', { ignoreCache: true });
  console.log('Reloaded page');
}