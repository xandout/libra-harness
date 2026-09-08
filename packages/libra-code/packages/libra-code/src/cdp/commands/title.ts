import { CdpClient, evalJs } from '../client.js';
export async function titleCommand(client: CdpClient) {
  const title = await evalJs(client, 'document.title');
  console.log(title.value);
}