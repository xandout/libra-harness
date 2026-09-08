import { CdpClient, getElementPoint, evalJs } from '../client.js';
export async function selectAllCommand(client: CdpClient, args: string[]) {
  const target = args[1];
  if (target) {
    const point = await getElementPoint(client, target);
    const x = point.x; const y = point.y;
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 50));
  }
  await evalJs(client, `(() => {
    const el = document.activeElement;
    if (el && (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea')) {
      el.select();
    } else if (el && el.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.body);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  })()`);
  console.log(`Selected all text${target ? ' in ' + target : ''}`);
}