# OpenAI-compatible multi-agent provider

This example exposes independent Libra agents through an OpenAI-compatible HTTP API. Frameworks and SDKs that support a custom OpenAI base URL can use each agent as a model:

- `libra-provider/agent-1`
- `libra-provider/agent-2`

The server itself is a library export — `createOpenAICompatibleServer` from `libra/extras/openai-provider`. This example just wires up agents, model resolution, and environment configuration. You can use the same export in your own application without copying this example:

```typescript
import { Agent } from 'libra-harness';
import { createOpenAICompatibleServer } from 'libra-harness/extras/openai-provider';

const server = createOpenAICompatibleServer({
  agents: {
    'my-agent': new Agent({ model, systemPrompt: 'You are helpful.' }),
  },
  apiKeys: ['your-provider-key'],
});
server.listen(8787, '127.0.0.1');
```

The provider implements:

- `GET /v1/models`
- `POST /v1/chat/completions`
- Bearer authentication and `x-api-key` authentication
- Multiple comma-separated provider API keys
- Text and image message history, including `system`, `developer`, `user`, `assistant`, and correlated `tool` messages
- OpenAI `image_url` content parts (URLs and base64 data URLs) converted to Libra multimodal file content
- JSON and SSE chat-completion responses

Libra agents execute their own configured tools internally. Client-defined tools (passed in the request) are treated as **external tools** — the agent returns their tool calls to the caller for execution, then resumes the turn when the caller sends back the results. This enables the standard OpenAI tool-calling round-trip.

## Setup

```bash
cp .env.example .env
```

Set `DEEPSEEK_API_KEY` to the upstream model credential. Set `LIBRA_PROVIDER_API_KEYS` to one or more credentials that clients must use when calling this provider. Generate a provider key with:

```bash
openssl rand -hex 32
```

Provider keys and the upstream model key serve different purposes and should not be reused.

Install and run from the repository root:

```bash
pnpm install
pnpm --dir examples/openai-compatible-provider start
```

The default base URL is `http://127.0.0.1:8787/v1`. Give clients one value from `LIBRA_PROVIDER_API_KEYS`; the snippets below refer to that selected value as `LIBRA_PROVIDER_API_KEY`:

```bash
export LIBRA_PROVIDER_API_KEY=replace-with-a-long-random-key
```

## OpenAI SDK

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.LIBRA_PROVIDER_API_KEY,
  baseURL: 'http://127.0.0.1:8787/v1',
});

const response = await client.chat.completions.create({
  model: 'libra-provider/agent-1',
  messages: [{ role: 'user', content: 'Summarize the benefits of composable agents.' }],
});

console.log(response.choices[0].message.content);
```

The `openai` package is only needed by the consuming application; the provider itself uses Node's built-in HTTP server.

## cURL

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $LIBRA_PROVIDER_API_KEY"

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LIBRA_PROVIDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "libra-provider/agent-2",
    "messages": [{"role": "user", "content": "Draft a short project update."}]
  }'
```

Set `stream: true` to receive OpenAI-compatible server-sent events. The agent completes its internal model/tool loop before this adapter emits the final response chunks.

## Images

User messages accept OpenAI `image_url` content parts. Both remote URLs and base64 data URLs are supported. The provider converts them to Libra multimodal file content and forwards them to the upstream model.

### Remote URL (cURL)

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LIBRA_PROVIDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "libra-provider/agent-1",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What is in this image?"},
        {"type": "image_url", "image_url": {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/640px-PNG_transparency_demonstration_1.png"}}
      ]
    }]
  }'
```

### Local file (cURL)

The OpenAI API does not accept file paths. Base64-encode the local file and send it as a data URL:

```bash
IMAGE_DATA=$(base64 -i ./photo.png | tr -d '\n')

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LIBRA_PROVIDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"libra-provider/agent-1\",
    \"messages\": [{
      \"role\": \"user\",
      \"content\": [
        {\"type\": \"text\", \"text\": \"Describe this image.\"},
        {\"type\": \"image_url\", \"image_url\": {\"url\": \"data:image/png;base64,$IMAGE_DATA\"}}
      ]
    }]
  }"
```

For JPEGs, swap the media type in the data URL: `data:image/jpeg;base64,...`.

### Local file (helper script)

Save as `imgcurl` and `chmod +x imgcurl`:

```bash
#!/bin/bash
# usage: imgcurl <image-file> <prompt>
file="$1"; prompt="$2"; key="$LIBRA_PROVIDER_API_KEY"
ext="${file##*.}"; ext=$(echo "$ext" | tr '[:upper:]' '[:lower:]')
data=$(base64 -i "$file" | tr -d '\n')
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $key" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg d "data:image/$ext;base64,$data" --arg p "$prompt" '{
    model: "libra-provider/agent-1",
    messages: [{role: "user", content: [
      {type: "text", text: $p},
      {type: "image_url", image_url: {url: $d}}
    ]}]
  }')"
```

Then:

```bash
./imgcurl ./screenshot.png "Describe this UI."
```

### OpenAI SDK (TypeScript)

```ts
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';

const client = new OpenAI({
  apiKey: process.env.LIBRA_PROVIDER_API_KEY,
  baseURL: 'http://127.0.0.1:8787/v1',
});

const imageData = readFileSync('./photo.png').toString('base64');

const response = await client.chat.completions.create({
  model: 'libra-provider/agent-1',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } },
    ],
  }],
});

console.log(response.choices[0].message.content);
```

### Vision routing

Image content is forwarded to whatever upstream model `MODEL` resolves to. If the default model does not support vision, set `VISION_MODEL` to a vision-capable provider/model and the routing model will send image-bearing requests there:

```bash
# .env
MODEL=deepseek/deepseek-v4-flash
VISION_MODEL=openai/gpt-4.1-mini
OPENAI_API_KEY=your-openai-api-key-here
```

## Client-defined tools (external tool calling)

The provider supports the standard OpenAI tool-calling round-trip. When a request includes `tools`, they are merged with the agent's own internal tools. The model sees both sets.

- **Agent tools** (configured on the Libra agent) are executed internally in the agent's continuation loop — the caller never sees them.
- **Client tools** (passed in the request) are **external** — when the model calls one, the agent breaks its loop and returns the tool call in the response with `finish_reason: "tool_calls"`. The caller executes the tool and sends the result back as a `tool` message in a follow-up request.

### Example round-trip (cURL)

```bash
# 1. Send a request with a client tool
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LIBRA_PROVIDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "libra-provider/agent-1",
    "messages": [{"role": "user", "content": "What is the weather in SF?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'

# Response: finish_reason="tool_calls", message.tool_calls=[{id:"call-...", function:{name:"get_weather", arguments:"{\"city\":\"SF\"}"}}]

# 2. Execute the tool and send the result back
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LIBRA_PROVIDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "libra-provider/agent-1",
    "messages": [
      {"role": "user", "content": "What is the weather in SF?"},
      {"role": "assistant", "content": "", "tool_calls": [{"id":"call-...","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"SF\"}"}}]},
      {"role": "tool", "tool_call_id": "call-...", "content": "Sunny, 72F"}
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
      }
    }]
  }'

# Response: finish_reason="stop", message.content="The weather in SF is sunny and 72°F."
```

### OpenAI SDK (TypeScript)

```ts
const response = await client.chat.completions.create({
  model: 'libra-provider/agent-1',
  messages: [{ role: 'user', content: 'What is the weather in SF?' }],
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }],
});

if (response.choices[0].finish_reason === 'tool_calls') {
  const toolCall = response.choices[0].message.tool_calls[0];
  const args = JSON.parse(toolCall.function.arguments);
  const result = await getWeather(args.city); // your code

  // Send the result back
  const finalResponse = await client.chat.completions.create({
    model: 'libra-provider/agent-1',
    messages: [
      { role: 'user', content: 'What is the weather in SF?' },
      response.choices[0].message,
      { role: 'tool', tool_call_id: toolCall.id, content: result },
    ],
    tools: response.tools,
  });

  console.log(finalResponse.choices[0].message.content);
}
```

The agent's own configured tools run internally and are invisible to the caller. Only client-defined tools produce `tool_calls` in the response.

## Adding agents

Add another independent `Agent` instance to the `agents` record in `index.ts`. The record key becomes the OpenAI model ID returned by `/v1/models` and accepted by `/v1/chat/completions`.
