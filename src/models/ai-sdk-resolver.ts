import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createProviderRegistry } from 'ai';
import { AISdkModel } from '../ai-sdk-model.js';
import type { Model } from '../model.js';

export type AISdkProviderFactory = (modelId: string) => LanguageModelV4;

export interface AISdkProviderDefinition {
  envVar: string;
  load(): Promise<AISdkProviderFactory>;
}

export interface ResolveModelOptions {
  env?: Readonly<Record<string, string | undefined>>;
  providers?: Readonly<Record<string, AISdkProviderDefinition>>;
}

export const nativeAISdkProviders: Readonly<Record<string, AISdkProviderDefinition>> = {
  openai: {
    envVar: 'OPENAI_API_KEY',
    async load() {
      const { openai } = await import('@ai-sdk/openai');
      return openai;
    },
  },
  anthropic: {
    envVar: 'ANTHROPIC_API_KEY',
    async load() {
      const { anthropic } = await import('@ai-sdk/anthropic');
      return anthropic;
    },
  },
  google: {
    envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
    async load() {
      const { google } = await import('@ai-sdk/google');
      return google;
    },
  },
  deepseek: {
    envVar: 'DEEPSEEK_API_KEY',
    async load() {
      const { deepseek } = await import('@ai-sdk/deepseek');
      return deepseek;
    },
  },
};

/**
 * Resolve a libra `Model` from a `provider/model` string using Vercel AI SDK's
 * `createProviderRegistry`. Providers are lazy-loaded on first use.
 *
 * Model IDs use the existing `provider/model` format (e.g. `openai/gpt-4o`,
 * `google/gemini-2.5-pro`) — the registry is configured with `separator: '/'`
 * so no changes to existing IDs are required.
 */
export async function resolveModel(modelId: string, options: ResolveModelOptions = {}): Promise<Model> {
  const separator = modelId.indexOf('/');
  if (separator <= 0 || separator === modelId.length - 1) {
    throw new Error(`Invalid model ID "${modelId}". Expected "provider/model".`);
  }

  const providerId = modelId.slice(0, separator);
  const definitions = options.providers ?? nativeAISdkProviders;
  const definition = definitions[providerId];
  if (!definition) {
    throw new Error(`Unsupported provider "${providerId}". Supported providers: ${Object.keys(definitions).sort().join(', ')}.`);
  }

  const env = options.env ?? process.env;
  if (!env[definition.envVar]?.trim()) {
    throw new Error(`Cannot resolve "${modelId}": ${definition.envVar} is not configured.`);
  }

  // Lazy-load the provider and wrap it in a single-entry registry so we get
  // Vercel's provider resolution logic (middleware support, error messages, etc.)
  const providerFactory = await definition.load();
  const registry = createProviderRegistry(
    { [providerId]: { languageModel: (id: string) => providerFactory(id) } as any },
    { separator: '/' },
  );

  return new AISdkModel(registry.languageModel(modelId as `${string}/${string}`));
}

export function configuredProviders(
  env: Readonly<Record<string, string | undefined>> = process.env,
  providers: Readonly<Record<string, AISdkProviderDefinition>> = nativeAISdkProviders,
): string[] {
  return Object.entries(providers)
    .filter(([, definition]) => Boolean(env[definition.envVar]?.trim()))
    .map(([providerId]) => providerId)
    .sort();
}
