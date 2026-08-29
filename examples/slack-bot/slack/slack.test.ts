import { describe, it, expect, vi } from 'vitest';
import { extractTextFromBlocks } from './blocks.js';
import { chunkText, postMessage, postMessageWithBlocks } from './messages.js';
import { addReaction, removeReaction, swapReaction } from './reactions.js';

// ── blocks.ts ───────────────────────────────────────────────────────

describe('extractTextFromBlocks', () => {
  it('extracts text from section blocks', () => {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: 'Hello world' } },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('Hello world');
  });

  it('extracts text from header blocks with ## prefix', () => {
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Title' } },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('## Title');
  });

  it('extracts divider as ---', () => {
    const blocks = [{ type: 'divider' }];
    expect(extractTextFromBlocks(blocks)).toBe('---');
  });

  it('extracts context block text', () => {
    const blocks = [
      { type: 'context', elements: [
        { type: 'mrkdwn', text: 'small text' },
        { type: 'plain_text', text: 'more' },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('small text\nmore');
  });

  it('extracts button labels from actions', () => {
    const blocks = [
      { type: 'actions', elements: [
        { type: 'button', text: { text: 'Click me' } },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('[Click me]');
  });

  it('extracts rich text sections with text spans', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_section', elements: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ] },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('Hello world');
  });

  it('extracts links with both display text and URL', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_section', elements: [
          { type: 'text', text: 'check ' },
          { type: 'link', url: 'https://example.com', text: 'this link' },
        ] },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('check this link (https://example.com)');
  });

  it('extracts links with URL only when no display text', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_section', elements: [
          { type: 'link', url: 'https://example.com' },
        ] },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('https://example.com');
  });

  it('extracts user mentions', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_section', elements: [
          { type: 'user', user_id: 'U123' },
        ] },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('<@U123>');
  });

  it('extracts channel mentions', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_section', elements: [
          { type: 'channel', channel_id: 'C456' },
        ] },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('<#C456>');
  });

  it('extracts emoji', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_section', elements: [
          { type: 'emoji', name: 'turkey' },
        ] },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toBe(':turkey:');
  });

  it('extracts unordered lists', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_list', style: 'bullet', elements: [
          { elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'item 1' }] }] },
          { elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'item 2' }] }] },
        ] },
      ] },
    ];
    const result = extractTextFromBlocks(blocks);
    expect(result).toContain('• item 1');
    expect(result).toContain('• item 2');
  });

  it('extracts ordered lists with numbers', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_list', style: 'ordered', elements: [
          { elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'first' }] }] },
          { elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'second' }] }] },
        ] },
      ] },
    ];
    const result = extractTextFromBlocks(blocks);
    expect(result).toContain('1. first');
    expect(result).toContain('2. second');
  });

  it('extracts code blocks', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_preformatted', elements: [
          { type: 'rich_text_section', elements: [{ type: 'text', text: 'const x = 1;' }] },
        ] },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('```\nconst x = 1;\n```');
  });

  it('extracts quotes', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_quote', elements: [
          { type: 'rich_text_section', elements: [{ type: 'text', text: 'quoted text' }] },
        ] },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('> quoted text');
  });

  it('extracts table blocks', () => {
    const blocks = [
      { type: 'table', rows: [
        [
          { type: 'raw_text', text: 'Name' },
          { type: 'raw_text', text: 'Value' },
        ],
        [
          { type: 'raw_text', text: 'foo' },
          { type: 'raw_number', text: '42' },
        ],
      ] },
    ];
    const result = extractTextFromBlocks(blocks);
    expect(result).toContain('| Name | Value |');
    expect(result).toContain('| foo | 42 |');
  });

  it('handles empty blocks array', () => {
    expect(extractTextFromBlocks([])).toBe('');
  });

  it('handles null/undefined blocks gracefully', () => {
    expect(extractTextFromBlocks([null, undefined, {}])).toBe('');
  });

  it('extracts links in list items', () => {
    const blocks = [
      { type: 'rich_text', elements: [
        { type: 'rich_text_list', style: 'bullet', elements: [
          { elements: [{ type: 'rich_text_section', elements: [
            { type: 'link', url: 'https://example.com', text: 'link' },
          ] }] },
        ] },
      ] },
    ];
    expect(extractTextFromBlocks(blocks)).toContain('link (https://example.com)');
  });
});

// ── messages.ts ─────────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns single chunk for short text', () => {
    expect(chunkText('hello')).toEqual(['hello']);
  });

  it('returns single chunk for text at limit', () => {
    const text = 'a'.repeat(4000);
    expect(chunkText(text)).toEqual([text]);
  });

  it('splits at newline when possible', () => {
    const text = 'a'.repeat(3000) + '\n' + 'b'.repeat(2000);
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe('a'.repeat(3000));
    expect(chunks[1]).toBe('b'.repeat(2000));
  });

  it('splits at space when no newline near limit', () => {
    const text = 'word '.repeat(1000) + 'end';
    const chunks = chunkText(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be <= limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
  });

  it('hard-splits when no space or newline near limit', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text, 1000);
    expect(chunks.length).toBe(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(1000);
    }
  });

  it('trims whitespace from chunks', () => {
    const text = 'hello\n\n\n' + 'b'.repeat(3000);
    const chunks = chunkText(text, 1000);
    for (const chunk of chunks) {
      expect(chunk).toBe(chunk.trim());
    }
  });
});

describe('postMessage', () => {
  it('posts single message for short text', async () => {
    const post = vi.fn().mockResolvedValue({ ts: '123' });
    const client = { chat: { postMessage: post } } as any;
    await postMessage(client, 'C1', 'hello');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ channel: 'C1', text: 'hello' });
  });

  it('posts with thread_ts when provided', async () => {
    const post = vi.fn().mockResolvedValue({ ts: '123' });
    const client = { chat: { postMessage: post } } as any;
    await postMessage(client, 'C1', 'hello', '1234567890.123');
    expect(post).toHaveBeenCalledWith({
      channel: 'C1',
      thread_ts: '1234567890.123',
      text: 'hello',
    });
  });

  it('posts multiple chunks for long text', async () => {
    const post = vi.fn().mockResolvedValue({ ts: '123' });
    const client = { chat: { postMessage: post } } as any;
    const text = 'a'.repeat(5000);
    await postMessage(client, 'C1', text);
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('postMessageWithBlocks', () => {
  it('posts with blocks and text', async () => {
    const post = vi.fn().mockResolvedValue({ ts: '123' });
    const client = { chat: { postMessage: post } } as any;
    const result = await postMessageWithBlocks(client, 'C1', 'fallback', [{ type: 'section' }]);
    expect(result.ok).toBe(true);
    expect(result.ts).toBe('123');
    expect(post).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'fallback',
      blocks: [{ type: 'section' }],
    });
  });

  it('returns error on failure', async () => {
    const post = vi.fn().mockRejectedValue(new Error('API error'));
    const client = { chat: { postMessage: post } } as any;
    const result = await postMessageWithBlocks(client, 'C1', 'text');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('API error');
  });

  it('omits text when empty', async () => {
    const post = vi.fn().mockResolvedValue({ ts: '123' });
    const client = { chat: { postMessage: post } } as any;
    await postMessageWithBlocks(client, 'C1', '', [{ type: 'section' }]);
    expect(post).toHaveBeenCalledWith({
      channel: 'C1',
      blocks: [{ type: 'section' }],
    });
  });
});

// ── reactions.ts ────────────────────────────────────────────────────

describe('reactions', () => {
  function mockClient() {
    const add = vi.fn().mockResolvedValue({ ok: true });
    const remove = vi.fn().mockResolvedValue({ ok: true });
    return { client: { reactions: { add, remove } } as any, add, remove };
  }

  it('addReaction calls reactions.add', async () => {
    const { client, add } = mockClient();
    await addReaction(client, 'C1', '123', 'thumbsup');
    expect(add).toHaveBeenCalledWith({ channel: 'C1', timestamp: '123', name: 'thumbsup' });
  });

  it('removeReaction calls reactions.remove', async () => {
    const { client, remove } = mockClient();
    await removeReaction(client, 'C1', '123', 'thumbsup');
    expect(remove).toHaveBeenCalledWith({ channel: 'C1', timestamp: '123', name: 'thumbsup' });
  });

  it('swapReaction removes then adds', async () => {
    const { client, add, remove } = mockClient();
    await swapReaction(client, 'C1', '123', 'thinking_face', 'white_check_mark');
    expect(remove).toHaveBeenCalledWith({ channel: 'C1', timestamp: '123', name: 'thinking_face' });
    expect(add).toHaveBeenCalledWith({ channel: 'C1', timestamp: '123', name: 'white_check_mark' });
    // Remove should be called before add
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(add.mock.invocationCallOrder[0]);
  });

  it('addReaction swallows errors', async () => {
    const add = vi.fn().mockRejectedValue(new Error('fail'));
    const client = { reactions: { add } } as any;
    // Should not throw
    await expect(addReaction(client, 'C1', '123', 'x')).resolves.toBeUndefined();
  });

  it('removeReaction swallows errors', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('fail'));
    const client = { reactions: { remove } } as any;
    await expect(removeReaction(client, 'C1', '123', 'x')).resolves.toBeUndefined();
  });
});

// ── File extraction in message handler ──────────────────────────────

describe('file metadata extraction', () => {
  it('extracts file metadata from message files array', () => {
    // Simulate what the message handler does with files
    const files = [
      { id: 'F123', name: 'report.pdf', mimetype: 'application/pdf', filetype: 'pdf', size: 1024 },
      { id: 'F456', name: 'data.csv', mimetype: 'text/csv', filetype: 'csv', size: 512 },
    ];
    const fileText = '\n\n[Attached files:]' + files.map((f) => {
      const id = f.id ?? 'unknown';
      const name = f.name ?? 'unknown';
      const mimetype = f.mimetype ?? 'unknown';
      const size = f.size ?? '?';
      const filetype = f.filetype ?? 'unknown';
      return `\n  - file_id=${id} name="${name}" type=${mimetype} filetype=${filetype} size=${size}b`;
    }).join('');

    expect(fileText).toContain('F123');
    expect(fileText).toContain('report.pdf');
    expect(fileText).toContain('application/pdf');
    expect(fileText).toContain('F456');
    expect(fileText).toContain('data.csv');
    expect(fileText).toContain('text/csv');
  });

  it('produces empty file text when no files', () => {
    const files: any[] = [];
    const fileText = files.length > 0 ? 'has files' : '';
    expect(fileText).toBe('');
  });
});

// ── Slack extension tools (download_file, upload_file) ─────────────

describe('slack extension file tools', () => {
  // We test the tool logic by creating a minimal agent with the extension
  // and capturing tool calls. Since the extension requires a WebClient,
  // we mock it.

  function mockFileClient(fileInfo: Record<string, unknown>, _fetchResponse?: Response) {
    const files = {
      info: vi.fn().mockResolvedValue({ file: fileInfo }),
      uploadV2: vi.fn().mockResolvedValue({ file: { id: 'FNEW', permalink: 'https://slack.com/FNEW' } }),
    };
    const chat = {
      postMessage: vi.fn().mockResolvedValue({ ts: '123' }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
    };
    const client = { files, chat, token: 'xoxb-test' } as any;
    return { client, files, chat };
  }

  it('download_file returns text content for text files', async () => {
    const { client, files } = mockFileClient({
      id: 'F123',
      name: 'notes.txt',
      mimetype: 'text/plain',
      filetype: 'text',
      size: 100,
      url_private: 'https://slack.com/files/F123/notes.txt',
    });

    // Mock global fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Hello world file content', { status: 200 }),
    );

    // Dynamically import the extension and test the tool
    const { default: createSlackExtension } = await import('./extension.js');
    const { Agent } = await import('libra');

    const agent = new Agent({
      model: {
        async generate() {
          return {
            message: { role: 'assistant' as const, content: 'done' },
            finishReason: 'stop' as const,
          };
        },
      } as any,
    });

    const ext = createSlackExtension({ client, botUserId: 'U1' });
    agent.use(ext);

    // Find the download_file tool and call it directly
    const tools = (agent as any).tools as Map<string, any>;
    const downloadTool = tools.get('slack_download_file');
    expect(downloadTool).toBeDefined();

    const result = await downloadTool.execute({ file: 'F123' });
    expect(result.content).toContain('notes.txt');
    expect(result.content).toContain('Hello world file content');
    expect(files.info).toHaveBeenCalledWith({ file: 'F123' });

    fetchSpy.mockRestore();
  });

  it('download_file returns base64 for images', async () => {
    const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    const { client } = mockFileClient({
      id: 'F456',
      name: 'photo.png',
      mimetype: 'image/png',
      filetype: 'png',
      size: 4,
      url_private: 'https://slack.com/files/F456/photo.png',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(imageBuffer, { status: 200 }),
    );

    const { default: createSlackExtension } = await import('./extension.js');
    const { Agent } = await import('libra');

    const agent = new Agent({
      model: { async generate() { return { message: { role: 'assistant' as const, content: 'done' }, finishReason: 'stop' as const }; } } as any,
    });
    agent.use(createSlackExtension({ client, botUserId: 'U1' }));

    const tools = (agent as any).tools as Map<string, any>;
    const downloadTool = tools.get('slack_download_file');
    const result = await downloadTool.execute({ file: 'F456' });

    expect(result.content).toContain('photo.png');
    expect(result.content).toContain('image/png');
    expect(result.content).toContain('base64');

    fetchSpy.mockRestore();
  });

  it('download_file returns metadata for unknown binary types', async () => {
    const { client } = mockFileClient({
      id: 'F789',
      name: 'archive.zip',
      mimetype: 'application/zip',
      filetype: 'zip',
      size: 5000,
      url_private: 'https://slack.com/files/F789/archive.zip',
    });

    const { default: createSlackExtension } = await import('./extension.js');
    const { Agent } = await import('libra');

    const agent = new Agent({
      model: { async generate() { return { message: { role: 'assistant' as const, content: 'done' }, finishReason: 'stop' as const }; } } as any,
    });
    agent.use(createSlackExtension({ client, botUserId: 'U1' }));

    const tools = (agent as any).tools as Map<string, any>;
    const downloadTool = tools.get('slack_download_file');
    const result = await downloadTool.execute({ file: 'F789' });

    expect(result.content).toContain('Binary file');
    expect(result.content).toContain('archive.zip');
    expect(result.content).toContain('application/zip');
  });

  it('upload_file calls files.upload with correct params', async () => {
    const { client, files } = mockFileClient({});

    const { default: createSlackExtension } = await import('./extension.js');
    const { Agent } = await import('libra');

    const agent = new Agent({
      model: { async generate() { return { message: { role: 'assistant' as const, content: 'done' }, finishReason: 'stop' as const }; } } as any,
    });
    agent.use(createSlackExtension({ client, botUserId: 'U1' }));

    const tools = (agent as any).tools as Map<string, any>;
    const uploadTool = tools.get('slack_upload_file');
    const result = await uploadTool.execute({
      channel: 'C1',
      filename: 'output.txt',
      content: 'Hello from the agent',
      title: 'Generated output',
    });

    expect(files.uploadV2).toHaveBeenCalledWith({
      channel_id: 'C1',
      filename: 'output.txt',
      content: 'Hello from the agent',
      title: 'Generated output',
    });
    expect(result.content).toContain('FNEW');
  });

  it('upload_file handles errors gracefully', async () => {
    const { client, files } = mockFileClient({});
    files.uploadV2.mockRejectedValue(new Error('Upload failed'));

    const { default: createSlackExtension } = await import('./extension.js');
    const { Agent } = await import('libra');

    const agent = new Agent({
      model: { async generate() { return { message: { role: 'assistant' as const, content: 'done' }, finishReason: 'stop' as const }; } } as any,
    });
    agent.use(createSlackExtension({ client, botUserId: 'U1' }));

    const tools = (agent as any).tools as Map<string, any>;
    const uploadTool = tools.get('slack_upload_file');
    const result = await uploadTool.execute({
      channel: 'C1',
      filename: 'output.txt',
      content: 'test',
    });

    expect(result.content).toContain('Failed to upload');
    expect(result.content).toContain('Upload failed');
  });
});
