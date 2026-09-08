import { CdpClient } from '../client.js';
export async function gotoCommand(client: CdpClient, args: string[]) {
  const url = args[1];
  if (!url) throw new Error('goto requires a URL');
  let timeout = 15000;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--timeout' && args[i + 1]) { timeout = parseInt(args[++i], 10); }
  }
  await client.send('Page.enable');
  const loadWait = new Promise((resolve) => client.on('Page.loadEventFired', resolve));
  await client.send('Page.navigate', { url });
  await Promise.race([ loadWait, new Promise((resolve) => setTimeout(resolve, timeout)) ]);
  console.log(`Navigated to ${url}`);
}