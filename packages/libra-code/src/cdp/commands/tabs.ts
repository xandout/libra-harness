import { getPageTargets } from '../utils.js';
export async function tabsCommand() {
  const targets = await getPageTargets();
  if (targets.length === 0) { console.log('No open tabs found.'); return; }
  targets.forEach((t, i) => { console.log(`[${i}] ${t.title || '(untitled)'} — ${t.url} (id: ${t.id})`); });
}