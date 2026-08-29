import type { Model, ModelRequest, ModelResponse } from '../../model.js';
import { hasFileContent } from '../../types.js';

export interface ModelRoute {
  when(request: ModelRequest): boolean | Promise<boolean>;
  model: Model;
}

export interface RoutingModelConfig {
  default: Model;
  routes: readonly ModelRoute[];
}

export class RoutingModel implements Model {
  constructor(private readonly config: RoutingModelConfig) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    for (const route of this.config.routes) {
      if (await route.when(request)) return route.model.generate(request);
    }
    return this.config.default.generate(request);
  }
}

export function createRoutingModel(config: RoutingModelConfig): Model {
  return new RoutingModel(config);
}

export function hasFileInput(request: ModelRequest): boolean {
  return request.messages.some((message) => hasFileContent(message.content));
}

export function hasImageInput(request: ModelRequest): boolean {
  return request.messages.some((message) => hasFileContent(message.content, 'image/'));
}
