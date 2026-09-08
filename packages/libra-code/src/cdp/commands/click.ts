import { CdpClient, getElementPoint } from '../client.js';
export async function clickCommand(client: CdpClient, args: string[]) {
  const target = args[1];
  if (!target) throw new Error('click requires a target (e.g. @3, "button:Search", "text=Search", or "#subBtn")');
  const point = await getElementPoint(client, target);
  const x = point.x; const y = point.y;
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  const info = point.ref ? `[@${point.ref} ${point.matchedRole || point.tagName}: ${point.matchedName || point.text || ''}]` : `[${point.tagName}${point.id ? '#' + point.id : ''}]`;
  console.log(`Clicked ${target} at (${Math.round(x)}, ${Math.round(y)}) ${info}`);
}