import { CdpClient } from '../client.js';
export async function scrollCommand(client: CdpClient, args: string[]) {
  const dir = args[1] === 'up' ? -1 : 1;
  const amount = args[2] ? parseInt(args[2], 10) : 500;
  await client.send('Input.synthesizeScrollGesture', { x: 100, y: 100, xDistance: 0, yDistance: dir * amount, repeatCount: 1, repeatDelayMs: 0, interactionMarkerName: 'scroll' });
  console.log(`Scrolled ${dir > 0 ? 'down' : 'up'} by ${amount}px`);
}