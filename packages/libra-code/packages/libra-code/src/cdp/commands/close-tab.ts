import { CDP_URL, fetchJson, getActivePageTarget } from '../utils.js';
export async function closeTabCommand(args: string[]) {
  let targetId = args[1];
  if (!targetId) {
    const active = await getActivePageTarget();
    targetId = active.id;
  }
  await fetchJson(`${CDP_URL}/json/close/${targetId}`, { method: 'PUT' }).catch(async () => {
    await fetchJson(`${CDP_URL}/json/close/${targetId}`);
  });
  console.log(`Closed tab ${targetId}`);
}