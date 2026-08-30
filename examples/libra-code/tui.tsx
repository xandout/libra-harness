import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { ScrollView, type ScrollViewRef } from 'ink-scroll-view';
import { marked } from 'marked';
// @ts-ignore - no type declarations available
import markedTerminal from 'marked-terminal';

// ── Types ────────────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ToolActivity {
  name: string;
  detail: string;
  status: 'running' | 'done' | 'error';
  result?: string;
  timestamp: number;
}

export interface FileChange {
  path: string;
  tool: string;
  timestamp: number;
  before: string;
  after: string;
  diff: string;
  isNew: boolean;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SessionStats {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  llmCalls: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  lastPromptTokens: number;
  lastCompletionTokens: number;
}

interface TuiProps {
  messages: ChatMessage[];
  toolActivity: ToolActivity[];
  fileChanges: FileChange[];
  todos: TodoItem[];
  stats: SessionStats;
  streamingText: string;
  isRunning: boolean;
  inputText: string;
  onInput: (text: string) => void;
  onSubmit: (text: string) => void;
  onExit: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

function shortPath(path: string, maxLen: number = 50): string {
  if (path.length <= maxLen) return path;
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  return '…/' + parts.slice(-2).join('/');
}

// ── Markdown rendering ───────────────────────────────────────────────
// Configure marked with the terminal renderer for ANSI-formatted output.
marked.setOptions({
  renderer: new markedTerminal({
    showSectionPrefix: false,
    reflowText: true,
    width: Math.min(process.stdout.columns ?? 80, 120),
  }) as any,
});

/** Render markdown text as ANSI-formatted terminal output. */
function renderMarkdown(text: string): string {
  try {
    return marked.parse(text) as string;
  } catch {
    return text;
  }
}

// ── Active panel (which panel receives scroll input) ─────────────────
type ActivePanel = 'chat' | 'diff' | 'todos';

// ── Diff viewer ──────────────────────────────────────────────────────
// Returns an array of React nodes (one per line) so the ScrollView can
// measure and scroll each line individually.
function DiffLines({ changes }: { changes: FileChange[] }): React.ReactNode[] {
  if (changes.length === 0) {
    return [<Text key="empty" dimColor italic> No file changes yet</Text>];
  }

  const change = changes[changes.length - 1];
  const allLines = change.diff.split('\n');
  const nodes: React.ReactNode[] = [];

  // Header line.
  nodes.push(
    <Box key="header" marginBottom={1}>
      <Text bold color={change.isNew ? 'green' : 'yellow'}>
        {change.isNew ? '[new] ' : '[edit] '}
      </Text>
      <Text bold>{shortPath(change.path, 60)}</Text>
      <Text dimColor> ({change.tool})</Text>
    </Box>,
  );

  // Diff lines.
  allLines.forEach((line, i) => {
    const isAdded = line.startsWith('+');
    const isRemoved = line.startsWith('-');
    const color = isAdded ? 'green' : isRemoved ? 'red' : undefined;
    const dim = !isAdded && !isRemoved;
    nodes.push(
      <Text key={`line-${i}`} color={color as any} dimColor={dim} wrap="wrap">
        {line}
      </Text>,
    );
  });

  return nodes;
}

// ── Chat content (returns array of nodes for ScrollView) ─────────────
function ChatLines({
  messages,
  streamingText,
}: {
  messages: ChatMessage[];
  streamingText: string;
}): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = 0;

  for (const msg of messages) {
    const isUser = msg.role === 'user';
    const isAssistant = msg.role === 'assistant';

    if (isUser) {
      nodes.push(
        <Box key={`msg-${key++}`} flexDirection="column" marginBottom={1}>
          <Text color="cyan" bold>You:</Text>
          <Text color="cyan">{msg.content}</Text>
        </Box>,
      );
    } else if (isAssistant) {
      const rendered = renderMarkdown(msg.content);
      nodes.push(
        <Box key={`msg-${key++}`} flexDirection="column" marginBottom={1}>
          <Text color="green" bold>Agent:</Text>
          <Text>{rendered}</Text>
        </Box>,
      );
    } else {
      nodes.push(
        <Box key={`msg-${key++}`} flexDirection="column" marginBottom={1}>
          <Text color="gray">{msg.content}</Text>
        </Box>,
      );
    }
  }

  if (streamingText) {
    nodes.push(
      <Box key={`msg-${key++}`} flexDirection="column">
        <Text color="green" bold>Agent:</Text>
        <Text>{renderMarkdown(streamingText)}</Text>
        <Text dimColor>▋</Text>
      </Box>,
    );
  }

  return nodes;
}

// ── Todos panel (returns array of nodes for ScrollView) ──────────────
function TodoLines({ todos }: { todos: TodoItem[] }): React.ReactNode[] {
  if (todos.length === 0) {
    return [<Text key="empty" dimColor italic> No todos</Text>];
  }

  const nodes: React.ReactNode[] = [];
  todos.forEach((todo, i) => {
    let icon: string;
    let color: string;
    if (todo.status === 'completed') {
      icon = '✓';
      color = 'green';
    } else if (todo.status === 'in_progress') {
      icon = '▶';
      color = 'yellow';
    } else {
      icon = '○';
      color = 'gray';
    }
    nodes.push(
      <Box key={`todo-${i}`}>
        <Text color={color as any} bold={todo.status === 'in_progress'}>{icon} </Text>
        <Text
          color={todo.status === 'completed' ? 'gray' : 'white'}
          dimColor={todo.status === 'completed'}
          strikethrough={todo.status === 'completed'}
          wrap="wrap"
        >
          {todo.content}
        </Text>
      </Box>,
    );
  });
  return nodes;
}

// ── Stats panel (returns array of nodes) ─────────────────────────────
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function StatsLines({ stats }: { stats: SessionStats }): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const k = (s: string) => `stat-${s}`;

  // Session context.
  nodes.push(
    <Box key={k('turns')} justifyContent="space-between">
      <Text dimColor>turns</Text>
      <Text bold>{stats.turns}</Text>
    </Box>,
  );
  nodes.push(
    <Box key={k('llm')} justifyContent="space-between">
      <Text dimColor>llm calls</Text>
      <Text bold>{stats.llmCalls}</Text>
    </Box>,
  );
  nodes.push(
    <Box key={k('tools')} justifyContent="space-between">
      <Text dimColor>tool calls</Text>
      <Text bold>{stats.toolCalls}{stats.toolErrors > 0 ? <Text color="red"> ({stats.toolErrors}✗)</Text> : null}</Text>
    </Box>,
  );

  // Separator.
  nodes.push(<Text key={k('sep1')} dimColor>──────────────</Text>);

  // Token usage (cumulative).
  nodes.push(
    <Box key={k('prompt')} justifyContent="space-between">
      <Text dimColor>prompt</Text>
      <Text color="cyan">{fmtTokens(stats.promptTokens)}</Text>
    </Box>,
  );
  nodes.push(
    <Box key={k('completion')} justifyContent="space-between">
      <Text dimColor>completion</Text>
      <Text color="green">{fmtTokens(stats.completionTokens)}</Text>
    </Box>,
  );

  if (stats.cachedPromptTokens > 0) {
    nodes.push(
      <Box key={k('cached')} justifyContent="space-between">
        <Text dimColor>cache read</Text>
        <Text color="yellow">{fmtTokens(stats.cachedPromptTokens)}</Text>
      </Box>,
    );
  }
  if (stats.cacheWriteTokens > 0) {
    nodes.push(
      <Box key={k('cachew')} justifyContent="space-between">
        <Text dimColor>cache write</Text>
        <Text color="yellow">{fmtTokens(stats.cacheWriteTokens)}</Text>
      </Box>,
    );
  }
  if (stats.reasoningTokens > 0) {
    nodes.push(
      <Box key={k('reasoning')} justifyContent="space-between">
        <Text dimColor>reasoning</Text>
        <Text color="magenta">{fmtTokens(stats.reasoningTokens)}</Text>
      </Box>,
    );
  }

  // Separator.
  nodes.push(<Text key={k('sep2')} dimColor>──────────────</Text>);

  // Last call details.
  nodes.push(
    <Box key={k('last')} flexDirection="column">
      <Text dimColor>last call:</Text>
      <Text dimColor>  {fmtTokens(stats.lastPromptTokens)} in</Text>
      <Text dimColor>  {fmtTokens(stats.lastCompletionTokens)} out</Text>
    </Box>,
  );

  return nodes;
}

// ── Status bar ───────────────────────────────────────────────────────
function StatusBar({
  toolActivity,
  todos,
  isRunning,
  activePanel,
}: {
  toolActivity: ToolActivity[];
  todos: TodoItem[];
  isRunning: boolean;
  activePanel: ActivePanel;
}) {
  const latestTool = toolActivity[toolActivity.length - 1];
  const completedTools = toolActivity.filter((t) => t.status === 'done').length;
  const errorTools = toolActivity.filter((t) => t.status === 'error').length;
  const totalTools = toolActivity.length;

  const todoDone = todos.filter((t) => t.status === 'completed').length;
  const todoInProgress = todos.find((t) => t.status === 'in_progress');
  const todoSummary = todos.length > 0
    ? `todos: ${todoDone}/${todos.length}${todoInProgress ? ` | ▶ ${truncate(todoInProgress.content, 30)}` : ''}`
    : '';

  return (
    <Box flexDirection="column">
      {/* Tool activity line */}
      <Box>
        <Text color={isRunning ? 'yellow' : 'gray'}>
          {isRunning ? '●' : '○'}
        </Text>
        <Text> </Text>
        {latestTool ? (
          <Text>
            <Text color={latestTool.status === 'error' ? 'red' : latestTool.status === 'done' ? 'green' : 'yellow'}>
              {latestTool.status === 'done' ? '✓' : latestTool.status === 'error' ? '✗' : '→'}
            </Text>
            {' '}
            <Text bold>{latestTool.name}</Text>
            <Text dimColor>({truncate(latestTool.detail, 40)})</Text>
            {' '}
            <Text dimColor>[{completedTools}✓ {errorTools}✗ /{totalTools}]</Text>
          </Text>
        ) : (
          <Text dimColor italic>No tool activity</Text>
        )}
      </Box>

      {/* Todo + status line */}
      <Box>
        <Text dimColor>
          {todoSummary}
          {todoSummary && isRunning ? ' | ' : ''}
          {isRunning ? <Text color="yellow">working…</Text> : <Text color="green">idle</Text>}
          {' | '}
          <Text color={activePanel === 'chat' ? 'cyan' : 'gray'}>[Chat]</Text>
          {' '}
          <Text color={activePanel === 'diff' ? 'cyan' : 'gray'}>[Diff]</Text>
          {' '}
          <Text color={activePanel === 'todos' ? 'cyan' : 'gray'}>[Todos]</Text>
          {' '}
          <Text dimColor>Tab to switch | ↑↓ scroll | Enter send | Ctrl+C quit</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ── Input box ────────────────────────────────────────────────────────
function InputBox({
  inputText,
  isRunning,
  onInput,
  onSubmit,
}: {
  inputText: string;
  isRunning: boolean;
  onInput: (text: string) => void;
  onSubmit: (text: string) => void;
}) {
  useInput((input, key) => {
    if (key.return) {
      if (inputText.trim() && !isRunning) {
        onSubmit(inputText);
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (inputText.length > 0) {
        onInput(inputText.slice(0, -1));
      }
      return;
    }
    if (key.ctrl && input === 'u') {
      onInput('');
      return;
    }
    if (input && !key.ctrl && !key.meta && input.length === 1 && input.charCodeAt(0) >= 32) {
      onInput(inputText + input);
    }
  });

  return (
    <Box borderStyle="round" borderColor={isRunning ? '#444' : '#555'} marginX={1}>
      <Text dimColor>{isRunning ? '⏳' : '>'} </Text>
      <Text color={isRunning ? 'gray' : 'white'}>{inputText}</Text>
      {!isRunning && <Text color="gray">▋</Text>}
      {isRunning && <Text dimColor italic> (waiting for agent…)</Text>}
    </Box>
  );
}

// ── Main TUI ─────────────────────────────────────────────────────────
export function TuiApp({
  messages,
  toolActivity,
  fileChanges,
  todos,
  stats,
  streamingText,
  isRunning,
  inputText,
  onInput,
  onSubmit,
  onExit,
}: TuiProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [activePanel, setActivePanel] = useState<ActivePanel>('chat');

  const chatScrollRef = useRef<ScrollViewRef>(null);
  const diffScrollRef = useRef<ScrollViewRef>(null);
  const todosScrollRef = useRef<ScrollViewRef>(null);
  const statsScrollRef = useRef<ScrollViewRef>(null);

  // Track whether we should stick to the bottom of each panel.
  const chatStickToBottom = useRef(true);
  const diffStickToBottom = useRef(true);

  // Auto-scroll chat to bottom when new content arrives.
  const prevMsgCount = useRef(0);
  const prevStreamLen = useRef(0);
  useEffect(() => {
    const msgCount = messages.length;
    const streamLen = streamingText.length;
    if (msgCount !== prevMsgCount.current || streamLen !== prevStreamLen.current) {
      chatStickToBottom.current = true;
      chatScrollRef.current?.remeasure();
      prevMsgCount.current = msgCount;
      prevStreamLen.current = streamLen;
    }
  }, [messages, streamingText]);

  // Auto-scroll diff to bottom when new file changes arrive.
  const prevChangeCount = useRef(0);
  useEffect(() => {
    if (fileChanges.length !== prevChangeCount.current) {
      diffStickToBottom.current = true;
      diffScrollRef.current?.remeasure();
      prevChangeCount.current = fileChanges.length;
    }
  }, [fileChanges]);

  // Handle terminal resize.
  useEffect(() => {
    const handleResize = () => {
      chatScrollRef.current?.remeasure();
      diffScrollRef.current?.remeasure();
      todosScrollRef.current?.remeasure();
      statsScrollRef.current?.remeasure();
    };
    stdout?.on('resize', handleResize);
    return () => { stdout?.off('resize', handleResize); };
  }, [stdout]);

  // Global keyboard: Tab to switch panels, scroll with arrows, q to quit.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      onExit();
      return;
    }
    // Tab cycles between chat, diff, and todos panels.
    if (key.tab) {
      setActivePanel((prev) => prev === 'chat' ? 'diff' : prev === 'diff' ? 'todos' : 'chat');
      return;
    }
    // Scroll the active panel.
    if (key.upArrow) {
      if (activePanel === 'chat') { chatStickToBottom.current = false; chatScrollRef.current?.scrollBy(-1); }
      else if (activePanel === 'diff') { diffStickToBottom.current = false; diffScrollRef.current?.scrollBy(-1); }
      else { todosScrollRef.current?.scrollBy(-1); }
      return;
    }
    if (key.downArrow) {
      if (activePanel === 'chat') { chatStickToBottom.current = false; chatScrollRef.current?.scrollBy(1); }
      else if (activePanel === 'diff') { diffStickToBottom.current = false; diffScrollRef.current?.scrollBy(1); }
      else { todosScrollRef.current?.scrollBy(1); }
      return;
    }
    if (key.pageUp) {
      if (activePanel === 'chat') {
        chatStickToBottom.current = false;
        const h = chatScrollRef.current?.getViewportHeight() ?? 10;
        chatScrollRef.current?.scrollBy(-h);
      } else if (activePanel === 'diff') {
        diffStickToBottom.current = false;
        const h = diffScrollRef.current?.getViewportHeight() ?? 10;
        diffScrollRef.current?.scrollBy(-h);
      } else {
        const h = todosScrollRef.current?.getViewportHeight() ?? 10;
        todosScrollRef.current?.scrollBy(-h);
      }
      return;
    }
    if (key.pageDown) {
      if (activePanel === 'chat') {
        const h = chatScrollRef.current?.getViewportHeight() ?? 10;
        chatScrollRef.current?.scrollBy(h);
        const bottom = chatScrollRef.current?.getBottomOffset() ?? 0;
        const offset = chatScrollRef.current?.getScrollOffset() ?? 0;
        if (offset >= bottom) chatStickToBottom.current = true;
      } else if (activePanel === 'diff') {
        const h = diffScrollRef.current?.getViewportHeight() ?? 10;
        diffScrollRef.current?.scrollBy(h);
        const bottom = diffScrollRef.current?.getBottomOffset() ?? 0;
        const offset = diffScrollRef.current?.getScrollOffset() ?? 0;
        if (offset >= bottom) diffStickToBottom.current = true;
      } else {
        const h = todosScrollRef.current?.getViewportHeight() ?? 10;
        todosScrollRef.current?.scrollBy(h);
      }
      return;
    }
  });

  // Compute panel height from terminal size.
  // Layout: header(1) + panels(N) + statusbar(2) + input(3) = total
  const termHeight = stdout?.rows ?? 24;
  const panelHeight = Math.max(termHeight - 1 - 2 - 3, 5);
  // Inside each panel: border(2) + title(1) = 3 lines of chrome.
  const scrollHeight = Math.max(panelHeight - 3, 2);

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color="magenta">lc</Text>
        <Text dimColor> — libra code agent</Text>
      </Box>

      {/* Three columns: Diff (left), Chat (center), Todos (right) */}
      <Box flexDirection="row" height={panelHeight} marginX={1}>
        {/* Diff viewer (left) */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={activePanel === 'diff' ? '#555' : '#333'}
          width="40%"
          height="100%"
          overflow="hidden"
        >
          <Box paddingX={1}>
            <Text bold dimColor>Changes</Text>
            {activePanel === 'diff' && <Text color="cyan"> ←</Text>}
          </Box>
          <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
            <ScrollView
              ref={diffScrollRef}
              height={scrollHeight}
              onContentHeightChange={() => {
                if (diffStickToBottom.current) {
                  diffScrollRef.current?.scrollToBottom();
                }
              }}
            >
              {DiffLines({ changes: fileChanges })}
            </ScrollView>
          </Box>
        </Box>

        {/* Chat panel (center) */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={activePanel === 'chat' ? '#555' : '#333'}
          width="42%"
          height="100%"
          overflow="hidden"
        >
          <Box paddingX={1}>
            <Text bold dimColor>Chat</Text>
            {activePanel === 'chat' && <Text color="cyan"> ←</Text>}
          </Box>
          <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
            <ScrollView
              ref={chatScrollRef}
              height={scrollHeight}
              onContentHeightChange={() => {
                if (chatStickToBottom.current) {
                  chatScrollRef.current?.scrollToBottom();
                }
              }}
            >
              {ChatLines({ messages, streamingText })}
            </ScrollView>
          </Box>
        </Box>

        {/* Right column: Todos (top) + Stats (bottom) */}
        <Box flexDirection="column" width="22%" height="100%">
          {/* Todos panel (top) */}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={activePanel === 'todos' ? '#555' : '#333'}
            height="50%"
            overflow="hidden"
          >
            <Box paddingX={1}>
              <Text bold dimColor>Todos</Text>
              {activePanel === 'todos' && <Text color="cyan"> ←</Text>}
            </Box>
            <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
              <ScrollView ref={todosScrollRef} height={Math.max(Math.floor(scrollHeight * 0.5), 2)}>
                {TodoLines({ todos })}
              </ScrollView>
            </Box>
          </Box>

          {/* Stats panel (bottom) */}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="#333"
            height="50%"
            marginTop={0}
            overflow="hidden"
          >
            <Box paddingX={1}>
              <Text bold dimColor>Stats</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
              <ScrollView ref={statsScrollRef} height={Math.max(Math.floor(scrollHeight * 0.5), 2)}>
                {StatsLines({ stats })}
              </ScrollView>
            </Box>
          </Box>
        </Box>
      </Box>

      {/* Status bar */}
      <Box marginX={1}>
        <StatusBar
          toolActivity={toolActivity}
          todos={todos}
          isRunning={isRunning}
          activePanel={activePanel}
        />
      </Box>

      {/* Input box */}
      <InputBox
        inputText={inputText}
        isRunning={isRunning}
        onInput={onInput}
        onSubmit={onSubmit}
      />
    </Box>
  );
}
