import { CdpClient, evalJs } from '../client.js';
export async function evalCommand(client: CdpClient, args: string[]) {
  const expr = args.slice(1).join(' ');
  if (!expr) throw new Error('eval requires a JS expression');
  const res = await evalJs(client, expr);
  console.log(typeof res.value === 'object' ? JSON.stringify(res.value, null, 2) : res.value);
}