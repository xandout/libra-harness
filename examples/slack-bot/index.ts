import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from 'libra';
import type { Extension } from 'libra';
import { resolveModel } from 'libra/extras/models';
import { App, LogLevel } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { createLoggerExtension } from 'libra/extras/logger';
import { createStreamingExtension } from 'libra/extras/streaming';
import { createMcpExtension } from 'libra/extras/mcp';
import { createSkillExtension } from 'libra/extras/skills';
import { createAutoSteerExtension } from 'libra/extras/auto-steer';
import { createSlackExtension, extractTextFromBlocks, swapReaction, removeReaction, postMessage, addReaction, postAgentReply } from './slack/index.ts';
import { createDiskSessionExtension } from 'libra/extras/disk-session';
import type { SessionIdentity, SessionRecord } from 'libra/extras/disk-session';
import { createKeywordExtractorExtension, getQueryAnalyzer } from 'libra/extras/keyword-extractor';
import { createFilesystemExtension } from 'libra/extras/filesystem';
import { createScriptsExtension } from 'libra/extras/scripts';
import { createOtelExtension, JsonlSpanExporter } from 'libra/extras/otel';
import { createToolBufferExtension } from 'libra/extras/tool-buffer';
import { createTokenStatsExtension } from 'libra/extras/token-stats';

// ── Slack metadata type ─────────────────────────────────────────────
// Bot-specific: used by the slack-context beforeContext hook to inject
// Slack channel/thread context as a system message. The disk-session
// extension reads metadata.session (a SessionIdentity) instead — it
// doesn't know about Slack.
interface SlackMeta {
  channelId: string;
  channelType: 'dm' | 'channel';
  messageTs: string;
  threadTs?: string;
  userId: string;
}

// ── Load .env ──────────────────────────────────────────────────────
try {
  const env = readFileSync(new URL('./.env', import.meta.url), 'utf-8');
  for (const line of env.split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      let val = match[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[match[1]] = val;
    }
  }
} catch {
  // No .env — rely on environment variables.
}

// ── Validate env ───────────────────────────────────────────────────
const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
const maxIterations = parseInt(process.env.MAX_ITERATIONS ?? '15', 10);
const searchToken = process.env.SLACK_SEARCH_TOKEN;

if (!botToken || !appToken) {
  console.error('Missing SLACK_BOT_TOKEN and/or SLACK_APP_TOKEN. See .env.example.');
  process.exit(1);
}

const expectedChannel = process.env.SLACK_CHANNEL?.replace(/^#/, '').trim() || undefined;

// ── Logging helpers ────────────────────────────────────────────────
// debug() is gated by the DEBUG env var. log() always prints.
const debugEnabled = !!process.env.DEBUG;
function debug(...args: unknown[]): void {
  if (debugEnabled) console.log(...args);
}

// ── Libra agent ────────────────────────────────────────────────────
// A single agent instance handles all conversations. Session isolation
// is via metadata.sessionId — each DM and thread gets its own history.
const model = await resolveModel(process.env.MODEL ?? 'deepseek/deepseek-v4-flash');

// ── OpenTelemetry setup ────────────────────────────────────────────
// Initializes a tracer provider with a JSONL file exporter by default.
// Spans are appended to ./traces/traces.jsonl (one JSON object per line)
// — same append-only pattern as disk-session. Run `npm run report` to
// see analytics from the trace file.
//
// Set OTEL_EXPORTER_OTLP_ENDPOINT to export to an OTLP collector
// (Jaeger, Honeycomb, Datadog, Tempo, etc.) instead of the JSONL file.
//
// The SDK is registered globally so the otel extension can acquire a
// tracer via trace.getTracer(). Spans are flushed on shutdown.
let otelSdk: { start: () => void; shutdown: () => Promise<void> } | undefined;
const otelEnabled = process.env.OTEL_ENABLED !== 'false';
const traceDir = process.env.OTEL_TRACE_DIR ?? './traces';
const traceFile = join(traceDir, 'traces.jsonl');
if (otelEnabled) {
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'libra-slack-bot';

    const sdkConfig: any = {
      serviceName,
    };

    if (otlpEndpoint) {
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
      sdkConfig.traceExporter = new OTLPTraceExporter({ url: otlpEndpoint });
      console.log(`[otel] exporting traces to OTLP: ${otlpEndpoint}`);
    } else {
      sdkConfig.traceExporter = new JsonlSpanExporter(traceFile);
      console.log(`[otel] exporting traces to ${traceFile} (run "npm run report" for analytics)`);
    }

    otelSdk = new NodeSDK(sdkConfig);
    otelSdk.start();
    console.log(`[otel] SDK started (service: ${serviceName})`);
  } catch (err) {
    console.error('[otel] failed to initialize, running without tracing:', err instanceof Error ? err.message : err);
  }
}

const otel = createOtelExtension({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'libra-slack-bot',
  metadataKeys: [
    'sessionId',
    'slack.channelId',
    'slack.channelType',
    'slack.threadTs',
    'slack.userId',
    'session.key',
    'compacting',
  ],
  ...(process.env.OTEL_RECORD_TOOL_ARGS === 'true' ? { recordToolArgs: true } : {}),
});

const logger = createLoggerExtension();
const sessionDir = process.env.SLACK_SESSION_DIR ?? './sessions';
const session = createDiskSessionExtension({ sessionDir });
const streaming = createStreamingExtension();

// ── Keyword logger extension ───────────────────────────────────────
// Logs winkNLP-extracted search terms from each user message at
// beforeTurn. Observational only — first step toward a retrieval
// preprocessing layer. The winkNLP model is initialized lazily once
// and reused for the lifetime of the process.
const keywordExtractor = createKeywordExtractorExtension();

// ── MCP extension ──────────────────────────────────────────────────
// Connects to MCP servers defined in mcpServers.json. The Slack MCP
// server has been replaced by the local slack extension below, which
// uses the bot token (not a user token) for all operations.
//
// Wrapped in try/catch because MCP connection failures (bad token,
// server down, app not enabled) should not crash the bot — it just
// runs without MCP tools. The extension factory itself catches per-
// server errors, but the initial config parsing can still throw.
let mcp: Extension | undefined;
try {
  mcp = await createMcpExtension({
    mcpConfigPaths: new URL('./mcpServers.json', import.meta.url).pathname,
  });
} catch (err) {
  console.error('[mcp] failed to initialize, running without MCP tools:', err instanceof Error ? err.message : err);
}

const agent = new Agent({
  model,
  systemPrompt:
    'You are an assistant.',
  maxIterations: maxIterations,
});

// ── no_reply tool ──────────────────────────────────────────────────
// Lets the agent explicitly signal "I've already communicated, no text
// reply needed." The bot checks for this tool call and suppresses the
// text response, posting only a checkmark reaction.
agent.tool({
  name: 'no_reply',
  description:
    'Signal that no text reply is needed. ONLY use this after you have ' +
    'already sent a proactive message via slack_send_message to a DIFFERENT ' +
    'channel and the user\'s original message is fully addressed. Do NOT use ' +
    'this for normal conversations — default to replying with text. When in ' +
    'doubt, do not call this tool.',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Brief reason for not replying (e.g. "already sent message to channel")',
      },
    },
  },
  async execute() {
    return { toolCallId: '', content: 'No reply needed — already communicated.' };
  },
});

agent.use(otel);
agent.use(logger);
agent.use(session);
agent.use(streaming);
agent.use(keywordExtractor);
if (mcp) agent.use(mcp);

// Note: hook execution order is determined by extension priority, not
// use() call order. keyword-extractor (priority 50) runs before
// disk-session (priority -100) in beforeTurn, so sessionMeta.keywords
// is populated before disk-session persists the user record.

// ── Slack metadata injection ───────────────────────────────────────
// Inject Slack context (channelId, messageTs, threadTs, userId) as a
// system message at the END of the context, just before the new user
// message. This keeps the channel history prefix stable for LLM
// caching — if we unshifted at the beginning, the cache prefix would
// break every turn because the metadata changes per message.
//
// Message order after this hook:
//   [system prompt] + [channel history] + [slack metadata] + [user msg]
//                         ^^^^^^^^^^^^^^^                    ^^^^^^^^^^
//                         stable (cached)                    changes per turn
agent.hook('beforeContext', 'slack-context', async (ctx) => {
  const slack = ctx.turn.metadata?.slack as SlackMeta | undefined;
  if (!slack) return;
  const msgs = ctx.turn.messages;

  // The bot's own identity is conveyed by the `role: 'assistant'` on
  // past messages (the model knows assistant = itself) plus the "You
  // are:" line in the metadata system message below. We deliberately
  // do NOT prefix assistant messages with "[botName]:" — that teaches
  // the agent to mimic the prefix in new responses. User messages in
  // channels are tagged by the message handler with
  // "[userId:userName]:" so the agent can tell multiple humans apart.

  // Find the last user message (the new one for this turn) and insert
  // the metadata system message just before it.
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const botName = botUserId ? (userNameCache.get(botUserId) ?? 'bot') : 'bot';
  const senderName = slack.userId ? (userNameCache.get(slack.userId) ?? slack.userId) : 'unknown';
  const metaMsg = {
    role: 'system' as const,
    content: `Slack message context:
- You are: ${botName} (${botUserId || 'unknown'})
- channelId: ${slack.channelId}
- channelType: ${slack.channelType}
- messageTs: ${slack.messageTs}
- threadTs: ${slack.threadTs ?? '(none)'}
- from: ${slack.userId} (${senderName})`,
  };
  if (lastUserIdx >= 0) {
    msgs.splice(lastUserIdx, 0, metaMsg);
  } else {
    msgs.push(metaMsg);
  }
});

// ── Skill extension ────────────────────────────────────────────────
// Loads skills from ./skills. Skills with `autoLoad: true` in their
// frontmatter are appended to the system prompt at install time.
const skills = createSkillExtension({
  skillsDirs: new URL('./skills', import.meta.url).pathname,
});
if (skills) agent.use(skills);

// ── Auto-steer extension ───────────────────────────────────────────
// Steers the agent to wrap up when approaching max iterations,
// preventing empty max_iterations responses.
const autoSteer = createAutoSteerExtension({
  maxIterations: maxIterations,
  threshold: 3,
});
agent.use(autoSteer);

// ── Slack app (Socket Mode) ────────────────────────────────────────
const app = new App({
  token: botToken,
  appToken,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// ── Slack extension ────────────────────────────────────────────────
// Provides Slack tools using the bot token via the Slack SDK. All
// actions (send, react, schedule) are performed as the bot, not as a
// human user. Search tools use a separate user/app token (read-only).
const searchClient = searchToken ? new WebClient(searchToken) : undefined;
if (searchClient) {
  console.log('[slack] search enabled (user/app token)');
} else {
  console.log('[slack] search disabled (set SLACK_SEARCH_TOKEN to enable)');
}
// ── Filesystem extension ───────────────────────────────────────────
// Sandboxed read/write access for downloaded files and persistent docs.
// Each directory is presented to the agent by its display name.
const fsExt = createFilesystemExtension({
  directories: [
    { name: 'slack-files', path: './slack-files' },
    { name: 'documents', path: './documents' },
    { name: 'tool-buffers', path: './tool-buffers' },
  ],
});
agent.use(fsExt);
console.log(`[fs] sandboxes: slack-files, documents, tool-buffers`);

// ── Scripts extension ──────────────────────────────────────────────
// Durable, on-disk registry of agent-authored data-processing scripts
// that run in a sandboxed QuickJS WASM runtime. Scripts are reused
// across sessions. Input can be passed inline or read from / written to
// the same sandboxed directories the filesystem and slack-files
// extensions use — gated by `allowedFsDirs` so only the listed
// sandboxes are reachable from script_run.
const scripts = createScriptsExtension({
  registryDir: process.env.SCRIPTS_REGISTRY_DIR ?? './scripts-registry',
  fs: fsExt,
  allowedFsDirs: ['slack-files', 'documents', 'tool-buffers'],
  interruptMs: 5000,
});
agent.use(scripts);
console.log(`[scripts] registry: ${process.env.SCRIPTS_REGISTRY_DIR ?? './scripts-registry'} (sandboxed via QuickJS)`);

// ── Tool buffer extension ──────────────────────────────────────────
// Redirects large tool outputs to files so the LLM context stays small.
// All tools are buffered by default; the LLM can call no_buffer() to
// get full output inline when needed. Tools that return small or
// action-oriented results are excluded so they always pass through.
const toolBuffer = createToolBufferExtension({
  bufferDir: process.env.TOOL_BUFFER_DIR ?? './tool-buffers',
  threshold: 2000,
  excludeTools: [
    // File reads — the LLM asked for this content specifically
    'fs_read', 'fs_list', 'fs_stat',
    // Skills — internal agent tools
    'list_skills', 'use_skill', 'read_skill_file',
    // Scripts — registry listings and source the LLM asked for
    'script_list', 'script_get',
    // MCP meta-tools — small structured responses
    'list_resources', 'read_resource', 'list_prompts', 'use_prompt',
    // Buffer control itself
    'no_buffer',
  ],
});
agent.use(toolBuffer);
console.log(`[tool-buffer] enabled (threshold: 2000 chars, ${toolBuffer.name})`);

// ── Token stats extension ──────────────────────────────────────────
// Appends token usage and context window stats to the final response.
// DeepSeek v4 has a 128K context window.
const tokenStats = createTokenStatsExtension({
  contextWindow: 1_000_000,
  slackItalics: true,
});
agent.use(tokenStats);

const slackExt = createSlackExtension({ client: app.client, searchClient, fs: fsExt, fsDir: 'slack-files' });
agent.use(slackExt);

// ── Tool-use reaction cycling ──────────────────────────────────────
// When the agent uses a tool, add a tool emoji (hammer, wrench,
// screwdriver, hammer_and_wrench) alongside the thinking_face and cycle
// through them on each tool call. thinking_face stays in place the whole
// time to prevent layout shifts — only the tool emoji is swapped.
//
// The current tool emoji is tracked in shared state so the final cleanup
// (success or error) can remove it.
const toolEmojis = ['hammer', 'wrench', 'screwdriver', 'hammer_and_wrench'];
agent.hook('beforeTool', 'tool-reaction', async (ctx) => {
  const slack = ctx.turn.metadata?.slack as SlackMeta | undefined;
  if (!slack) return;

  // The shared reaction state holder (passed via metadata by runAgentTurn).
  const state = ctx.turn.metadata?._reactionState as { toolEmoji: string | null } | undefined;
  if (!state) return;

  // Read the current tool-call count for this turn (default 0).
  const meta = ctx.turn.metadata as Record<string, unknown>;
  const count = (meta._toolReactionCount as number) ?? 0;
  const prevEmoji = state.toolEmoji;
  const nextEmoji = toolEmojis[count % toolEmojis.length];

  // Update shared state so the final cleanup can remove the tool emoji.
  state.toolEmoji = nextEmoji;
  meta._toolReactionCount = count + 1;

  // Remove the previous tool emoji (if any), then add the next one.
  // thinking_face is left untouched. Fire-and-forget — cosmetic.
  const ts = slack.messageTs;
  const ch = slack.channelId;
  if (prevEmoji) removeReaction(app.client, ch, ts, prevEmoji).catch(() => {});
  addReaction(app.client, ch, ts, nextEmoji).catch(() => {});
});

// ── Self-mention interception ──────────────────────────────────────
// Slack Socket Mode doesn't deliver a bot's own messages back to itself.
// So when the agent sends a message via slack_send_message that contains
// a self-mention (<@botUserId>), we intercept it here and trigger a new
// agent turn directly — as if the bot received the message from a user.
agent.hook('afterTool', 'self-mention', async (ctx) => {
  const tc = ctx.toolCall;
  if (!tc || tc.name !== 'slack_send_message') return;
  if (!botUserId) return;

  // Parse the tool call arguments to extract the channel and text.
  let args: any;
  try {
    args = JSON.parse(tc.arguments);
  } catch {
    return;
  }

  const text = String(args.text ?? '');
  const targetChannel = String(args.channel ?? '');

  // Check if the message contains a self-mention.
  if (!text.includes(`<@${botUserId}>`)) return;

  // Strip the self-mention to get the actual message for the agent.
  const cleanedText = text.replace(`<@${botUserId}>`, '').trim();
  const agentMessage = cleanedText || 'Hello!';

  // Determine channel type (DM if channel ID starts with 'D').
  const isDm = targetChannel.startsWith('D');

  console.log(`[slack] self-mention intercepted: channel=${targetChannel} text="${agentMessage.slice(0, 60)}"`);

  // Trigger a new agent turn for that channel. Use a small delay so the
  // current turn finishes posting its reply first.
  setTimeout(() => {
    runAgentTurn({
      channelId: targetChannel,
      threadTs: undefined,
      messageTs: String(Date.now() / 1000),
      userId: botUserId,
      isDm,
      agentMessage,
      logger: console,
    }).catch((err) => {
      console.error(`[slack] self-mention turn failed:`, err instanceof Error ? err.message : String(err));
    });
  }, 500);
});

// Resolve the bot's own user ID so we can strip mentions.
let botUserId = '';

// ── User name cache ────────────────────────────────────────────────
// Maps Slack user IDs to display names so background messages can show
// who's talking (e.g. "[U12345678:Example User]: hey"). Populated
// lazily on first sighting of a user ID via users.info. Cached for the
// lifetime of the process — Slack doesn't push profile updates over
// Socket Mode, so stale names are possible if someone renames
// themselves mid-session. Acceptable for context; the agent can call
// slack_get_user_info for fresh data when it matters.
const userNameCache = new Map<string, string>();

async function resolveUserName(userId: string): Promise<string> {
  if (!userId) return 'unknown';
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  try {
    const result = await app.client.users.info({ user: userId });
    const name = result.user?.real_name || result.user?.name || result.user?.profile?.display_name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    // Rate limited, deleted user, etc. — fall back to the raw ID.
    userNameCache.set(userId, userId);
    return userId;
  }
}

// Track in-flight conversations so follow-ups steer instead of queue.
// Stores the RunHandle so slash commands like /halt can cancel a turn.
const inFlight = new Map<string, { steer: (msg: string) => void; halt: (reason?: string) => void }>();

// ── Helpers ────────────────────────────────────────────────────────

function stripBotMention(text: string): string {
  if (!botUserId) return text.trim();
  return text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
}

function sessionKeyFor(channel: string, threadTs?: string): string {
  return threadTs ? `slack:${channel}:${threadTs}` : `slack:${channel}`;
}

// ── Thread tracking ────────────────────────────────────────────────
// Track threads the bot has replied in, so follow-up messages in those
// threads auto-trigger a reply without requiring an @mention.
const activeThreads = new Set<string>();

// ── Message handler ────────────────────────────────────────────────

app.message(async ({ message, logger: slackLogger }) => {
  // Skip non-message subtypes (joins, leaves, pins, etc.) but allow bot_message for integrations.
  const subtype = 'subtype' in message ? String(message.subtype || '') : '';
  if (subtype && subtype !== 'bot_message' && subtype !== 'file_share') {
    debug(`[slack] skipping subtype: ${subtype}`);
    return;
  }

  // Skip our own messages.
  const msgUser = 'user' in message && message.user ? String(message.user) : '';
  if (subtype === 'bot_message' && botUserId && msgUser === botUserId) return;

  if (!('channel' in message)) {
    debug('[slack] message missing channel — skipping');
    return;
  }

  const channelId = message.channel as string;
  const rawText = ('text' in message ? (message.text || '') : '') as string;
  const messageTs = String(message.ts || '');
  const threadTs = 'thread_ts' in message ? String(message.thread_ts || '') : '';
  const channelType = 'channel_type' in message ? String(message.channel_type || '') : '';
  // DM channels have IDs starting with 'D'. channel_type isn't always present.
  const isDm = channelType === 'im' || channelId.startsWith('D');

  // Extract text from blocks (tables, rich text) if present.
  // The `text` field only has plain-text fallback — blocks have the real data.
  let blockText = '';
  if ('blocks' in message && Array.isArray(message.blocks) && message.blocks.length > 0) {
    blockText = extractTextFromBlocks(message.blocks as any[]);
  }

  // Unwrap Slack URL formatting: <URL> → URL, <URL|text> → text (URL)
  // This exposes raw URLs (e.g. Slack permalinks) so the agent can
  // resolve them with slack_read_message_link.
  const unwrappedRaw = rawText.replace(/<(https?:\/\/[^>|]+)(?:\|([^>]*))?>/g, (_m, url, label) =>
    label ? `${label} (${url})` : url,
  );

  // Combine block text and raw text. Blocks have the rich content
  // (tables, lists), but rawText may contain URLs that blocks render
  // as display text (e.g. Slack permalink unfurls). Merge both so the
  // agent sees everything.
  const fullText = blockText.trim() && unwrappedRaw.trim() && blockText.trim() !== unwrappedRaw.trim()
    ? `${blockText.trim()}\n${unwrappedRaw.trim()}`
    : blockText.trim() || unwrappedRaw.trim();

  // Extract file metadata from the message. Slack attaches a `files`
  // array to messages with file shares. We include a summary in the
  // text so the agent knows files are available and can download them.
  const files = 'files' in message && Array.isArray(message.files) ? message.files as any[] : [];
  let fileText = '';
  if (files.length > 0) {
    fileText = '\n\n[Attached files:]' + files.map((f) => {
      const id = f.id ?? 'unknown';
      const name = f.name ?? 'unknown';
      const mimetype = f.mimetype ?? 'unknown';
      const size = f.size ?? '?';
      const filetype = f.filetype ?? 'unknown';
      return `\n  - file_id=${id} name="${name}" type=${mimetype} filetype=${filetype} size=${size}b`;
    }).join('');
  }
  const textWithFiles = fullText + fileText;

  debug(`[slack] message from ${channelId} (dm=${isDm}, type=${channelType || '?'}, blocks=${blockText ? 'yes' : 'no'}, files=${files.length}): "${fullText.slice(0, 60)}"`);

  // Channel filter (optional).
  if (expectedChannel && !isDm && channelId !== expectedChannel) {
    debug(`[slack] filtered (expected ${expectedChannel}, got ${channelId})`);
    return;
  }

  // In channels, respond to @mentions OR threads the bot has already replied in.
  // In DMs, always respond.
  // File shares: respond if the bot has been active in the channel before
  // (i.e. it has assistant records in the session). This lets users drop
  // files into the channel without @mentioning the bot on every upload.
  const isMentioned = Boolean(botUserId) && rawText.includes(`<@${botUserId}>`);
  // Check both the in-memory set AND the session store — the session
  // store persists across restarts, so the bot stays active in threads
  // it replied in before the restart.
  const isInActiveThread = threadTs && (
    activeThreads.has(threadTs) ||
    session.getRecords(`slack_${channelId}`).some(
      (r: SessionRecord) => r.threadTs === threadTs && r.role === 'assistant',
    )
  );
  const hasFiles = files.length > 0;
  const botIsActiveInChannel = session.getRecords(`slack_${channelId}`).some(
    (r: SessionRecord) => r.role === 'assistant',
  );
  if (!isDm && !isMentioned && !isInActiveThread && !(hasFiles && botIsActiveInChannel)) {
    // Background message — not directed at the bot. Store it as a
    // system record so the agent has channel context when it's later
    // triggered. The agent sees these as context ("here's what the
    // channel discussed"), not as messages to respond to.
    //
    // Run keyword extraction here since background messages bypass the
    // turn lifecycle — the keyword-extractor extension only fires in
    // beforeTurn, which doesn't run for appendMessage. We use the same
    // shared analyzer singleton so results are consistent.
    const senderId = msgUser || (subtype === 'bot_message' ? 'bot' : 'unknown');
    const senderName = senderId === 'bot' ? 'bot' : await resolveUserName(senderId);
    const { terms, phrases } = getQueryAnalyzer().analyze(textWithFiles);
    session.appendMessage(`slack_${channelId}`, `[${senderId}:${senderName}]: ${textWithFiles}`, {
      ts: messageTs,
      threadTs: threadTs || undefined,
      meta: {
        sender: senderId,
        senderName,
        channelId,
        keywords: { terms, phrases: phrases ?? [] },
        ...(files.length > 0 ? { files: files.map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype })) } : {}),
      },
    });
    debug(`[slack] background message stored for slack_${channelId}`);
    return;
  }

  const cleanedText = stripBotMention(textWithFiles);
  // Mention-only messages (e.g. "@Agent" with no other text) still
  // get a response — the agent can greet or ask what's needed.
  // File-only messages (no text, just attachments) prompt the agent
  // to acknowledge and process the files.
  const senderName = msgUser ? await resolveUserName(msgUser) : 'unknown';
  const baseMessage = cleanedText.trim() || (hasFiles ? 'I see you shared file(s). Let me take a look.' : 'Hello!');
  const agentMessage = `[${msgUser}:${senderName}]: ${baseMessage}`;

  await runAgentTurn({
    channelId,
    threadTs: isDm ? undefined : (threadTs || messageTs),
    messageTs,
    userId: msgUser,
    isDm,
    agentMessage,
    logger: slackLogger,
  });
});

// ── Agent turn runner ───────────────────────────────────────────────
// Shared by the message handler and the block action handler.
// Handles steering, reactions, agent execution, and reply posting.
async function runAgentTurn(opts: {
  channelId: string;
  threadTs?: string;
  messageTs: string;
  userId: string;
  isDm: boolean;
  agentMessage: string;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  const { channelId, threadTs, messageTs, userId, isDm, agentMessage, logger } = opts;

  // Session key for inFlight tracking (steering). Thread-level so
  // follow-up messages in the same thread steer into the running turn.
  const sessionKey = sessionKeyFor(channelId, isDm ? undefined : threadTs || messageTs);
  // Reactions go on the specific message that triggered the run.
  const reactionTs = messageTs;
  // Replies go into the thread (if in a thread) or as a thread on the
  // original message (if it's a top-level channel message, not a DM).
  const replyThreadTs = isDm ? undefined : (threadTs || messageTs);

  // If this conversation already has a turn in flight, steer it.
  const existing = inFlight.get(sessionKey);
  if (existing) {
    await addReaction(app.client, channelId, messageTs, 'eyes');
    existing.steer(agentMessage);
    logger.info(`Steered follow-up for ${sessionKey}`);
    return;
  }

  // Mark as thinking.
  await addReaction(app.client, channelId, reactionTs, 'thinking_face');

  // Shared mutable holder for the current tool emoji. The beforeTool hook
  // updates this as it cycles through tool emojis; both the success and
  // error paths read it to clean up the tool emoji. thinking_face stays
  // in place the whole time. Passed via metadata (shallow-copied by the
  // agent, so the object reference is shared between the hook and this
  // closure).
  const reactionState = { toolEmoji: null as string | null };

  // Run the agent turn.
  let streamBuffer = '';

  const handle = agent.run({
    message: agentMessage,
    metadata: {
      sessionId: sessionKey,
      session: {
        key: `slack_${channelId}`,
        messageTs,
        threadTs: threadTs || undefined,
        isDirect: isDm,
      } as SessionIdentity,
      slack: {
        channelId,
        channelType: isDm ? 'dm' : 'channel',
        messageTs,
        threadTs: threadTs || undefined,
        userId,
      } as SlackMeta,
      _reactionState: reactionState,
      streamCallbacks: {
        onText: (delta: string) => {
          streamBuffer += delta;
        },
      },
    },
  });

  inFlight.set(sessionKey, handle);

  try {
    console.log(`[slack] agent run started for ${sessionKey}`);
    const result = await handle;
    let reply = result.message.trim();
    // Pull usage from the last assistant record (set by disk-session afterLLM).
    const records = session.getRecords(`slack_${channelId}`);
    const lastUsage = [...records].reverse().find((r) => r.usage)?.usage;
    const usageStr = lastUsage
      ? ` tokens=${lastUsage.promptTokens}+${lastUsage.completionTokens}/${lastUsage.iterations}iter` +
        (lastUsage.cachedPromptTokens ? ` cache=${lastUsage.cachedPromptTokens}` : '') +
        (lastUsage.reasoningTokens ? ` reasoning=${lastUsage.reasoningTokens}` : '')
      : '';
    const toolCount = result.toolCalls?.length ?? 0;
    console.log(`[slack] agent replied (${reply.length} chars, finish=${result.finishReason}${usageStr}${toolCount ? ` tools=${toolCount}` : ''})`);

    if (!reply && result.finishReason === 'max_iterations') {
      reply = "I was working on that but ran out of turns. Could you ask me something more specific?";
    }

    const calledNoReply = (result.toolCalls ?? []).some((tc) => tc.name === 'no_reply');

    if (calledNoReply) {
      debug(`[slack] agent called no_reply — suppressing text reply`);
      reply = '';
    }

    // Swap thinking_face → checkmark and remove any lingering tool emoji.
    // thinking_face was never swapped away (prevents layout shifts), so
    // it's always the one to swap to the final status.
    await swapReaction(app.client, channelId, reactionTs, 'thinking_face', 'white_check_mark');
    if (reactionState.toolEmoji) {
      await removeReaction(app.client, channelId, reactionTs, reactionState.toolEmoji);
    }

    if (reply) {
      const usedBlocks = await postAgentReply(app.client, channelId, reply, replyThreadTs);
      console.log(`[slack] posted reply to ${channelId}${replyThreadTs ? ' (thread ' + replyThreadTs + ')' : ''}${usedBlocks ? ' (blocks)' : ''}`);
      if (replyThreadTs) activeThreads.add(replyThreadTs);
    } else {
      debug('[slack] no text reply — posting checkmark only');
      if (replyThreadTs) activeThreads.add(replyThreadTs);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[slack] agent error for ${sessionKey}:`, errMsg);

    await swapReaction(app.client, channelId, reactionTs, 'thinking_face', 'x');
    if (reactionState.toolEmoji) {
      await removeReaction(app.client, channelId, reactionTs, reactionState.toolEmoji);
    }
    await postMessage(app.client, channelId, `:x: Error: ${errMsg}`, replyThreadTs);
    logger.error(errMsg);
  } finally {
    inFlight.delete(sessionKey);
  }
}

// ── Slash command: /halt ───────────────────────────────────────────
// Halts the currently running agent turn in the channel where the
// command was invoked.
//
// Usage:
//   /halt              — halt all in-flight turns in this channel
//   /halt <thread_ts>  — halt a specific thread's turn
app.command('/halt', async ({ command, ack, respond, client }) => {
  await ack();

  const channelId = command.channel_id;
  const userId = command.user_id;
  const text = command.text.trim();
  const channelPrefix = `slack:${channelId}:`;

  console.log(`[slack] /halt invoked by ${userId} in ${channelId}${text ? ` (thread ${text})` : ''}`);

  // Find matching in-flight turns.
  // If a thread_ts is given, target that specific key.
  // Otherwise, halt all turns in this channel.
  const keysToHalt: string[] = [];
  if (text) {
    const specificKey = sessionKeyFor(channelId, text);
    if (inFlight.has(specificKey)) keysToHalt.push(specificKey);
  } else {
    for (const key of inFlight.keys()) {
      if (key.startsWith(channelPrefix)) keysToHalt.push(key);
    }
  }

  if (keysToHalt.length === 0) {
    debug(`[slack] /halt: no active turn found (checked ${inFlight.size} in-flight key(s))`);
    // Still log the control event to the session.
    session.appendControl(
      `slack_${channelId}`,
      `/halt by <@${userId}> — no active turn${text ? ` (thread ${text})` : ''}`,
      undefined,
      text || undefined,
    );
    await respond({
      response_type: 'ephemeral',
      text: `:information_source: No active agent turn in <#${channelId}>${text ? ` thread ${text}` : ''}.`,
    });
    return;
  }

  for (const key of keysToHalt) {
    inFlight.get(key)?.halt('User invoked /halt');
    console.log(`[slack] /halt: halted ${key}`);
  }

  // Persist the control event to the session log.
  session.appendControl(
    `slack_${channelId}`,
    `/halt by <@${userId}> — halted ${keysToHalt.length} turn(s): ${keysToHalt.join(', ')}`,
    undefined,
    text || undefined,
  );

  await respond({
    response_type: 'ephemeral',
    text: `:octagonal_sign: Halted ${keysToHalt.length} agent turn(s) in <#${channelId}>.`,
  });

  // Post a visible message in the channel so others see it was halted.
  await postMessage(
    client,
    channelId,
    ':octagonal_sign: Agent turn halted by user.',
    text || undefined,
  );
});

// ── Slash command: /compact ────────────────────────────────────────
// Compacts the current channel's session by running a compaction turn
// through the agent. The agent summarizes the conversation (with full
// access to its tools, skills, and system prompt), then the session
// extension's afterTurn hook detects the compaction flag, archives the
// old JSONL file, and seeds a new session with the summary.
//
// Usage:
//   /compact              — compact the current channel's session
//   /compact <guidance>   — guide the summary (e.g. "focus on open action items")
app.command('/compact', async ({ command, ack, respond, client }) => {
  await ack();

  const channelId = command.channel_id;
  const userId = command.user_id;
  const channelKey = `slack_${channelId}`;
  const guidance = command.text.trim();
  const isDm = channelId.startsWith('D');

  console.log(`[slack] /compact invoked by ${userId} in ${channelId}${guidance ? ` (guidance: "${guidance.slice(0, 60)}")` : ''}`);

  // Don't compact if a turn is in flight in this channel.
  const channelPrefix = `slack:${channelId}:`;
  for (const key of inFlight.keys()) {
    if (key.startsWith(channelPrefix)) {
      await respond({
        response_type: 'ephemeral',
        text: `:warning: An agent turn is running in this channel. /halt it first, then /compact.`,
      });
      return;
    }
  }

  const recordCount = session.getRecords(channelKey).length;
  if (recordCount === 0) {
    await respond({
      response_type: 'ephemeral',
      text: `:information_source: No session history to compact in <#${channelId}>.`,
    });
    return;
  }

  await respond({
    response_type: 'ephemeral',
    text: `:memo: Compacting ${recordCount} record(s)… this may take a moment.`,
  });

  // Build the compaction prompt. The session extension's beforeTurn
  // hook will load the full conversation history as context — the agent
  // sees everything that was discussed, then produces a summary.
  const compactMessage =
    'Summarize this conversation so a fresh instance of you can continue ' +
    'helping with full context. Include: key facts discussed, decisions ' +
    'made, user preferences, open tasks, and any important context needed. ' +
    'Write as a direct summary (not a meta-description). Keep it concise ' +
    'but complete.' +
    (guidance ? `\n\nAdditional instruction: ${guidance}` : '');

  try {
    const result = await agent.run({
      message: compactMessage,
      metadata: {
        sessionId: channelKey,
        session: {
          key: channelKey,
          messageTs: String(Date.now() / 1000),
          isDirect: isDm,
        } as SessionIdentity,
        slack: {
          channelId,
          channelType: isDm ? 'dm' : 'channel',
          messageTs: String(Date.now() / 1000),
          userId,
        } as SlackMeta,
        compacting: true,
      },
    });

    const archivedFile = (result.metadata['_compactArchivedFile'] as string) ?? '(unknown)';
    console.log(`[slack] /compact: archived ${archivedFile}, summary ${result.message.length} chars`);

    // Log the control event to the new session.
    session.appendControl(
      channelKey,
      `/compact by <@${userId}> — compacted ${recordCount} record(s), archived ${archivedFile}`,
    );

    await postMessage(
      client,
      channelId,
      `:file_folder: Session compacted by <@${userId}>.\n` +
      `_${recordCount} record(s) archived to \`${archivedFile}\`._\n` +
      `The agent now has a summary of prior context.`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[slack] /compact failed:`, errMsg);
    await postMessage(
      client,
      channelId,
      `:x: Compaction failed: ${errMsg}`,
    );
  }
});

// ── Block Kit actions (button clicks, select menus, etc.) ──────────
// When a user interacts with a Block Kit element in a bot message,
// Slack sends an interactive payload. We treat it like a message from
// that user — the action_id and value are passed to the agent as text.
app.action({ type: 'block_actions' }, async ({ action, body, ack, client }) => {
  await ack();

  const actionObj = action as unknown as Record<string, unknown>;
  const actionId = String(actionObj.action_id ?? '');
  const value = String(actionObj.value ?? '');
  const actionText = (actionObj.text as { text?: string } | undefined)?.text ?? '';
  const userId = body.user.id;
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;
  const threadTs = body.message?.thread_ts;

  if (!channelId || !messageTs) {
    debug('[slack] block action missing channel or message — skipping');
    return;
  }

  // Build a message for the agent from the action.
  const parts = [actionText || actionId];
  if (value && value !== actionId) parts.push(value);
  const agentInput = `[Block Kit action: ${actionId}] ${parts.join(' — ')}`;

  debug(`[slack] block action from ${userId} in ${channelId}: action_id=${actionId} value=${value.slice(0, 40)}`);

  // Post an ephemeral confirmation to the user who clicked.
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: `:eyes: Processing: ${actionText || actionId}`,
  }).catch(() => {});

  // Determine if this is a DM (channel ID starts with 'D').
  const isDm = channelId.startsWith('D');

  // Run the agent turn directly — no need to post a synthetic message.
  // This reuses the full steering/reaction/reply flow.
  await runAgentTurn({
    channelId,
    threadTs: isDm ? undefined : (threadTs || messageTs),
    messageTs,
    userId,
    isDm,
    agentMessage: agentInput,
    logger: console,
  });
});

// ── Start ──────────────────────────────────────────────────────────

(async () => {
  await app.start();
  const auth = await app.client.auth.test();
  botUserId = String(auth.user_id || '');
  if (!botUserId) {
    console.warn('Could not resolve bot user ID — mention detection may not work.');
  } else {
    // Cache the bot's own name so self-mentions and background bot
    // messages show a readable name instead of a raw ID.
    const botName = auth.user as string | undefined || 'bot';
    userNameCache.set(botUserId, botName);
  }

  console.log(`⚡️ Libra Slack bot is running (Socket Mode)`);
  console.log(`  model:    ${process.env.MODEL ?? 'deepseek/deepseek-v4-flash'}`);
  console.log(`  bot user: ${botUserId || '(unknown)'}`);
  if (expectedChannel) console.log(`  channel:  ${expectedChannel}`);
  console.log(`  slack:    bot-token tools enabled`);
  const sessionKeys = session.getSessions();
  const totalRecords = sessionKeys.reduce((n: number, k: string) => n + session.getRecords(k).length, 0);
  console.log(`  sessions: ${sessionDir} (${sessionKeys.length} session(s), ${totalRecords} record(s))`);
  if (mcp) console.log(`  mcp:      ${mcp.name} tools enabled`);
  console.log(`  otel:     ${otelEnabled ? 'tracing enabled' : 'disabled (OTEL_ENABLED=false)'}`);
  console.log(`  DM the bot or @mention it in a channel.`);

  // Clean up MCP connections and flush OTel spans on shutdown.
  process.on('SIGINT', async () => {
    if (mcp && typeof (mcp as { close?: () => Promise<void> }).close === 'function') {
      await (mcp as { close: () => Promise<void> }).close();
    }
    if (otelSdk?.shutdown) {
      await otelSdk.shutdown();
      console.log('[otel] SDK shut down — spans flushed');
    }
    process.exit(0);
  });
})();
