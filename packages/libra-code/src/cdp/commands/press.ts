import { CdpClient } from '../client.js';
import { KEY_MAP } from '../utils.js';
export async function pressCommand(client: CdpClient, args: string[]) {
  const keyName = args[1];
  if (!keyName) throw new Error('press requires a key name (e.g. Enter, Tab, Escape, Backspace, ArrowDown)');
  const lookup = KEY_MAP[keyName.toLowerCase()] || { code: keyName, key: keyName };
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: lookup.key, code: lookup.code, windowsVirtualKeyCode: lookup.keyCode, text: lookup.text });
  await new Promise((r) => setTimeout(r, 20));
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: lookup.key, code: lookup.code, windowsVirtualKeyCode: lookup.keyCode });
  console.log(`Pressed key: ${lookup.key}`);
}