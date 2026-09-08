import { CdpClient, getElementPoint } from '../client.js';
export async function typeCommand(client: CdpClient, args: string[]) {
  const target = args[1];
  const text = args.slice(2).join(' ');
  if (!target || !text) throw new Error('type requires a target and text (e.g. cdp type @4 28601)');
  const point = await getElementPoint(client, target);
  const x = point.x; const y = point.y;
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 50));
  for (const char of text) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp' });
    await new Promise((r) => setTimeout(r, 10));
  }
  const info = point.ref ? `[@${point.ref} ${point.matchedRole || point.tagName}]` : `[${point.tagName}${point.id ? '#' + point.id : ''}]`;
  console.log(`Typed into ${target} ${info}`);
}