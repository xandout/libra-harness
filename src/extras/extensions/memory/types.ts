import type { Message } from '../../../types.js';
import type { AgentResponse } from '../../../context.js';

/**
 * A discrete piece of knowledge extracted from a conversation.
 *
 * Memories are natural language, not structured records. They should be
 * concise (1-3 sentences) and self-contained.
 */
export interface Memory {
  /** Unique identifier assigned by the store on creation. */
  id: string;
  /** Natural language text, 1-3 sentences, self-contained. */
  content: string;
  /** Session ID this memory belongs to. */
  scope: string;
  /** ISO timestamp — when the memory was first created. */
  createdAt: string;
  /** ISO timestamp — when the memory was last updated. */
  updatedAt: string;
  /** Optional metadata: tags, source, confidence, category, etc. */
  metadata?: Record<string, unknown>;
}

/** Input for creating a new memory. */
export interface MemoryInput {
  content: string;
  scope: string;
  metadata?: Record<string, unknown>;
}

/** Patch for updating an existing memory. */
export interface MemoryPatch {
  content?: string;
  metadata?: Record<string, unknown>;
}

/** Query for searching memories. */
export interface MemoryQuery {
  /** Session ID to search within. */
  scope: string;
  /** Natural language search text (typically the user's message). */
  text: string;
  /** Maximum results to return. */
  maxResults?: number;
  /** Optional metadata filters (implementation-specific). */
  filter?: Record<string, unknown>;
}

/**
 * Abstract storage backend.
 *
 * The memory extension depends on this interface; the host provides a
 * concrete implementation (vector DB, SQLite, Postgres, etc.).
 *
 * The search ranking algorithm is implementation-specific. A vector DB
 * would use cosine similarity; a simple KV store might do keyword matching.
 * The contract is: given a scope and text, return the most relevant
 * memories, best first.
 */
export interface MemoryStore {
  /** Create a new memory. Returns the stored memory with id/timestamps. */
  save(input: MemoryInput): Promise<Memory>;
  /** Get a single memory by ID. Returns null if not found. */
  get(id: string): Promise<Memory | null>;
  /** Search memories within a scope. Returns results ranked by relevance. */
  search(query: MemoryQuery): Promise<Memory[]>;
  /** Update a memory's content and/or metadata. */
  update(id: string, patch: MemoryPatch): Promise<Memory>;
  /** Delete a memory by ID. */
  delete(id: string): Promise<void>;
  /** List all memories for a scope (for extractor dedup context). */
  listByScope(scope: string): Promise<Memory[]>;
  /** Optional: prune memories according to a store-defined policy. */
  prune?(scope: string): Promise<number>;
}

/** Input passed to the extractor. */
export interface ExtractorInput {
  /** Session ID. */
  scope: string;
  /** The full conversation messages from this turn. */
  messages: Message[];
  /** The agent's final response. */
  response: AgentResponse;
  /** Existing memories for this scope (for dedup/update/delete decisions). */
  existingMemories: Memory[];
}

/**
 * A single extraction operation — what the extractor decided to do with
 * one piece of information from the conversation.
 */
export interface ExtractedMemory {
  /** The memory text (for create) or new text (for update). */
  content: string;
  /** What to do with this extraction. */
  action: 'create' | 'update' | 'delete';
  /** Required for update/delete — the existing memory ID to modify. */
  targetId?: string;
  /** Optional metadata to attach or merge. */
  metadata?: Record<string, unknown>;
}

/**
 * Decides what to remember from a completed turn.
 *
 * Called in the `afterTurn` hook. Receives the full conversation and
 * existing memories so it can deduplicate, update, or delete as well as
 * create. Returns a list of operations to apply to the store.
 */
export interface MemoryExtractor {
  extract(input: ExtractorInput): Promise<ExtractedMemory[]>;
}

/** Input passed to the retriever. */
export interface RetrievalInput {
  /** Session ID. */
  scope: string;
  /** The user's message (search query). */
  text: string;
  /** The store to search against. */
  store: MemoryStore;
}

/**
 * Formats and filters search results before injection.
 *
 * Separated from the store so retrieval logic (formatting, truncation,
 * relevance thresholds) can vary independently of storage.
 */
export interface MemoryRetriever {
  retrieve(input: RetrievalInput): Promise<Memory[]>;
}

/**
 * Configuration for the memory extension.
 */
export interface MemoryExtensionConfig {
  /** Storage backend (required). */
  store: MemoryStore;
  /** Extraction strategy (required). */
  extractor: MemoryExtractor;
  /** Retrieval strategy (optional — defaults to pass-through to store.search). */
  retriever?: MemoryRetriever;
  /** Max memories to inject per turn (default: 10). */
  maxRecall?: number;
  /** Metadata key for session ID (default: 'sessionId'). */
  scopeKey?: string;
  /** Extension load priority (default: -95). */
  priority?: number;
}
