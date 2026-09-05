import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';

// ── Load .env ────────────────────────────────────────────────────────
function loadEnv(): void {
  const envPaths = [
    new URL('./.env', import.meta.url).pathname,
    resolve(process.cwd(), '.env'),
  ];

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const clean = line.replace(/^export\s+/, '').trim();
        if (!clean || clean.startsWith('#')) continue;
        const match = clean.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (match && !process.env[match[1]]) {
          let val = match[2].trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          process.env[match[1]] = val;
        }
      }
    } catch {
      // Ignore read errors
    }
  }
}

loadEnv();

// ── Validate environment ─────────────────────────────────────────────
const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;

if (!botToken || !appToken) {
  console.error('Error: SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required.');
  console.error('Please configure them in .env (see .env.example).');
  process.exit(1);
}

const targetChannel = process.env.SLACK_CHANNEL?.replace(/^#/, '').trim();
const lcCwd = resolve(process.env.LC_CWD || process.cwd());
const lcSource = process.env.LC_SOURCE?.trim();

// ── LC command resolver ──────────────────────────────────────────────
interface ResolvedCommand {
  command: string;
  args: string[];
  description: string;
}

function resolveLcCommand(source?: string): ResolvedCommand {
  // 1. URL (e.g. tarball or git repo: https://... or http://...)
  if (source && /^https?:\/\//.test(source)) {
    return {
      command: 'npx',
      args: ['--yes', source],
      description: `URL (${source})`,
    };
  }

  // 2. Explicit path (or default relative path if no source specified)
  const defaultLocalDir = resolve(new URL('../../extras/libra-code', import.meta.url).pathname);
  const candidatePath = source ? resolve(process.cwd(), source) : defaultLocalDir;

  if (existsSync(candidatePath)) {
    const stat = statSync(candidatePath);
    if (stat.isDirectory()) {
      const pkgPath = join(candidatePath, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.lc;
          if (binEntry) {
            const binPath = join(candidatePath, binEntry);
            if (existsSync(binPath)) {
              return {
                command: process.execPath,
                args: [binPath],
                description: `Local directory (${candidatePath} -> ${binEntry})`,
              };
            }
          }
        } catch {}
      }

      // Check for dist/index.js
      const distIndex = join(candidatePath, 'dist/index.js');
      if (existsSync(distIndex)) {
        return {
          command: process.execPath,
          args: [distIndex],
          description: `Local dist (${distIndex})`,
        };
      }

      // Check for index.ts or index.tsx
      for (const entry of ['index.ts', 'index.tsx']) {
        const srcFile = join(candidatePath, entry);
        if (existsSync(srcFile)) {
          return {
            command: 'npx',
            args: ['tsx', srcFile],
            description: `Local TypeScript entry (${srcFile})`,
          };
        }
      }
    } else {
      // It's a file
      if (candidatePath.endsWith('.ts') || candidatePath.endsWith('.tsx')) {
        return {
          command: 'npx',
          args: ['tsx', candidatePath],
          description: `Local file (${candidatePath})`,
        };
      }
      return {
        command: process.execPath,
        args: [candidatePath],
        description: `Local file (${candidatePath})`,
      };
    }
  }

  // 3. npm package name (e.g. @xandout/libra-code, or source provided that isn't a local path)
  if (source) {
    return {
      command: 'npx',
      args: ['--yes', source],
      description: `npm package (${source})`,
    };
  }

  // 4. Fallback to global lc command
  return {
    command: 'lc',
    args: [],
    description: 'PATH (lc)',
  };
}

const resolvedLc = resolveLcCommand(lcSource);
console.log(`[lc] Resolved command: ${resolvedLc.command} ${resolvedLc.args.join(' ')}`);
console.log(`[lc] Source: ${resolvedLc.description}`);
console.log(`[lc] Working directory: ${lcCwd}`);

// ── Slack Bolt App ───────────────────────────────────────────────────
const app = new App({
  token: botToken,
  appToken: appToken,
  socketMode: true,
});

let botUserId: string | undefined;

// In-flight execution tracker: sessionKey -> ChildProcess
const inFlight = new Map<string, { proc: ChildProcess; channelId: string; threadTs?: string }>();
const activeThreads = new Set<string>();

// ── Slack reaction helpers ───────────────────────────────────────────
async function addReaction(client: WebClient, channel: string, timestamp: string, name: string): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp, name });
  } catch (err: any) {
    if (err?.data?.error !== 'already_reacted') {
      console.warn(`[slack] Failed to add reaction ${name}:`, err?.message || err);
    }
  }
}

async function removeReaction(client: WebClient, channel: string, timestamp: string, name: string): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp, name });
  } catch (err: any) {
    if (err?.data?.error !== 'no_reaction') {
      console.warn(`[slack] Failed to remove reaction ${name}:`, err?.message || err);
    }
  }
}

async function swapReaction(client: WebClient, channel: string, timestamp: string, from: string, to: string): Promise<void> {
  await removeReaction(client, channel, timestamp, from);
  await addReaction(client, channel, timestamp, to);
}

// ── Message formatting & posting ─────────────────────────────────────
async function postMessage(client: WebClient, channel: string, text: string, threadTs?: string): Promise<void> {
  const maxLen = 3900;
  if (text.length <= maxLen) {
    await client.chat.postMessage({
      channel,
      text,
      thread_ts: threadTs,
    });
    return;
  }

  // Split into multiple messages if length exceeds Slack limit
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await client.chat.postMessage({
      channel,
      text: chunk,
      thread_ts: threadTs,
    });
  }
}

function sessionKeyFor(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}:${threadTs}` : channel;
}

// ── Run LC subprocess ────────────────────────────────────────────────
async function executeLc(prompt: string, sessionKey: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise) => {
    const fullArgs = [...resolvedLc.args, prompt];
    const proc = spawn(resolvedLc.command, fullArgs, {
      cwd: lcCwd,
      env: {
        ...process.env,
      },
    });

    inFlight.set(sessionKey, { proc, channelId: sessionKey.split(':')[0], threadTs: sessionKey.split(':')[1] });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      inFlight.delete(sessionKey);
      resolvePromise({ stdout, stderr, exitCode: exitCode ?? 0 });
    });

    proc.on('error', (err) => {
      inFlight.delete(sessionKey);
      resolvePromise({ stdout, stderr: `${stderr}\n${err.message}`, exitCode: 1 });
    });
  });
}

// ── Slack event listeners ────────────────────────────────────────────

app.message(async ({ message, client, logger }) => {
  // Ignore unsupported subtypes
  const subtype = 'subtype' in message ? String(message.subtype || '') : '';
  if (subtype && subtype !== 'file_share') return;

  // Ignore bot's own messages
  const msgUser = 'user' in message && message.user ? String(message.user) : '';
  if (botUserId && msgUser === botUserId) return;

  if (!('channel' in message)) return;

  const channelId = message.channel as string;
  const rawText = ('text' in message ? (message.text || '') : '') as string;
  const messageTs = String(message.ts || '');
  const threadTs = 'thread_ts' in message ? String(message.thread_ts || '') : '';
  const channelType = 'channel_type' in message ? String(message.channel_type || '') : '';
  const isDm = channelType === 'im' || channelId.startsWith('D');

  if (targetChannel && !isDm && channelId !== targetChannel) {
    return;
  }

  const isMentioned = Boolean(botUserId) && rawText.includes(`<@${botUserId}>`);
  const isInActiveThread = Boolean(threadTs) && activeThreads.has(threadTs);

  if (!isDm && !isMentioned && !isInActiveThread) {
    return;
  }

  // Strip bot mention
  let cleanedText = rawText;
  if (botUserId) {
    cleanedText = cleanedText.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
  }

  if (!cleanedText) {
    await postMessage(client, channelId, 'How can I assist you with code?', isDm ? undefined : (threadTs || messageTs));
    return;
  }

  const sessionKey = sessionKeyFor(channelId, isDm ? undefined : (threadTs || messageTs));
  const replyThreadTs = isDm ? undefined : (threadTs || messageTs);

  // If already running for this session, notify user
  if (inFlight.has(sessionKey)) {
    await addReaction(client, channelId, messageTs, 'hourglass_flowing_sand');
    await postMessage(client, channelId, 'An `lc` task is already running in this thread. Please wait or use `/halt` to stop it.', replyThreadTs);
    return;
  }

  // Mark thinking
  await addReaction(client, channelId, messageTs, 'thinking_face');
  console.log(`[slack] Running lc for [${sessionKey}]: "${cleanedText.slice(0, 60)}"`);

  const { stdout, stderr, exitCode } = await executeLc(cleanedText, sessionKey);

  if (exitCode === 0) {
    await swapReaction(client, channelId, messageTs, 'thinking_face', 'white_check_mark');
    const reply = stdout.trim() || 'Done (no text output).';
    await postMessage(client, channelId, reply, replyThreadTs);
    if (replyThreadTs) activeThreads.add(replyThreadTs);
    console.log(`[slack] lc completed successfully for [${sessionKey}]`);
  } else {
    await swapReaction(client, channelId, messageTs, 'thinking_face', 'x');
    const errorDetails = stderr.trim() || stdout.trim() || `Process exited with code ${exitCode}`;
    await postMessage(client, channelId, `:x: **lc error**:\n\`\`\`\n${errorDetails.slice(-2000)}\n\`\`\``, replyThreadTs);
    console.error(`[slack] lc failed with exit code ${exitCode} for [${sessionKey}]`);
  }
});

// ── Slash Command: /halt ─────────────────────────────────────────────
app.command('/halt', async ({ command, ack, respond }) => {
  await ack();

  const channelId = command.channel_id;
  // Look for any active process in this channel
  let haltedCount = 0;
  for (const [key, item] of inFlight.entries()) {
    if (item.channelId === channelId) {
      try {
        item.proc.kill('SIGINT');
        haltedCount++;
      } catch {}
      inFlight.delete(key);
    }
  }

  if (haltedCount > 0) {
    await respond({ text: `⏹ Halted ${haltedCount} running \`lc\` process(es).`, response_type: 'ephemeral' });
  } else {
    await respond({ text: 'No active `lc` tasks running in this channel.', response_type: 'ephemeral' });
  }
});

// ── Start server ─────────────────────────────────────────────────────
(async () => {
  try {
    await app.start();
    const auth = await app.client.auth.test();
    botUserId = String(auth.user_id || '');

    console.log('⚡️ Slack-Libra-Code server is running in Socket Mode!');
    console.log(`  Bot User ID: ${botUserId}`);
    console.log(`  Target CWD:  ${lcCwd}`);
    console.log(`  Command:     ${resolvedLc.command} ${resolvedLc.args.join(' ')}`);
    console.log('  Listening for DMs and @mentions on Slack...');
  } catch (err) {
    console.error('Failed to start Slack app:', err);
    process.exit(1);
  }
})();
