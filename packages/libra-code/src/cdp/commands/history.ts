import { CdpClient } from '../client.js';
export async function historyCommand(client: CdpClient, cmd: string) {
  await client.send('Page.enable');
  const hist = await client.send('Page.getNavigationHistory');
  const targetIdx = cmd === 'back' ? hist.currentIndex - 1 : hist.currentIndex + 1;
  if (targetIdx < 0 || targetIdx >= hist.entries.length) { throw new Error(`Cannot navigate ${cmd}: no entry at index ${targetIdx}`); }
  await client.send('Page.navigateToHistoryEntry', { entryId: hist.entries[targetIdx].id });
  console.log(`Navigated ${cmd} to: ${hist.entries[targetIdx].url}`);
}