import { getPageTargets } from '../utils.js';
export async function waitTabCommand(args: string[]) {
  const query = args[1] || '';
  let timeout = 15000;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--timeout' && args[i + 1]) { timeout = parseInt(args[++i], 10); }
  }
  const startTargets = await getPageTargets();
  const startCount = startTargets.length;
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const current = await getPageTargets();
    if (query && !/^\d+$/.test(query)) {
      const q = query.toLowerCase();
      const found = current.find((t: any) => (t.title && t.title.toLowerCase().includes(q)) || (t.url && t.url.toLowerCase().includes(q)));
      if (found) { console.log(`Found tab [id: ${found.id}]: ${found.title || '(untitled)'} — ${found.url}`); return; }
    } else if (current.length > startCount) {
      const newTab = current[current.length - 1];
      console.log(`Found new tab [id: ${newTab.id}]: ${newTab.title || '(untitled)'} — ${newTab.url}`); return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timeout waiting for tab${query ? ' matching: ' + query : ''}`);
}