import { CdpClient } from '../client.js';
import { renderAxTree, extractDomSemanticTree } from '../dom.js';
export async function axCommand(client: CdpClient, args: string[]) {
  const maxDepth = args[1] ? parseInt(args[1], 10) : 8;
  let rendered: string | null = null;
  try {
    await client.send('DOM.enable', {}, undefined, 4000).catch(() => {});
    await client.send('Accessibility.enable', {}, undefined, 4000).catch(() => {});
    const res = await client.send('Accessibility.getFullAXTree', { depth: maxDepth, max_depth: maxDepth }, undefined, 7000);
    if (res && res.nodes && res.nodes.length > 0) { rendered = renderAxTree(res.nodes, maxDepth); }
  } catch (err) {}
  if (!rendered || rendered === '(empty accessibility tree)') { rendered = await extractDomSemanticTree(client, maxDepth); }
  console.log(rendered);
}