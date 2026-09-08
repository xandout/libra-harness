import { CdpClient, getElementPoint, evalJs } from '../client.js';
export async function selectCommand(client: CdpClient, args: string[]) {
  const target = args[1];
  const value = args.slice(2).join(' ');
  if (!target || !value) throw new Error('select requires a target and option value/text (e.g. cdp select @4 50 or cdp select "select#size" "Large")');
  const point = await getElementPoint(client, target);
  const x = point.x; const y = point.y;
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 50));
  const selectResult = await evalJs(client, `(() => {
    const el = document.activeElement;
    if (!el || el.tagName.toLowerCase() !== 'select') { return { error: 'Target element is not a <select>' }; }
    const val = ${JSON.stringify(value)}.toLowerCase();
    const options = Array.from(el.options);
    let opt = options.find(o => o.value.toLowerCase() === val);
    if (!opt) opt = options.find(o => o.text.trim().toLowerCase() === val);
    if (!opt) opt = options.find(o => o.text.trim().toLowerCase().includes(val));
    if (!opt) { return { error: 'Option not found in <select>: ' + ${JSON.stringify(value)} }; }
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (desc && desc.set) { desc.set.call(el, opt.value); } else { el.value = opt.value; }
    opt.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selectedValue: opt.value, selectedText: opt.text.trim() };
  })()`);
  if (selectResult && selectResult.value && selectResult.value.error) { throw new Error(selectResult.value.error); }
  const resVal = selectResult?.value;
  const info = point.ref ? `[@${point.ref} select]` : `[select${point.id ? '#' + point.id : ''}]`;
  console.log(`Selected "${resVal?.selectedText || value}" (value: "${resVal?.selectedValue || value}") in ${target} ${info}`);
}