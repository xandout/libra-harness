import type { Extension } from '../extension.js';
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * Absolute path to the shared extensions directory (bundled with libra).
 *
 * Computed at runtime from `import.meta.url`, so it always resolves to
 * the correct location regardless of where libra is installed.
 *
 * Use with {@link loadExtensions} to load built-in extensions (logging,
 * session, timestamp, emoji, weather-tool, streaming, structured-output,
 * mcp, skills) alongside your own local extensions in a single call:
 *
 * ```typescript
 * import { loadExtensions, sharedExtensionsDir } from 'libra/extras';
 *
 * const loaded = await loadExtensions(
 *   [sharedExtensionsDir, './extensions'],
 *   { skillsDirs: './skills', mcpConfigPaths: './mcpServers.json' },
 * );
 * ```
 *
 * For simpler cases, you can also import individual extensions directly:
 * `import { createLoggerExtension } from 'libra/extras/logger'`.
 */
export const sharedExtensionsDir = fileURLToPath(
  new URL('./extensions', import.meta.url),
);

/**
 * Optional manifest for an extension folder.
 *
 * If present (`extension.json`), it provides metadata that can be read
 * without importing the entry point — useful for listing/discovering
 * extensions cheaply (analogous to SKILL.md frontmatter).
 */
export interface ExtensionManifest {
  /** Display name. Defaults to the directory name. */
  name?: string;
  /** What the extension does. */
  description?: string;
  /** If false, the extension is discovered but not loaded. Defaults to true. */
  enabled?: boolean;
  /**
   * Load priority. Higher = loaded first. Extensions with the same
   * priority are sorted alphabetically by name. Default: 0.
   *
   * Use this to ensure observability extensions (logging) load before
   * mutators (session, skills) so their before-hooks see raw state.
   */
  priority?: number;
  /**
   * Config keys this extension expects to receive from the host's config
   * object. Documented here for discoverability — the loader passes the
   * entire config object to every factory, and each factory picks out
   * the keys it needs. Keys listed here are informational only (not
   * enforced), but tools can inspect them to show what an extension
   * wants.
   */
  configKeys?: string[];
  /** Arbitrary key-value metadata. */
  metadata?: Record<string, string>;
}

/**
 * A discovered extension folder — manifest metadata plus the directory path.
 * Available without importing the entry point (progressive disclosure
 * level 1).
 */
export interface DiscoveredExtension {
  /** Name from the manifest, or the directory name. */
  name: string;
  /** Description from the manifest, if any. */
  description?: string;
  /** Whether the manifest enabled this extension. */
  enabled: boolean;
  /** Load priority (higher = loaded first). Default: 0. */
  priority: number;
  /** Config keys this extension expects (informational, from manifest). */
  configKeys?: string[];
  /** Arbitrary metadata from the manifest. */
  metadata?: Record<string, string>;
  /** Absolute path to the extension directory. */
  dir: string;
}

/**
 * A loaded extension — the discovered metadata plus the installed
 * `Extension` object (progressive disclosure level 2).
 */
export interface LoadedExtension extends DiscoveredExtension {
  /** The installed extension instance. */
  extension: Extension;
}

/** Entry-point filenames tried in order. */
const ENTRY_POINTS = ['extension.ts', 'extension.js', 'index.ts', 'index.js'];

/**
 * Read the optional `extension.json` manifest from a directory.
 * Returns `{}` if the file is absent or invalid.
 */
function readManifest(dir: string): ExtensionManifest {
  const manifestPath = join(dir, 'extension.json');
  if (!existsSync(manifestPath)) return {};
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    return JSON.parse(raw) as ExtensionManifest;
  } catch {
    return {};
  }
}

/**
 * Find the entry-point file for an extension directory.
 * Returns the absolute path, or `undefined` if none of the candidates exist.
 */
function findEntryPoint(dir: string): string | undefined {
  for (const candidate of ENTRY_POINTS) {
    const path = join(dir, candidate);
    if (existsSync(path) && statSync(path).isFile()) {
      return path;
    }
  }
  return undefined;
}

/**
 * Discover extension folders under one or more directories.
 *
 * Each immediate subdirectory is treated as a candidate extension. A
 * subdirectory is considered an extension if it contains either an
 * `extension.json` manifest or one of the entry-point files
 * (`extension.ts`/`extension.js`/`index.ts`/`index.js`).
 *
 * Only metadata is read — no code is imported. This is the cheap,
 * progressive-disclosure level 1.
 *
 * @example
 * const found = discoverExtensions(['./extensions', './more']);
 * console.log(found.map((e) => e.name));
 */
export function discoverExtensions(dirs: string | string[]): DiscoveredExtension[] {
  const searchDirs = Array.isArray(dirs) ? dirs : [dirs];
  const found: DiscoveredExtension[] = [];

  for (const searchDir of searchDirs) {
    if (!existsSync(searchDir) || !statSync(searchDir).isDirectory()) continue;

    for (const entry of readdirSync(searchDir)) {
      const extDir = join(searchDir, entry);
      if (!statSync(extDir).isDirectory()) continue;

      const manifest = readManifest(extDir);
      const hasEntryPoint = findEntryPoint(extDir) !== undefined;

      // Skip directories that are neither manifest-declared nor code-bearing.
      if (!hasEntryPoint && Object.keys(manifest).length === 0) continue;

      found.push({
        name: manifest.name ?? entry,
        ...(manifest.description && { description: manifest.description }),
        enabled: manifest.enabled !== false,
        priority: manifest.priority ?? 0,
        ...(manifest.configKeys && { configKeys: manifest.configKeys }),
        ...(manifest.metadata && { metadata: manifest.metadata }),
        dir: extDir,
      });
    }
  }

  // Sort by priority (descending — higher loads first), then name (ascending).
  found.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  return found;
}

/**
 * Load a single discovered extension by importing its entry point.
 *
 * The entry point's default export may be either:
 * - An `Extension` object (with `name` and `install`) — config is ignored.
 * - A factory function `(config) => Extension | Promise<Extension | undefined>`.
 *
 * When a factory is used, the `config` object is passed to it. The
 * factory extracts the keys it needs (declared in the manifest's
 * `configKeys`). A factory may return `undefined` to opt out (e.g. when
 * required config is missing or a config file doesn't exist).
 *
 * The extension's own `name` field takes precedence over the manifest/dir
 * name once loaded.
 */
export async function loadExtension(
  discovered: DiscoveredExtension,
  config?: Record<string, unknown>,
): Promise<LoadedExtension | undefined> {
  const entryPath = findEntryPoint(discovered.dir);
  if (!entryPath) {
    throw new Error(`Extension "${discovered.name}" has no entry point in ${discovered.dir}`);
  }

  // file:// URL is required for dynamic import on Windows and is harmless on POSIX.
  const mod = await import(pathToFileURL(entryPath).href);
  const exported = mod.default;

  if (exported === undefined || exported === null) {
    throw new Error(
      `Extension "${discovered.name}" entry point ${entryPath} has no default export`,
    );
  }

  let extension: Extension | undefined;
  if (typeof exported === 'function') {
    // Factory function — pass config. May return undefined to opt out.
    extension = await exported(config);
  } else if (
    typeof exported === 'object' &&
    typeof exported.name === 'string' &&
    typeof exported.install === 'function'
  ) {
    extension = exported as Extension;
  } else {
    throw new Error(
      `Extension "${discovered.name}" entry point ${entryPath} must default-export an Extension or a factory function`,
    );
  }

  if (!extension) {
    // Factory opted out — return undefined so the caller can skip it.
    return undefined;
  }

  return {
    ...discovered,
    // The extension's own name wins once code is loaded.
    name: extension.name ?? discovered.name,
    extension,
  };
}

/**
 * A factory function that creates an Extension, optionally using config.
 * May return `undefined` to opt out (e.g. when required config is missing).
 */
export type ExtensionFactory = (
  config?: Record<string, unknown>,
) => Extension | Promise<Extension | undefined>;

/**
 * Items accepted by {@link loadExtensions}. Mix freely:
 * - `string` — a directory path to discover extensions in
 * - `ExtensionFactory` — a factory function called with config
 * - `Extension` — a ready-to-install extension object
 */
export type ExtensionInput = string | ExtensionFactory | Extension;

/**
 * Discover and load extensions from a mix of sources.
 *
 * Accepts an array of directory paths, factory functions, and/or
 * ready-made `Extension` objects. Directory paths are scanned for
 * extension subdirectories (each with `extension.json` and/or an entry
 * point). Factory functions are called with the `config` object. All
 * results are merged and sorted by priority (higher first, then
 * alphabetical).
 *
 * The `config` object is passed to every factory function. Each factory
 * extracts the keys it needs. Factories may return `undefined` to opt
 * out (e.g. when a required config file doesn't exist).
 *
 * @example
 * // Directory only — discover all extensions in a folder.
 * const loaded = await loadExtensions('./extensions', config);
 *
 * @example
 * // Mix built-in factories with local directory discovery.
 * import { createLoggerExtension } from 'libra/extras/logger';
 * import { createMcpExtension } from 'libra/extras/mcp';
 *
 * const loaded = await loadExtensions(
 *   [createLoggerExtension, createMcpExtension, './extensions'],
 *   { mcpConfigPaths: './mcpServers.json' },
 * );
 *
 * @example
 * // Ready-made Extension objects alongside directories.
 * const loaded = await loadExtensions(
 *   [myCustomExtension, './more-extensions'],
 *   config,
 * );
 */
export async function loadExtensions(
  inputs: ExtensionInput | ExtensionInput[],
  config?: Record<string, unknown>,
): Promise<LoadedExtension[]> {
  const items = Array.isArray(inputs) ? inputs : [inputs];
  const loaded: LoadedExtension[] = [];
  let total = 0;
  let skipped = 0;

  for (const item of items) {
    if (typeof item === 'string') {
      // Directory path — discover and load all extensions in it.
      const discovered = discoverExtensions(item);
      const enabled = discovered.filter((e) => e.enabled);

      for (const ext of enabled) {
        total++;
        try {
          const result = await loadExtension(ext, config);
          if (result) {
            loaded.push(result);
          } else {
            skipped++;
            console.log(`[extensions] skipped "${ext.name}" (factory opted out)`);
          }
        } catch (err) {
          console.error(
            `[extensions] failed to load "${ext.name}" from ${ext.dir}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } else if (typeof item === 'function') {
      // Factory function — call with config.
      total++;
      try {
        const extension = await (item as ExtensionFactory)(config);
        if (extension) {
          loaded.push(makeLoaded(extension));
        } else {
          skipped++;
          const name = item.name ?? 'anonymous';
          console.log(`[extensions] skipped "${name}" (factory opted out)`);
        }
      } catch (err) {
        const name = item.name ?? 'anonymous';
        console.error(
          `[extensions] failed to load factory "${name}":`,
          err instanceof Error ? err.message : err,
        );
      }
    } else if (item && typeof item.name === 'string' && typeof item.install === 'function') {
      // Ready-made Extension object.
      total++;
      loaded.push(makeLoaded(item as Extension));
    } else {
      console.warn('[extensions] skipping unknown input type:', item);
    }
  }

  // Sort by priority (descending), then name (ascending).
  loaded.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  console.log(
    `[extensions] loaded ${loaded.length}/${total} extension(s)` +
      (skipped > 0 ? ` (${skipped} skipped)` : '') +
      (loaded.length > 0 ? ': ' + loaded.map((e) => e.name).join(', ') : ''),
  );

  return loaded;
}

/**
 * Wrap a ready-made Extension (from a factory or direct object) into a
 * LoadedExtension, reading priority from the Extension itself.
 */
function makeLoaded(extension: Extension): LoadedExtension {
  return {
    name: extension.name,
    enabled: true,
    priority: extension.priority ?? 0,
    dir: '',
    extension,
  };
}

// ── Install / Unload / Close helpers ──────────────────────────────────

/**
 * Install all loaded extensions onto an agent, in priority order.
 *
 * This is the standard companion to {@link loadExtensions} — the loader
 * sorts by priority, this calls `agent.use()` for each in that order.
 *
 * @example
 * const loaded = await loadExtensions('./extensions', config);
 * installExtensions(loaded, agent);
 */
export function installExtensions(loaded: LoadedExtension[], agent: {
  use(e: Extension): unknown;
}): void {
  for (const { extension, name, priority } of loaded) {
    agent.use(extension);
    console.log(`[extensions] installed "${name}" (priority ${priority})`);
  }
}

/**
 * Unload all extensions from an agent, in reverse priority order.
 *
 * Calls `agent.unload(name)` for each extension — removes hooks and tools
 * registered by that extension, and calls `close()` if the extension has
 * one. Useful for hot-reloading or reconfiguring an agent without
 * recreating it.
 *
 * @example
 * await unloadExtensions(loaded, agent);
 */
export async function unloadExtensions(loaded: LoadedExtension[], agent: {
  unload(name: string): Promise<unknown>;
}): Promise<void> {
  // Reverse order — unload last-installed first.
  for (const { name } of [...loaded].reverse()) {
    await agent.unload(name);
    console.log(`[extensions] unloaded "${name}"`);
  }
}

/**
 * Close all extensions that have a `close()` method (e.g. MCP clients).
 *
 * Calls `close()` in reverse priority order (last-loaded closes first).
 * Extensions without `close()` are skipped silently.
 *
 * @example
 * await closeExtensions(loaded);
 */
export async function closeExtensions(loaded: LoadedExtension[]): Promise<void> {
  for (const { extension, name } of [...loaded].reverse()) {
    if (typeof (extension as { close?: unknown }).close === 'function') {
      await (extension as unknown as { close: () => Promise<void> }).close();
      console.log(`[extensions] closed "${name}"`);
    }
  }
}
