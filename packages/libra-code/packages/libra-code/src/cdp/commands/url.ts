import { CdpClient, evalJs } from '../client.js';
export async function urlCommand(client: CdpClient) {
  const currentUrl = await evalJs(client, 'location.href');
  console.log(currentUrl.value);
}