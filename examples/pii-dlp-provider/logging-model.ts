import type { Model, ModelRequest, ModelResponse, ToolCall } from 'libra';

/**
 * A model that logs exactly what it receives and simulates a tool call
 * on the first turn, then responds with a summary on the second.
 *
 * This proves:
 * 1. The model never sees real PII (only placeholders)
 * 2. The model's output contains placeholders (which get restored)
 * 3. Tool calls work through the redaction layer
 */
export class LoggingMockModel implements Model {
  readonly receivedRequests: ModelRequest[] = [];
  private callCount = 0;

  constructor(private readonly log: (label: string, text: string) => void) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.callCount++;
    // Deep-copy the request so we capture exactly what the model saw.
    const snapshot: ModelRequest = {
      ...request,
      messages: request.messages.map((m) => ({ ...m })),
      tools: request.tools?.map((t) => ({ ...t })),
    };
    this.receivedRequests.push(snapshot);

    // Log the full conversation the model sees.
    this.log(`MODEL INPUT (call ${this.callCount})`, JSON.stringify(snapshot.messages, null, 2));

    if (this.callCount === 1) {
      // First call: simulate a tool call to look up the customer.
      // Extract the query from the last user message.
      const lastMessage = request.messages.at(-1);
      const userText = typeof lastMessage?.content === 'string' ? lastMessage.content : '';

      // The model sees placeholders, so it calls the tool with a placeholder.
      // Extract the most relevant query token — look for placeholder patterns
      // first, then fall back to keyword extraction.
      const placeholderMatch = userText.match(/\[(?:PERSON|EMAIL|ACCOUNT|PHONE|SSN)_\d+\]/);
      let query: string;
      if (placeholderMatch) {
        // Use the placeholder — the beforeTool hook will restore it to the real value.
        query = placeholderMatch[0];
      } else {
        const queryMatch = userText.match(/(?:about|lookup|find|check|status of)\s+(.+?)(?:[''\?\.!]|$)/i);
        query = queryMatch ? queryMatch[1].trim() : userText;
      }

      const toolCalls: ToolCall[] = [
        { id: `call-${this.callCount}`, name: 'lookup_customer', arguments: JSON.stringify({ query }) },
      ];

      this.log(`MODEL OUTPUT (call ${this.callCount})`, JSON.stringify({ toolCalls }));

      return {
        message: { role: 'assistant', content: '', toolCalls },
        finishReason: 'tool_calls',
      };
    }

    // Second call: the tool result is in the messages. Summarize it.
    // The model sees the redacted tool result, so its response uses placeholders.
    const toolMessage = [...request.messages].reverse().find((m) => m.role === 'tool');
    const toolContent = typeof toolMessage?.content === 'string' ? toolMessage.content : '';

    // Construct a response that references the placeholders from the tool result.
    // This proves the model's output contains placeholders that will be restored.
    const responseText = this.summarizeToolResult(toolContent);

    this.log(`MODEL OUTPUT (call ${this.callCount})`, responseText);

    return {
      message: { role: 'assistant', content: responseText },
      finishReason: 'stop',
    };
  }

  private summarizeToolResult(toolContent: string): string {
    // The tool result is already redacted (placeholders). We just echo
    // back a summary using those same placeholders.
    if (toolContent.startsWith('No customer found')) {
      return 'I could not find that customer in our records.';
    }

    // Extract the redacted fields from the tool result.
    // The format is: "Customer found: Name: [PERSON_001], Email: [EMAIL_001], ..."
    const fields = toolContent.replace('Customer found: ', '').split(', ');
    const fieldMap: Record<string, string> = {};
    for (const field of fields) {
      const [key, ...valueParts] = field.split(': ');
      fieldMap[key.trim()] = valueParts.join(': ');
    }

    const name = fieldMap['Name'] ?? 'the customer';
    const email = fieldMap['Email'] ?? 'N/A';
    const balance = fieldMap['Balance'] ?? 'N/A';
    const account = fieldMap['Account'] ?? 'N/A';

    return `I found the customer. ${name} (email: ${email}, account: ${account}) has a balance of ${balance}.`;
  }
}
