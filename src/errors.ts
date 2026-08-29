/** Base error class for all libra errors. */
export class LibraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraError';
  }
}

/** The model call failed. */
export class ModelError extends LibraError {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/** A tool execution failed. */
export class ToolError extends LibraError {
  constructor(
    message: string,
    public readonly toolName: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** A hook threw and the failure policy aborted the turn. */
export class HookError extends LibraError {
  constructor(
    message: string,
    public readonly hookName: string,
    public readonly extensionName: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HookError';
  }
}

/** The turn was halted (via AbortSignal or agent.halt()). */
export class HaltedError extends LibraError {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'HaltedError';
  }
}

/** The turn exceeded the maximum number of LLM iterations. */
export class MaxIterationsError extends LibraError {
  constructor(
    message: string,
    public readonly iterations: number,
  ) {
    super(message);
    this.name = 'MaxIterationsError';
  }
}
