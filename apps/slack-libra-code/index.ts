import { readFileSync, appendFileSync, existsSync, statSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
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
const libraHome = process.env.LIBRA_HOME || resolve(lcCwd, '.libra');
const lcSource = process.env.LC_SOURCE?.trim();

// ── LC command resolver ──────────────────────────────────────────────
interface ResolvedCommand {
  command: string;
  args: string[];
  description: string;
}

// fallow-ignore-next-line complexity
function resolveLcCommand(source?: string): ResolvedCommand {
  // 1. URL (e.g. tarball or git repo: https://... or http://...)
  if (source && /^https?:\/\//.test(source)) {
    return {
      command: 'npx',
      args: ['--yes', source],
      description: `URL (${source})`,
    };
  }

  // 2. System binary (preferred in container environment)
  if (!source && existsSync('/usr/local/bin/lc')) {
    return {
      command: '/usr/local/bin/lc',
      args: [],
      description: 'System binary (/usr/local/bin/lc)',
    };
  }

  // 3. Explicit path (or default relative path if no source specified)
  const defaultLocalDir = resolve(new URL('../../packages/libra-code', import.meta.url).pathname);
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

  // 3. npm package name (e.g. @xandout/libra-code)
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
console.log(`[lc] Libra home: ${libraHome}`);

// ── Slack Bolt App ───────────────────────────────────────────────────
const app = new App({
  token: botToken,
  appToken: appToken,
  socketMode: true,
});

let botUserId: string | undefined;

// In-flight execution tracker
interface InFlightTurn {
  proc: ChildProcess;
  channelId: string;
  threadTs?: string;
  steer: (text: string) => void;
  halt: (reason?: string) => void;
}

const inFlight = new Map<string, InFlightTurn>();
const activeThreads = new Set<string>();

// ── Helpers for Turn Steer & Halt via Journal Commands ───────────────
function getActiveTurnId(sessionKey: string, homeDir: string): string | null {
  const lockFile = join(homeDir, 'locks', `${sessionKey}.lock`);
  try {
    if (existsSync(lockFile)) {
      const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
      return lock.turnId || null;
    }
  } catch {}
  return null;
}

async function sendSocketCommand(
  homeDir: string,
  sessionKey: string,
  cmd: { type: 'steer'; text: string } | { type: 'halt'; reason?: string },
): Promise<boolean> {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const sockPath = join(homeDir, 'sockets', `${safe}.sock`);
  if (!existsSync(sockPath)) return false;

  return new Promise<boolean>((resolve) => {
    const client = net.createConnection(sockPath);
    client.once('connect', () => {
      client.write(JSON.stringify(cmd) + '\n');
      client.end();
      resolve(true);
    });
    client.once('error', () => resolve(false));
    setTimeout(() => {
      try { client.destroy(); } catch {}
      resolve(false);
    }, 500);
  });
}

function writeTurnCommand(
  homeDir: string,
  turnId: string,
  cmd: { type: 'steer'; text: string } | { type: 'halt'; reason: string },
): void {
  const turnsDir = join(homeDir, 'turns');
  const cmdFile = join(turnsDir, `${turnId}.cmd.jsonl`);
  try {
    appendFileSync(cmdFile, JSON.stringify(cmd) + '\n', 'utf-8');
  } catch (err) {
    console.error(`[turn] Failed to write command to ${cmdFile}:`, err);
  }
}

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

// ── Run LC subprocess with Steer & Halt integration ──────────────────
async function executeLc(
  prompt: string,
  sessionKey: string,
  channelId: string,
  threadTs?: string,
  onProgress?: (status: string) => void,
  onMessage?: (text: string) => void,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise) => {
    // Prefer standard /usr/local/bin if present (avoids leaking /app path into the agent's PATH)
    const existingPath = process.env.PATH || '';
    const binDir = resolve(new URL('./bin', import.meta.url).pathname);
    const augmentedPath = existsSync('/usr/local/bin/cdp')
      ? existingPath
      : (existsSync(binDir) ? `${binDir}:${existingPath}` : existingPath);

    const fullArgs = [...resolvedLc.args, '--session', sessionKey, prompt];
    const sharedSkillsDir = resolve(new URL('../../skills', import.meta.url).pathname);
    const localSkillsDir = resolve(new URL('./skills', import.meta.url).pathname);
    const devSkillsDirs = [sharedSkillsDir, localSkillsDir].filter(existsSync).join(':');
    const skillsDir = process.env.LIBRA_SKILLS_DIR || (existsSync('/opt/skills') ? '/opt/skills' : devSkillsDirs);

    const proc = spawn(resolvedLc.command, fullArgs, {
      cwd: lcCwd,
      env: {
        ...process.env,
        PATH: augmentedPath,
        LC_CWD: lcCwd,
        LIBRA_HOME: libraHome,
        LIBRA_SKILLS_DIR: skillsDir,
        SLACK_BOT_TOKEN: botToken,
        SLACK_CHANNEL_ID: channelId,
        SLACK_THREAD_TS: threadTs || '',
        DISPLAY: process.env.DISPLAY || ':99',
      },
    });

    const steer = (text: string) => {
      sendSocketCommand(libraHome, sessionKey, { type: 'steer', text }).then((sent) => {
        if (sent) {
          console.log(`[turn] Steer sent via socket for [${sessionKey}]: "${text.slice(0, 50)}"`);
        } else {
          const turnId = getActiveTurnId(sessionKey, libraHome);
          if (turnId) writeTurnCommand(libraHome, turnId, { type: 'steer', text });
        }
      });
    };

    const halt = (reason?: string) => {
      sendSocketCommand(libraHome, sessionKey, { type: 'halt', reason }).then((sent) => {
        if (sent) {
          console.log(`[turn] Halt sent via socket for [${sessionKey}]`);
        } else {
          const turnId = getActiveTurnId(sessionKey, libraHome);
          if (turnId) writeTurnCommand(libraHome, turnId, { type: 'halt', reason: reason || 'halted' });
        }
      });
      try { proc.kill('SIGINT'); } catch {}
    };

    inFlight.set(sessionKey, { proc, channelId, threadTs, steer, halt });

    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';

    proc.stdout?.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);

      stdoutBuffer += text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('⟦blurb:') && trimmed.endsWith('⟧')) {
          try {
            const rawJson = trimmed.slice(7, -1);
            const blurb = JSON.parse(rawJson);
            if (typeof blurb === 'string' && blurb.trim()) {
              onMessage?.(blurb.trim());
            }
          } catch {}
        }
      }
    });

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
      if (onProgress) {
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.trim().startsWith('→ ')) {
            onProgress(line.trim().slice(2));
          }
        }
      }
    });

    proc.on('close', (exitCode) => {
      if (stdoutBuffer) {
        const trimmed = stdoutBuffer.trim();
        if (trimmed.startsWith('⟦blurb:') && trimmed.endsWith('⟧')) {
          try {
            const rawJson = trimmed.slice(7, -1);
            const blurb = JSON.parse(rawJson);
            if (typeof blurb === 'string' && blurb.trim()) {
              onMessage?.(blurb.trim());
            }
          } catch {}
        }
      }
      inFlight.delete(sessionKey);
      resolvePromise({ stdout, stderr, exitCode: exitCode ?? 0 });
    });

    proc.on('error', (err) => {
      inFlight.delete(sessionKey);
      resolvePromise({ stdout, stderr: `${stderr}\n${err.message}`, exitCode: 1 });
    });
  });
}

// ── Turn runner helper ───────────────────────────────────────────────
async function runTurn(opts: {
  channelId: string;
  threadTs?: string;
  messageTs: string;
  cleanedText: string;
  client: WebClient;
  isDm: boolean;
}): Promise<void> {
  const { channelId, threadTs, messageTs, cleanedText, client, isDm } = opts;
  const sessionKey = sessionKeyFor(channelId, isDm ? undefined : (threadTs || messageTs));
  const replyThreadTs = isDm ? undefined : (threadTs || messageTs);

  // If already running for this session, STEER it!
  if (inFlight.has(sessionKey)) {
    const active = inFlight.get(sessionKey)!;
    await addReaction(client, channelId, messageTs, 'eyes');
    active.steer(cleanedText);
    console.log(`[slack] Steered running turn for [${sessionKey}] with: "${cleanedText.slice(0, 50)}"`);
    return;
  }

  // Mark thinking
  await addReaction(client, channelId, messageTs, 'thinking_face');
  console.log(`[slack] Running lc for [${sessionKey}]: "${cleanedText.slice(0, 60)}"`);

  let statusMsgTs: string | undefined;
  let lastUpdate = 0;
  let postedBlurbsCount = 0;
  
  const onProgress = async (status: string) => {
    // Only update every 3 seconds to avoid rate limits
    if (Date.now() - lastUpdate < 3000) return;
    lastUpdate = Date.now();
    try {
      if (!statusMsgTs && replyThreadTs) {
         const res = await client.chat.postMessage({
           channel: channelId,
           text: `_⏳ Running tool: ${status}..._`,
           thread_ts: replyThreadTs,
         });
         statusMsgTs = res.ts;
      } else if (statusMsgTs && replyThreadTs) {
         await client.chat.update({
           channel: channelId,
           ts: statusMsgTs,
           text: `_⏳ Running tool: ${status}..._`,
         });
      }
    } catch (e) {
      // ignore
    }
  };

  const onMessage = async (blurb: string) => {
    try {
      postedBlurbsCount++;
      await postMessage(client, channelId, blurb, replyThreadTs);
      if (replyThreadTs) activeThreads.add(replyThreadTs);
    } catch (e) {
      console.error(`[slack] Failed to post blurb to [${sessionKey}]:`, e);
    }
  };

  const { stdout, stderr, exitCode } = await executeLc(cleanedText, sessionKey, channelId, replyThreadTs, onProgress, onMessage);
  
  if (statusMsgTs) {
    try {
      await client.chat.delete({ channel: channelId, ts: statusMsgTs });
    } catch (e) {
      // ignore
    }
  }

  // Clean out internal delimiter markers from stdout
  const cleanStdout = stdout
    .replace(/\n?⟦blurb:.*?⟧\n?/g, '')
    .trim();

  if (exitCode === 0) {
    try { await swapReaction(client, channelId, messageTs, 'thinking_face', 'white_check_mark'); } catch {}
    if (postedBlurbsCount === 0) {
      const reply = cleanStdout || 'Done (no text output).';
      await postMessage(client, channelId, reply, replyThreadTs);
      if (replyThreadTs) activeThreads.add(replyThreadTs);
    }
    console.log(`[slack] lc completed successfully for [${sessionKey}]`);
  } else {
    try { await swapReaction(client, channelId, messageTs, 'thinking_face', 'x'); } catch {}
    const errorDetails = stderr.trim() || cleanStdout || `Process exited with code ${exitCode}`;
    await postMessage(client, channelId, `:x: **lc error**:\n\`\`\`\n${errorDetails.slice(-2000)}\n\`\`\``, replyThreadTs);
    console.error(`[slack] lc failed with exit code ${exitCode} for [${sessionKey}]`);
  }
}

// ── Slack message listener ───────────────────────────────────────────
// fallow-ignore-next-line complexity
app.message(async ({ message, client }) => {
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

  try {
    await runTurn({
      channelId,
      threadTs: threadTs || undefined,
      messageTs,
      cleanedText,
      client,
      isDm,
    });
  } catch (err: any) {
    console.error(`[slack] runTurn threw for [${channelId}]:`, err?.message || err);
    try {
      await postMessage(client, channelId, `:warning: Error: ${err?.message || String(err)}`, isDm ? undefined : (threadTs || messageTs));
    } catch {}
  }
});

// ── Slash Command: /ronny ───────────────────────────────────────────────
// OpenClaw style slash command supporting halt, steer, status, and prompts
// fallow-ignore-next-line complexity
const slashCommand = process.env.SLACK_SLASH_COMMAND || '/ronny';
app.command(slashCommand, async ({ command, ack, respond, client }) => {
  await ack();
  const text = (command.text || '').trim();
  const channelId = command.channel_id;
  const isDm = channelId.startsWith('D');
  const messageTs = command.thread_ts || command.ts || String(Date.now() / 1000);
  const sessionKey = command.thread_ts 
    ? `slack_${channelId}_${command.thread_ts}` 
    : `slack_${channelId}`;

  // 1. Halt
  if (text.startsWith('halt') || text.startsWith('stop') || text.startsWith('cancel')) {
    const reason = text.replace(/^(halt|stop|cancel)\s*/i, '').trim();
    let halted = 0;
    for (const [key, item] of inFlight.entries()) {
      if (key === sessionKey || (!command.thread_ts && key.startsWith(`slack_${channelId}`))) {
        item.halt(reason || 'user halted via Slack');
        halted++;
      }
    }
    if (halted > 0) {
      await respond({ text: `⏹ Halted ${halted} active \`lc\` turn(s).`, response_type: 'ephemeral' });
    } else {
      const sent = await sendSocketCommand(libraHome, sessionKey, { type: 'halt', reason: reason || 'user halted via Slack' });
      if (sent) {
        await respond({ text: `⏹ Halt signal sent to active session \`${sessionKey}\`.`, response_type: 'ephemeral' });
      } else {
        await respond({ text: 'No active turn found to halt.', response_type: 'ephemeral' });
      }
    }
    return;
  }

  // 2. Steer
  if (text.startsWith('steer')) {
    const message = text.replace(/^steer\s*/i, '').trim();
    if (!message) {
      await respond({ text: 'Usage: `/ronny steer <message to inject into active turn>`', response_type: 'ephemeral' });
      return;
    }
    let steered = false;
    for (const [key, item] of inFlight.entries()) {
      if (key === sessionKey || (!command.thread_ts && key.startsWith(`slack_${channelId}`))) {
        item.steer(message);
        steered = true;
        await respond({ text: `↪️ Steered active turn with: "${message}"`, response_type: 'ephemeral' });
        break;
      }
    }
    if (!steered) {
      const sent = await sendSocketCommand(libraHome, sessionKey, { type: 'steer', text: message });
      if (sent) {
        await respond({ text: `↪️ Steered active session \`${sessionKey}\` with: "${message}"`, response_type: 'ephemeral' });
      } else {
        await respond({ text: 'No active turn found to steer.', response_type: 'ephemeral' });
      }
    }
    return;
  }

  // 3. Status
  if (text === 'status') {
    const activeList = Array.from(inFlight.keys());

    let configuredModel = process.env.LIBRA_MODEL || process.env.MODEL || '(default)';
    let maxContextMessages = process.env.LIBRA_MAX_CONTEXT_MESSAGES ? parseInt(process.env.LIBRA_MAX_CONTEXT_MESSAGES, 10) : 100;
    try {
      const cfgPath = join(libraHome, 'config.json');
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
        if (cfg.model) configuredModel = cfg.model;
        if (cfg.maxContextMessages) maxContextMessages = Number(cfg.maxContextMessages);
      }
    } catch {}

    const statusLines = [
      `*Slack-Libra-Code Status*`,
      `• Active Turns: ${activeList.length ? activeList.map((k) => `\`${k}\``).join(', ') : 'None (idle)'}`,
      `• Target CWD: \`${lcCwd}\``,
      `• Model: \`${configuredModel}\``,
    ];

    const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const altKey = sessionKeyFor(channelId, command.thread_ts).replace(/[^a-zA-Z0-9_-]/g, '_');
    const possiblePaths = [
      join(libraHome, 'sessions', `${sessionKey}.jsonl`),
      join(libraHome, 'sessions', `${safeKey}.jsonl`),
      join(libraHome, 'sessions', `${altKey}.jsonl`),
    ];
    const sessionFile = possiblePaths.find((p) => existsSync(p));

    statusLines.push('');
    statusLines.push(`*Context Window & Token Stats*`);

    if (sessionFile) {
      const lines = readFileSync(sessionFile, 'utf-8').split('\n').filter((l) => l.trim());
      const records: any[] = [];
      for (const line of lines) {
        try { records.push(JSON.parse(line)); } catch {}
      }

      // Filter conversation messages (exclude control)
      const convRecords = records.filter((r) => r.role !== 'control');
      const totalHistoryCount = convRecords.length;

      // Active context window: up to maxContextMessages
      const activeWindowRecords = convRecords.slice(-maxContextMessages);
      const activeWindowCount = activeWindowRecords.length;

      let isCompacted = false;
      let compactedCycles = 0;
      let lastPromptTokens: number | undefined;
      let lastCachedTokens: number | undefined;
      let lastCompletionTokens: number | undefined;
      let lastReasoningTokens: number | undefined;
      let totalPromptTokens = 0;
      let totalCachedTokens = 0;
      let totalCompletionTokens = 0;
      let totalReasoningTokens = 0;
      let turnsWithUsage = 0;
      let turnsCount = 0;

      for (const rec of records) {
        if (rec.role === 'assistant') {
          turnsCount++;
          const contentStr = typeof rec.content === 'string' ? rec.content : '';
          if (contentStr.startsWith('[Session summary') || contentStr.startsWith('[Conversation summary')) {
            isCompacted = true;
            compactedCycles++;
          }
          if (rec.usage) {
            turnsWithUsage++;
            lastPromptTokens = rec.usage.promptTokens;
            lastCachedTokens = rec.usage.cachedPromptTokens;
            lastCompletionTokens = rec.usage.completionTokens;
            lastReasoningTokens = rec.usage.reasoningTokens;

            totalPromptTokens += rec.usage.promptTokens || 0;
            totalCachedTokens += rec.usage.cachedPromptTokens || 0;
            totalCompletionTokens += rec.usage.completionTokens || 0;
            totalReasoningTokens += rec.usage.reasoningTokens || 0;
          }
        }
      }

      statusLines.push(`• Active Context Window: *${activeWindowCount}* / ${maxContextMessages} messages`);
      statusLines.push(`• Total Session History: *${totalHistoryCount}* messages across *${turnsCount}* turn${turnsCount === 1 ? '' : 's'}`);

      if (isCompacted) {
        statusLines.push(`• Compaction: *Active* (${compactedCycles} auto-summarization cycle${compactedCycles > 1 ? 's' : ''} completed)`);
      } else if (totalHistoryCount >= maxContextMessages) {
        statusLines.push(`• Compaction: *At threshold* (auto-summarization next turn)`);
      } else {
        statusLines.push(`• Compaction: *Standard* (${maxContextMessages - totalHistoryCount} message${maxContextMessages - totalHistoryCount === 1 ? '' : 's'} remaining until threshold)`);
      }

      if (lastPromptTokens !== undefined) {
        if (lastCachedTokens && lastCachedTokens > 0) {
          const cachePct = ((lastCachedTokens / lastPromptTokens) * 100).toFixed(1);
          statusLines.push(`• Last Turn Prompt: *${lastPromptTokens.toLocaleString()}* tokens (*${lastCachedTokens.toLocaleString()}* cached, *${cachePct}%* cache hit rate)`);
        } else {
          statusLines.push(`• Last Turn Prompt: *${lastPromptTokens.toLocaleString()}* tokens (0% cached)`);
        }
      }

      if (lastCompletionTokens !== undefined) {
        const reasoning = lastReasoningTokens ? ` (${lastReasoningTokens.toLocaleString()} thinking)` : '';
        statusLines.push(`• Last Turn Output: *${lastCompletionTokens.toLocaleString()}* completion tokens${reasoning}`);
      }

      if (totalPromptTokens > 0) {
        const overallCachePct = ((totalCachedTokens / totalPromptTokens) * 100).toFixed(1);
        const reasoningTotal = totalReasoningTokens > 0 ? ` (${totalReasoningTokens.toLocaleString()} thinking)` : '';
        statusLines.push(`• Session Cumulative: *${totalPromptTokens.toLocaleString()}* prompt (*${overallCachePct}%* cached), *${totalCompletionTokens.toLocaleString()}* completion${reasoningTotal}`);
      } else if (turnsCount > 0 && turnsWithUsage === 0) {
        statusLines.push(`• Tokens: No model metrics recorded yet in this session (will appear on next turn).`);
      }
    } else {
      statusLines.push(`• Active Context Window: *0* / ${maxContextMessages} messages`);
      statusLines.push(`• Compaction: *Standard* (no compaction needed)`);
      statusLines.push(`• Tokens: No turns recorded yet in this session.`);
    }

    await respond({ text: statusLines.join('\n'), response_type: 'ephemeral' });
    return;
  }

  // 4. Reset
  if (text === 'reset') {
    const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const altKey = sessionKeyFor(channelId, command.thread_ts).replace(/[^a-zA-Z0-9_-]/g, '_');
    const possiblePaths = [
      join(libraHome, 'sessions', `${sessionKey}.jsonl`),
      join(libraHome, 'sessions', `${safeKey}.jsonl`),
      join(libraHome, 'sessions', `${altKey}.jsonl`),
    ];
    const sessionFile = possiblePaths.find((p) => existsSync(p));

    if (sessionFile) {
      const backup = join(libraHome, 'sessions', `${safeKey}-${Date.now()}.jsonl`);
      renameSync(sessionFile, backup);
      await respond({ text: `🔄 Session \`${sessionKey}\` rotated. New prompt starts fresh!`, response_type: 'in_channel' });
    } else {
      await respond({ text: `Session \`${sessionKey}\` is already fresh (no history found).`, response_type: 'ephemeral' });
    }
    return;
  }

  // 5. Help
  if (text === 'help' || text === '') {
    await respond({
      text: 'Usage:\n• `/ronny <prompt>` — Run a code agent turn\n• `/ronny steer <message>` — Steer running turn\n• `/ronny halt [reason]` — Stop running turn\n• `/ronny status` — Check agent status',
      response_type: 'ephemeral'
    });
    return;
  }

  // 5. Default: run prompt
  await respond({ text: `⏳ Running \`lc\` for: "${text.slice(0, 60)}"`, response_type: 'ephemeral' });
  await runTurn({
    channelId,
    cleanedText: text,
    client,
    messageTs,
    threadTs: command.thread_ts,
    isDm,
  });
});
// ── Slash Command: /halt (legacy alias) ──────────────────────────────
app.command('/halt', async ({ command, ack, respond, client }) => {
  await ack();
  const channelId = command.channel_id;
  let halted = 0;
  for (const [key, item] of inFlight.entries()) {
    if (item.channelId === channelId) {
      item.halt('user requested /halt');
      halted++;
      inFlight.delete(key);
    }
  }

  if (halted > 0) {
    await respond({ text: `⏹ Halted ${halted} running \`lc\` process(es).`, response_type: 'ephemeral' });
    await postMessage(client, channelId, `⏹ *Turn halted by <@${command.user_id}>*`);
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
    console.log('  Listening for DMs, @mentions, and /ronny commands on Slack...');
  } catch (err) {
    console.error('Failed to start Slack app:', err);
    process.exit(1);
  }
})();
