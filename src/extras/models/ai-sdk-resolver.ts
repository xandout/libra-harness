import type { LanguageModelV4 } from '@ai-sdk/provider';
import { AISdkModel } from '../../ai-sdk-model.js';
import type { Model } from '../../model.js';

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

export async function resolveModel(modelId: string, options: ResolveModelOptions = {}): Promise<Model> {
  const separator = modelId.indexOf('/');
  if (separator <= 0 || separator === modelId.length - 1) {
    throw new Error(`Invalid model ID "${modelId}". Expected "provider/model".`);
  }

  const providerId = modelId.slice(0, separator);
  const providerModelId = modelId.slice(separator + 1);
  const providers = options.providers ?? nativeAISdkProviders;
  const definition = providers[providerId];
  if (!definition) {
    throw new Error(`Unsupported provider "${providerId}". Supported providers: ${Object.keys(providers).sort().join(', ')}.`);
  }

  const env = options.env ?? process.env;
  if (!env[definition.envVar]?.trim()) {
    throw new Error(`Cannot resolve "${modelId}": ${definition.envVar} is not configured.`);
  }

  const provider = await definition.load();
  return new AISdkModel(provider(providerModelId));
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
