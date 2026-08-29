import type { WebClient } from '@slack/web-api';
import type { Extension } from 'libra';
import { addReaction } from './reactions.ts';
import { postMessageWithBlocks } from './messages.ts';

export interface SlackExtensionConfig {
  /** The Slack WebClient (from Bolt or standalone). Uses the bot token. */
  client: WebClient;
  /** The bot's user ID, used to strip self-mentions. */
  botUserId?: string;
  /**
   * Optional WebClient using a user/app token for search operations.
   * Search (search.messages, search.channels, search.users) requires
   * a user or app token — the bot token doesn't have search scopes.
   * If not provided, search tools are not registered.
   * Search is read-only — it doesn't post as the user.
   */
  searchClient?: WebClient;
  /**
   * Optional filesystem extension for saving downloaded files.
   * When provided, slack_download_file saves to the sandbox instead
   * of returning base64 inline. The agent can then use fs_read to
   * access the file content.
   */
  fs?: {
    saveBytes(path: string, data: Buffer, mimetype?: string): string;
    resolvePath(path: string): string;
  };
  /**
   * Sandbox directory name to save downloaded files into. The path
   * passed to `fs.saveBytes` is prefixed with this name. Required
   * when `fs` is provided.
   */
  fsDir?: string;
  /**
   * Tool names to exclude from registration. Matched against the tool
   * name (without prefix) using RegExp test(). Default: none.
   */
  excludeTools?: string[];
}

/**
 * Create a Slack extension that provides tools using the **bot token**
 * (not a user token). This means all actions are performed as the bot,
 * not as a human user.
 *
 * Tools provided:
 * - `slack_read_channel` — read channel message history
 * - `slack_read_message_link` — read a message from a Slack permalink URL
 * - `slack_read_thread` — read a thread's replies
 * - `slack_send_message` — post a message (as the bot)
 * - `slack_add_reaction` — add a reaction to a message
 * - `slack_get_reactions` — list reactions on a message
 * - `slack_read_user_profile` — get a user's profile
 * - `slack_list_channels` — list channels the bot is in
 * - `slack_list_channel_members` — list members of a channel
 * - `slack_search_emojis` — list available emojis
 * - `slack_read_file` — get file info
 * - `slack_download_file` — download file content (text, images, PDFs)
 * - `slack_upload_file` — upload a file to a channel
 * - `slack_schedule_message` — schedule a message
 *
 * Search tools (read-only, requires `searchClient` with user/app token):
 * - `slack_search_messages` — search messages across the workspace
 * - `slack_search_channels` — find channels by name
 * - `slack_search_users` — find users by name or email
 *
 * Not available: canvas operations (requires paid plan)
 */
export default function createSlackExtension(
  config: SlackExtensionConfig,
): Extension {
  const { client, searchClient, fs, fsDir } = config;
  const excludePatterns = (config.excludeTools ?? []).map((p) => new RegExp(p));

  function shouldInclude(toolName: string): boolean {
    return !excludePatterns.some((re) => re.test(toolName));
  }

  return {
    name: 'slack',
    priority: 50,
    install(agent) {
      // ── slack_read_channel ──────────────────────────────────────
      if (shouldInclude('read_channel')) {
        agent.tool({
          name: 'slack_read_channel',
          description:
            'Read message history from a Slack channel. Returns recent ' +
            'messages with timestamps, authors, and text. Use cursor for ' +
            'pagination.',
          parameters: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'Channel ID (e.g. C12345678)' },
              limit: { type: 'number', description: 'Max messages to return (default 20, max 200)' },
              cursor: { type: 'string', description: 'Pagination cursor from a previous call' },
            },
            required: ['channel'],
          },
          async execute(args) {
            const result = await client.conversations.history({
              channel: args.channel as string,
              limit: (args.limit as number) ?? 20,
              ...(args.cursor ? { cursor: args.cursor as string } : {}),
            });
            const messages = ((result.messages ?? []) as Record<string, unknown>[]).map((m) => {
              const ts = String(m.ts ?? '');
              const user = String(m.user ?? m.bot_id ?? 'unknown');
              const text = String(m.text ?? '');
              const subtype = m.subtype ? ` [${m.subtype}]` : '';
              return `=== ${ts} from ${user}${subtype} ===\n${text}`;
            });
            const cursor = result.response_metadata?.next_cursor;
            return {
              toolCallId: '',
              content: messages.join('\n\n') +
                (cursor ? `\n\n[next cursor: ${cursor}]` : ''),
            };
          },
        });
      }

      // ── slack_read_message_link ──────────────────────────────────
      if (shouldInclude('read_message_link')) {
        agent.tool({
          name: 'slack_read_message_link',
          description:
            'Read a Slack message from a permalink URL. Parses the URL ' +
            'to extract the channel ID and timestamp, then fetches the ' +
            'message and its thread context (if any). Use this when a ' +
            'user shares a link to a Slack message. URL format: ' +
            'https://workspace.slack.com/archives/CHANNEL_ID/pTIMESTAMP ' +
            '(the timestamp has the dot removed, e.g. p1234567890123456 ' +
            '→ 1234567890.123456).',
          parameters: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'Slack message permalink URL',
              },
            },
            required: ['url'],
          },
          async execute(args) {
            const url = String(args.url ?? '');
            // Parse: https://workspace.slack.com/archives/C12345678/p1234567890123456
            const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/);
            if (!match) {
              return {
                toolCallId: '',
                content: `Could not parse Slack message URL: ${url}\nExpected format: https://workspace.slack.com/archives/CHANNEL_ID/pTIMESTAMP`,
              };
            }
            const [, channel, tsRaw] = match;
            // Reconstruct timestamp: insert dot before last 6 digits
            const ts = tsRaw.length > 6
              ? `${tsRaw.slice(0, -6)}.${tsRaw.slice(-6)}`
              : tsRaw;

            // Fetch the message and its thread context (if threaded).
            const result = await client.conversations.replies({
              channel,
              ts,
              limit: 100,
            });
            const messages = ((result.messages ?? []) as Record<string, unknown>[]).map((m, i) => {
              const msgTs = String(m.ts ?? '');
              const user = String(m.user ?? m.bot_id ?? 'unknown');
              const text = String(m.text ?? '');
              const subtype = m.subtype ? ` [${m.subtype}]` : '';
              const label = i === 0 ? 'Message' : `Reply ${i}`;
              return `--- ${label} (${msgTs}) from ${user}${subtype} ---\n${text}`;
            });
            if (messages.length === 0) {
              return {
                toolCallId: '',
                content: `No message found at ${url} (channel=${channel}, ts=${ts}). The message may have been deleted or the bot doesn't have access.`,
              };
            }
            const threadNote = messages.length > 1
              ? `\n\n[This message is part of a thread with ${messages.length} reply(s)]`
              : '';
            return {
              toolCallId: '',
              content: messages.join('\n\n') + threadNote,
            };
          },
        });
      }

      // ── slack_read_thread ────────────────────────────────────────
      if (shouldInclude('read_thread')) {
        agent.tool({
          name: 'slack_read_thread',
          description:
            'Read all replies in a Slack thread. Returns messages with ' +
            'timestamps, authors, and text.',
          parameters: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'Channel ID' },
              thread_ts: { type: 'string', description: 'Thread parent timestamp (e.g. 1234567890.123456)' },
              limit: { type: 'number', description: 'Max replies (default 50)' },
            },
            required: ['channel', 'thread_ts'],
          },
          async execute(args) {
            const result = await client.conversations.replies({
              channel: args.channel as string,
              ts: args.thread_ts as string,
              limit: (args.limit as number) ?? 50,
            });
            const messages = ((result.messages ?? []) as Record<string, unknown>[]).map((m, i) => {
              const ts = String(m.ts ?? '');
              const user = String(m.user ?? m.bot_id ?? 'unknown');
              const text = String(m.text ?? '');
              const label = i === 0 ? 'Parent' : `Reply ${i}`;
              return `--- ${label} (${ts}) from ${user} ---\n${text}`;
            });
            return { toolCallId: '', content: messages.join('\n\n') };
          },
        });
      }

      // ── slack_send_message ───────────────────────────────────────
      if (shouldInclude('send_message')) {
        agent.tool({
          name: 'slack_send_message',
          description:
            'Send a message to a Slack channel or DM as the bot. Supports ' +
            'mrkdwn text and optional Block Kit blocks. Use this for ' +
            'proactive messages or when you need Block Kit formatting ' +
            '(tables, rich layouts). For normal replies, just respond ' +
            'with text — the bridge posts it automatically.',
          parameters: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'Channel or DM ID' },
              text: { type: 'string', description: 'Message text in mrkdwn (fallback for blocks)' },
              thread_ts: { type: 'string', description: 'Thread timestamp to reply in a thread' },
              blocks: {
                type: 'string',
                description: 'Optional Block Kit blocks as a JSON array string (e.g. tables, sections)',
              },
            },
            required: ['channel', 'text'],
          },
          async execute(args) {
            const channel = args.channel as string;
            const text = args.text as string;
            const threadTs = args.thread_ts as string | undefined;
            let blocks: unknown[] | undefined;
            if (args.blocks) {
              try {
                const parsed = JSON.parse(args.blocks as string);
                if (Array.isArray(parsed)) blocks = parsed;
              } catch {
                return { toolCallId: '', content: 'Invalid blocks JSON', isError: true };
              }
            }
            const result = await postMessageWithBlocks(client, channel, text, blocks, threadTs);
            if (!result.ok) {
              return { toolCallId: '', content: `Failed: ${result.error}`, isError: true };
            }
            return {
              toolCallId: '',
              content: `Message sent to ${channel}${threadTs ? ` (thread ${threadTs})` : ''}. ts=${result.ts ?? 'unknown'}`,
            };
          },
        });
      }

      // ── slack_add_reaction ───────────────────────────────────────
      if (shouldInclude('add_reaction')) {
        agent.tool({
          name: 'slack_add_reaction',
          description:
            'Add a reaction (emoji) to a Slack message. The bridge ' +
            'manages reactions automatically — only use this when the ' +
            'user specifically asks you to react to something.',
          parameters: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'Channel ID' },
              timestamp: { type: 'string', description: 'Message timestamp' },
              name: { type: 'string', description: 'Emoji name without colons (e.g. "thumbsup")' },
            },
            required: ['channel', 'timestamp', 'name'],
          },
          async execute(args) {
            await addReaction(
              client,
              args.channel as string,
              args.timestamp as string,
              args.name as string,
            );
            return { toolCallId: '', content: `Added :${args.name}: to ${args.timestamp}` };
          },
        });
      }

      // ── slack_get_reactions ──────────────────────────────────────
      if (shouldInclude('get_reactions')) {
        agent.tool({
          name: 'slack_get_reactions',
          description: 'List reactions (emojis) on a Slack message.',
          parameters: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'Channel ID' },
              timestamp: { type: 'string', description: 'Message timestamp' },
            },
            required: ['channel', 'timestamp'],
          },
          async execute(args) {
            const result = await client.reactions.get({
              channel: args.channel as string,
              timestamp: args.timestamp as string,
            });
            const reactions = ((result.message?.reactions ?? []) as Record<string, unknown>[]).map((r) => {
              const name = r.name as string;
              const count = r.count as number;
              const users = (r.users as string[]) ?? [];
              return `:${name}: x${count} by ${users.join(', ')}`;
            });
            return {
              toolCallId: '',
              content: reactions.length > 0 ? reactions.join('\n') : 'No reactions',
            };
          },
        });
      }

      // ── slack_read_user_profile ──────────────────────────────────
      if (shouldInclude('read_user_profile')) {
        agent.tool({
          name: 'slack_read_user_profile',
          description: 'Get a Slack user\'s profile (name, email, title, etc.).',
          parameters: {
            type: 'object',
            properties: {
              user: { type: 'string', description: 'User ID (e.g. U12345678)' },
            },
            required: ['user'],
          },
          async execute(args) {
            const result = await client.users.info({ user: args.user as string });
            const u = result.user;
            if (!u) return { toolCallId: '', content: 'User not found' };
            const profile = u.profile as Record<string, unknown> | undefined;
            const lines = [
              `Name: ${u.name ?? 'unknown'}`,
              `Real name: ${u.real_name ?? 'unknown'}`,
              `Title: ${profile?.title ?? 'none'}`,
              `Email: ${profile?.email ?? 'none'}`,
              `Phone: ${profile?.phone ?? 'none'}`,
              `Display name: ${profile?.display_name ?? 'none'}`,
              `Is bot: ${u.is_bot ?? false}`,
              `Timezone: ${u.tz ?? 'unknown'}`,
            ];
            return { toolCallId: '', content: lines.join('\n') };
          },
        });
      }

      // ── slack_list_channels ──────────────────────────────────────
      if (shouldInclude('list_channels')) {
        agent.tool({
          name: 'slack_list_channels',
          description:
            'List channels the bot is a member of. Returns channel IDs, ' +
            'names, and whether they\'re public or private.',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Max channels (default 100)' },
              cursor: { type: 'string', description: 'Pagination cursor' },
            },
          },
          async execute(args) {
            const result = await client.conversations.list({
              limit: (args.limit as number) ?? 100,
              types: 'public_channel,private_channel',
              ...(args.cursor ? { cursor: args.cursor as string } : {}),
            });
            const channels = ((result.channels ?? []) as Record<string, unknown>[]).map((c) => {
              const id = c.id as string;
              const name = c.name as string;
              const isPrivate = c.is_private as boolean;
              const numMembers = c.num_members as number | undefined;
              return `${id} #${name} (${isPrivate ? 'private' : 'public'}, ${numMembers ?? '?'} members)`;
            });
            const cursor = result.response_metadata?.next_cursor;
            return {
              toolCallId: '',
              content: channels.join('\n') +
                (cursor ? `\n\n[next cursor: ${cursor}]` : ''),
            };
          },
        });
      }

      // ── slack_list_channel_members ───────────────────────────────
      if (shouldInclude('list_channel_members')) {
        agent.tool({
          name: 'slack_list_channel_members',
          description: 'List member IDs of a Slack channel.',
          parameters: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'Channel ID' },
            },
            required: ['channel'],
          },
          async execute(args) {
            const result = await client.conversations.members({
              channel: args.channel as string,
              limit: 200,
            });
            const members = (result.members ?? []) as string[];
            return {
              toolCallId: '',
              content: `Members (${members.length}): ${members.join(', ')}`,
            };
          },
        });
      }

      // ── slack_search_emojis ──────────────────────────────────────
      if (shouldInclude('search_emojis')) {
        agent.tool({
          name: 'slack_search_emojis',
            description: 'List available custom emojis in the workspace.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Optional filter — only return emojis containing this text' },
            },
          },
          async execute(args) {
            const result = await client.emoji.list();
            const all = Object.keys(result.emoji ?? {});
            const query = args.query as string | undefined;
            const filtered = query
              ? all.filter((e) => e.includes(query.toLowerCase()))
              : all;
            return {
              toolCallId: '',
              content: `Emojis (${filtered.length}): ${filtered.slice(0, 100).join(', ')}` +
                (filtered.length > 100 ? `\n... and ${filtered.length - 100} more` : ''),
            };
          },
        });
      }

      // ── slack_read_file ──────────────────────────────────────────
      if (shouldInclude('read_file')) {
        agent.tool({
          name: 'slack_read_file',
          description: 'Get info about a Slack file by ID or URL.',
          parameters: {
            type: 'object',
            properties: {
              file: { type: 'string', description: 'File ID (e.g. F0BFQADHG9Y) or file URL' },
            },
            required: ['file'],
          },
          async execute(args) {
            const fileArg = args.file as string;
            // If it's a URL, extract the file ID from it.
            const fileId = fileArg.startsWith('http')
              ? fileArg.match(/F[A-Z0-9]+/)?.[0] ?? fileArg
              : fileArg;
            const result = await client.files.info({ file: fileId });
            const f = result.file as Record<string, unknown> | undefined;
            if (!f) return { toolCallId: '', content: 'File not found' };
            const lines = [
              `Name: ${f.name ?? 'unknown'}`,
              `Title: ${f.title ?? 'none'}`,
              `Mimetype: ${f.mimetype ?? 'unknown'}`,
              `Size: ${f.size ?? 'unknown'} bytes`,
              `URL: ${f.url_private ?? f.permalink ?? 'none'}`,
              `Uploaded by: ${f.user ?? 'unknown'}`,
            ];
            return { toolCallId: '', content: lines.join('\n') };
          },
        });
      }

      // ── slack_download_file ─────────────────────────────────────
      if (shouldInclude('download_file')) {
        agent.tool({
          name: 'slack_download_file',
          description:
            'Download a Slack file and save it to the sandboxed filesystem ' +
            '(slack-files/). Returns the saved path and a preview of the ' +
            'content. Text files get a text preview; binary files get ' +
            'metadata. Use fs_read to read the full content later. ' +
            'Use slack_read_file first to get the file ID.',
          parameters: {
            type: 'object',
            properties: {
              file: { type: 'string', description: 'File ID (e.g. F0BFQADHG9Y) or file URL' },
              filename: { type: 'string', description: 'Optional filename for the saved file. Defaults to the Slack filename.' },
            },
            required: ['file'],
          },
          async execute(args) {
            const fileArg = args.file as string;
            const fileId = fileArg.startsWith('http')
              ? fileArg.match(/F[A-Z0-9]+/)?.[0] ?? fileArg
              : fileArg;

            // Get file info first.
            const info = await client.files.info({ file: fileId });
            const f = info.file as Record<string, unknown> | undefined;
            if (!f) return { toolCallId: '', content: 'File not found' };

            const mimetype = String(f.mimetype ?? '');
            const filetype = String(f.filetype ?? '');
            const urlPrivate = String(f.url_private ?? '');
            const name = String(f.name ?? 'unknown');
            const size = Number(f.size ?? 0);
            const saveName = (args.filename as string) || name;

            // Download the file content.
            let buf: Buffer;
            try {
              const resp = await fetch(urlPrivate, {
                headers: { Authorization: `Bearer ${client.token}` },
              });
              buf = Buffer.from(await resp.arrayBuffer());
            } catch (err) {
              return {
                toolCallId: '',
                content: `Failed to download ${name}: ${err instanceof Error ? err.message : String(err)}`,
              };
            }

            // If we have a filesystem extension, save to the sandbox.
            if (fs) {
              const dir = fsDir ?? 'slack-files';
              const relPath = `${fileId}/${saveName}`;
              const savePath = `${dir}/${relPath}`;
              try {
                fs.saveBytes(savePath, buf, mimetype);
              } catch (err) {
                return {
                  toolCallId: '',
                  content: `Failed to save file: ${err instanceof Error ? err.message : String(err)}`,
                };
              }

              // Build a preview based on file type.
              const textTypes = new Set([
                'text', 'csv', 'json', 'xml', 'yaml', 'md', 'markdown',
                'javascript', 'typescript', 'python', 'java', 'c', 'cpp',
                'go', 'rust', 'ruby', 'php', 'sql', 'html', 'css', 'sh',
                'bash', 'ini', 'conf', 'log', 'env', 'toml', 'graphql',
              ]);

              let preview = '';
              if (textTypes.has(filetype) || mimetype.startsWith('text/')) {
                const text = buf.toString('utf-8');
                preview = text.length > 2000
                  ? text.slice(0, 2000) + `\n\n[preview — ${text.length} chars total. Use fs_read to get full content.]`
                  : text;
              } else if (mimetype.startsWith('image/')) {
                preview = `[Image saved — ${mimetype}, ${size}b. Use fs_read to get base64 data.]`;
              } else if (filetype === 'pdf' || mimetype === 'application/pdf') {
                // Try basic text extraction for preview.
                const raw = buf.toString('latin1');
                const textMatches = raw.match(/\(([^)]+)\)/g);
                const extracted = textMatches
                  ? textMatches.map((m) => m.slice(1, -1)).join(' ')
                  : '';
                preview = extracted.trim()
                  ? `[PDF saved — ${size}b. Text preview: ${extracted.slice(0, 500)}...]`
                  : `[PDF saved — ${size}b. Binary PDF — use a PDF parser for content.]`;
              } else {
                preview = `[Binary file saved — ${mimetype}, ${size}b.]`;
              }

              return {
                toolCallId: '',
                content: `Downloaded "${name}" (${mimetype}, ${size}b) → ${savePath}\n\n${preview}`,
              };
            }

            // No filesystem extension — return content inline (legacy behavior).
            const textTypes = new Set([
              'text', 'csv', 'json', 'xml', 'yaml', 'md', 'markdown',
              'javascript', 'typescript', 'python', 'java', 'c', 'cpp',
              'go', 'rust', 'ruby', 'php', 'sql', 'html', 'css', 'sh',
              'bash', 'ini', 'conf', 'log', 'env', 'toml', 'graphql',
            ]);

            if (textTypes.has(filetype) || mimetype.startsWith('text/')) {
              const content = buf.toString('utf-8');
              const truncated = content.length > 50000
                ? content.slice(0, 50000) + `\n\n[truncated — ${content.length} chars total]`
                : content;
              return { toolCallId: '', content: `File: ${name} (${filetype}, ${size}b)\n\n${truncated}` };
            }

            if (mimetype.startsWith('image/')) {
              const base64 = buf.toString('base64');
              return {
                toolCallId: '',
                content: `Image: ${name} (${mimetype}, ${size}b)\ndata:${mimetype};base64,${base64}`,
              };
            }

            return {
              toolCallId: '',
              content: `Binary file: ${name} (${mimetype}, ${size}b)\nFile ID: ${fileId}`,
            };
          },
        });
      }

      // ── slack_upload_file ───────────────────────────────────────
      if (shouldInclude('upload_file')) {
        agent.tool({
          name: 'slack_upload_file',
          description:
            'Upload a file to a Slack channel. The file content can be ' +
            'provided as text (for text files) or base64 (for binary ' +
            'files). Optionally post in a thread.',
          parameters: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'Channel ID to upload to' },
              filename: { type: 'string', description: 'Name for the uploaded file' },
              content: {
                type: 'string',
                description: 'File content as text (for text files) or base64-encoded (for binary)',
              },
              filetype: {
                type: 'string',
                description: 'File type hint (e.g. "text", "csv", "json", "post"). Optional.',
              },
              title: { type: 'string', description: 'Title for the file. Optional.' },
              thread_ts: { type: 'string', description: 'Thread timestamp to post in. Optional.' },
            },
            required: ['channel', 'filename', 'content'],
          },
          async execute(args) {
            try {
              // `uploadV2`'s argument type is a union where the thread
              // variant requires `channels` (deprecated) rather than
              // `channel_id`. The `channel_id` + `thread_ts` combination
              // is valid at runtime; cast at the call boundary.
              const uploadArgs = {
                channel_id: args.channel as string,
                filename: args.filename as string,
                content: args.content as string,
                ...(args.filetype ? { filetype: args.filetype as string } : {}),
                ...(args.title ? { title: args.title as string } : {}),
                ...(args.thread_ts ? { thread_ts: args.thread_ts as string } : {}),
              } as Parameters<typeof client.files.uploadV2>[0];
              const result = await client.files.uploadV2(uploadArgs);
              const f = (result as { file?: Record<string, unknown> }).file;
              return {
                toolCallId: '',
                content: `File uploaded: ${args.filename} (id: ${f?.id ?? 'unknown'}, url: ${f?.permalink ?? 'none'})`,
              };
            } catch (err) {
              return {
                toolCallId: '',
                content: `Failed to upload file: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          },
        });
      }

      // ── slack_schedule_message ───────────────────────────────────
      if (shouldInclude('schedule_message')) {
        agent.tool({
          name: 'slack_schedule_message',
          description:
            'Schedule a message to be sent at a future time. The time ' +
            'must be within 120 days from now.',
          parameters: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'Channel ID' },
              text: { type: 'string', description: 'Message text in mrkdwn' },
              post_at: { type: 'number', description: 'Unix timestamp (seconds) when to post' },
              thread_ts: { type: 'string', description: 'Optional thread timestamp' },
            },
            required: ['channel', 'text', 'post_at'],
          },
          async execute(args) {
            try {
              const result = await client.chat.scheduleMessage({
                channel: args.channel as string,
                text: args.text as string,
                post_at: args.post_at as number,
                ...(args.thread_ts ? { thread_ts: args.thread_ts as string } : {}),
              });
              return {
                toolCallId: '',
                content: `Scheduled message for ${new Date((args.post_at as number) * 1000).toISOString()}. Scheduled message ID: ${result.scheduled_message_id}`,
              };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return { toolCallId: '', content: `Failed to schedule: ${msg}`, isError: true };
            }
          },
        });
      }

      // ── Search tools (read-only, requires searchClient) ──────────
      // Search requires a user or app token. These are read-only — they
      // don't post anything as the user, they just query the workspace.

      // ── Search tools ─────────────────────────────────────────────
      // search.messages requires a user/app token (search:read scope).
      // search.channels and search.users don't exist as Slack API methods —
      // we use conversations.list / users.list with client-side filtering,
      // which only needs the bot token.

      if (searchClient) {
        // ── slack_search_messages ──────────────────────────────────
        if (shouldInclude('search_messages')) {
          agent.tool({
            name: 'slack_search_messages',
            description:
              'Search messages across the Slack workspace. Returns ' +
              'matching messages with channel, author, timestamp, and text. ' +
              'Supports Slack search operators (from:, in:, has:, before:, after:).',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query (supports Slack search operators like from:, in:, has:, before:, after:)' },
                count: { type: 'number', description: 'Max results (default 20, max 100)' },
                page: { type: 'number', description: 'Page number (default 1)' },
              },
              required: ['query'],
            },
            async execute(args) {
              const result = await searchClient.search.messages({
                query: args.query as string,
                count: (args.count as number) ?? 20,
                page: (args.page as number) ?? 1,
              });
              const matches = ((result.messages?.matches ?? []) as Record<string, unknown>[]).map((m) => {
                const channel = (m.channel as Record<string, unknown>)?.id ?? 'unknown';
                const user = m.user ?? 'unknown';
                const ts = m.ts ?? '';
                const text = m.text ?? '';
                const permalink = m.permalink ?? '';
                return `=== ${ts} in <#${channel}> from ${user} ===\n${text}\n${permalink}`;
              });
              const total = result.messages?.total ?? 0;
              const paging = result.messages?.paging ?? {};
              return {
                toolCallId: '',
                content: `Found ${total} result(s), showing ${matches.length}:\n\n${matches.join('\n\n')}` +
                  (paging.pages ? `\n\n[page ${paging.page}/${paging.pages}]` : ''),
              };
            },
          });
        }
      }

      // ── slack_search_channels ──────────────────────────────────
      // No search.channels API — use conversations.list + filter.
      if (shouldInclude('search_channels')) {
        agent.tool({
          name: 'slack_search_channels',
          description:
            'Search for channels in the workspace by name. Returns ' +
            'channel IDs, names, and member counts. Uses conversations.list ' +
            'with client-side filtering (no dedicated search API exists).',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Channel name or partial name to search for' },
              limit: { type: 'number', description: 'Max results (default 20)' },
            },
            required: ['query'],
          },
          async execute(args) {
            const query = (args.query as string).toLowerCase();
            const limit = (args.limit as number) ?? 20;
            const matches: string[] = [];
            let cursor: string | undefined;
            // Page through conversations until we have enough matches or run out.
            while (matches.length < limit) {
              const result = await client.conversations.list({
                limit: 200,
                types: 'public_channel,private_channel',
                ...(cursor ? { cursor } : {}),
              });
              for (const c of result.channels ?? []) {
                if (c.name?.toLowerCase().includes(query)) {
                  matches.push(`${c.id} #${c.name} (${c.is_private ? 'private' : 'public'}, ${c.num_members ?? 0} members)`);
                  if (matches.length >= limit) break;
                }
              }
              cursor = result.response_metadata?.next_cursor;
              if (!cursor) break;
            }
            return {
              toolCallId: '',
              content: matches.length > 0
                ? `Found ${matches.length} channel(s):\n${matches.join('\n')}`
                : `No channels matching "${args.query}"`,
            };
          },
        });
      }

      // ── slack_search_users ─────────────────────────────────────
      // No search.users API — use users.list + filter.
      if (shouldInclude('search_users')) {
        agent.tool({
          name: 'slack_search_users',
          description:
            'Search for users in the workspace by name, display name, ' +
            'or email. Returns user IDs, names, and emails. Uses ' +
            'users.list with client-side filtering.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'User name, display name, or email to search for' },
              limit: { type: 'number', description: 'Max results (default 20)' },
            },
            required: ['query'],
          },
          async execute(args) {
            const query = (args.query as string).toLowerCase();
            const limit = (args.limit as number) ?? 20;
            const matches: string[] = [];
            let cursor: string | undefined;
            while (matches.length < limit) {
              const result = await client.users.list({
                limit: 200,
                ...(cursor ? { cursor } : {}),
              });
              for (const u of result.members ?? []) {
                if (u.deleted) continue;
                const name = (u.name ?? '').toLowerCase();
                const realName = (u.real_name ?? '').toLowerCase();
                const displayName = ((u.profile as Record<string, unknown>)?.display_name as string ?? '').toLowerCase();
                const email = ((u.profile as Record<string, unknown>)?.email as string ?? '').toLowerCase();
                if (name.includes(query) || realName.includes(query) || displayName.includes(query) || email.includes(query)) {
                  const title = (u.profile as Record<string, unknown>)?.title ?? '';
                  matches.push(`${u.id} ${u.name}${u.real_name ? ` (${u.real_name})` : ''}${email ? ` <${email}>` : ''}${title ? ` — ${title}` : ''}`);
                  if (matches.length >= limit) break;
                }
              }
              cursor = result.response_metadata?.next_cursor;
              if (!cursor) break;
            }
            return {
              toolCallId: '',
              content: matches.length > 0
                ? `Found ${matches.length} user(s):\n${matches.join('\n')}`
                : `No users matching "${args.query}"`,
            };
          },
        });
      }
    },
  };
}
