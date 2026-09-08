import { CDP_URL, fetchJson, getPageTargets } from '../utils.js';
export async function switchTabCommand(args: string[]) {
  const arg = args[1];
  if (!arg) throw new Error('switch-tab requires a tab ID or index (run "cdp tabs" to list)');
  let targetId = arg;
  if (/^\d+$/.test(arg)) {
    const targets = await getPageTargets();
    const idx = parseInt(arg, 10);
    if (targets[idx]) targetId = targets[idx].id;
    else throw new Error(`Tab index ${idx} out of range (0..${targets.length - 1})`);
  }
  await fetchJson(`${CDP_URL}/json/activate/${targetId}`, { method: 'PUT' }).catch(async () => {
    await fetchJson(`${CDP_URL}/json/activate/${targetId}`);
  });
  console.log(`Activated tab ${targetId}`);
}