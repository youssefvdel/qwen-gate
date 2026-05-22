import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { serve } from '@hono/node-server';
import { app } from '../index.ts';
import { initPlaywright, closePlaywright } from '../services/playwright.ts';

const SANDBOX_DIR = '/tmp/kilo/sandbox';

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port);
  });
}

async function getFreePort(startPort: number): Promise<number> {
  let port = startPort;
  while (true) {
    const available = await isPortAvailable(port);
    if (available) return port;
    port++;
  }
}

// Clean and recreate physical sandbox directory
if (fs.existsSync(SANDBOX_DIR)) {
  fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
}
fs.mkdirSync(SANDBOX_DIR, { recursive: true });

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

// Local real file system tool handlers
const localTools = {
  list_files: () => {
    const files = fs.readdirSync(SANDBOX_DIR);
    return JSON.stringify(files);
  },
  create_file: (args: { path: string; content: string }) => {
    const filePath = path.join(SANDBOX_DIR, args.path);
    const basePath = normalizePath(SANDBOX_DIR) + '/';
    if (!normalizePath(filePath).startsWith(basePath)) {
      return JSON.stringify({ error: 'Access denied: Directory traversal detected' });
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, args.content, 'utf8');
    return JSON.stringify({ status: 'success', path: args.path });
  },
  read_file: (args: { path: string }) => {
    const filePath = path.join(SANDBOX_DIR, args.path);
    const basePath = normalizePath(SANDBOX_DIR) + '/';
    if (!normalizePath(filePath).startsWith(basePath)) {
      return JSON.stringify({ error: 'Access denied: Directory traversal detected' });
    }
    if (!fs.existsSync(filePath)) {
      return JSON.stringify({ error: `File ${args.path} not found` });
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.stringify({ content });
  },
  edit_file: (args: { path: string; oldText: string; newText: string }) => {
    const filePath = path.join(SANDBOX_DIR, args.path);
    const basePath = normalizePath(SANDBOX_DIR) + '/';
    if (!normalizePath(filePath).startsWith(basePath)) {
      return JSON.stringify({ error: 'Access denied: Directory traversal detected' });
    }
    if (!fs.existsSync(filePath)) {
      return JSON.stringify({ error: `File ${args.path} not found` });
    }
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes(args.oldText)) {
      return JSON.stringify({ error: `Old text not found in ${args.path}` });
    }
    fs.writeFileSync(filePath, content.replace(args.oldText, args.newText), 'utf8');
    return JSON.stringify({ status: 'success', path: args.path });
  },
  delete_file: (args: { path: string }) => {
    const filePath = path.join(SANDBOX_DIR, args.path);
    const basePath = normalizePath(SANDBOX_DIR) + '/';
    if (!normalizePath(filePath).startsWith(basePath)) {
      return JSON.stringify({ error: 'Access denied: Directory traversal detected' });
    }
    if (!fs.existsSync(filePath)) {
      return JSON.stringify({ error: `File ${args.path} not found` });
    }
    fs.unlinkSync(filePath);
    return JSON.stringify({ status: 'success', path: args.path });
  }
};

// Declares standard tool definitions in OpenAI format
const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all files in the sandbox',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a new file with content',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the content of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file replacing oldText with newText',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' }
        },
        required: ['path', 'oldText', 'newText']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    }
  }
];

test('Agentic Stress Test: >30 messages multi-turn using the REAL live API', async () => {
  const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  const port = await getFreePort(DEFAULT_PORT);
  
  const server = serve({
    fetch: app.fetch,
    port: port
  });
  console.log(`[RealTest] Local Hono server started on port ${port}`);

  // Initialize Playwright with headless mode to fetch real active session headers
  console.log('[RealTest] Initializing Playwright browser context...');
  await initPlaywright(true);

  // Dynamic conversation prompt sequence (explicitly instructing tool calls)
  const conversationScenario = [
    "Please call the 'list_files' tool to check if the sandbox is currently empty.",
    "Great. Create a file named 'a.txt' with content 'Hello A' and a file named 'b.txt' with content 'Hello B' by calling the 'create_file' tool for both.",
    "Please call the 'read_file' tool for 'b.txt' to verify its content.",
    "Now, call the 'edit_file' tool to replace 'Hello A' with 'Hello Awesome World' in 'a.txt'.",
    "Please call the 'read_file' tool for 'a.txt' to check if the change was applied successfully.",
    "Great! Now call the 'list_files' tool to see both of them.",
    "Excellent. Now delete both files by calling the 'delete_file' tool for both.",
    "Please call the 'list_files' tool one last time to make sure they are gone.",
    "Perfect! Thank you so much."
  ];

  const messages: any[] = [
    { role: 'system', content: 'You are an agentic file helper. You have access to tools to manage files in a sandbox directory. You MUST call the requested tools in every response to perform the file operations. Do not guess or assume results without executing the tool first. Wrap your tool calls exactly in <tool_call>...</tool_call> tags.' }
  ];

  try {
    for (const userPrompt of conversationScenario) {
      console.log(`\n👤 [User]: ${userPrompt}`);
      messages.push({ role: 'user', content: userPrompt });

      let agentTurnDone = false;
      let loopLimiter = 0;

      while (!agentTurnDone) {
        loopLimiter++;
        assert.ok(loopLimiter <= 10, 'Agent got stuck in an infinite tool calling loop');

        // Add a 2.5 second delay to let the Qwen backend settle and prevent "The chat is in progress!" errors
        await new Promise(resolve => setTimeout(resolve, 2500));

        console.log(`[RealTest] Sending request to proxy completions endpoint (messages: ${messages.length})...`);

        // Send request to real proxy completions API
        const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen3.6-plus',
            messages: messages,
            tools: toolDefinitions,
            stream: true
          })
        });

        assert.strictEqual(response.status, 200, `Expected 200, got ${response.status}`);

        const reader = response.body?.getReader();
        assert.ok(reader, 'Response should have stream body');

        const decoder = new TextDecoder();
        let content = '';
        let reasoning = '';
        let toolCalls: any[] = [];
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') continue;

            try {
              const chunk = JSON.parse(dataStr);
              if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
                const delta = chunk.choices[0].delta;
                if (delta.content) {
                  content += delta.content;
                }
                if (delta.reasoning_content) {
                  reasoning += delta.reasoning_content;
                }
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCalls[idx]) {
                      toolCalls[idx] = { id: tc.id, name: tc.function?.name || '', arguments: '' };
                    }
                    if (tc.function?.arguments) {
                      toolCalls[idx].arguments += tc.function.arguments;
                    }
                  }
                }
              }
            } catch (err) {
              // ignore partial chunk parsing errors
            }
          }
        }

        // Output and construct assistant message
        const assistantMessage: any = { role: 'assistant' };
        if (content) assistantMessage.content = content;
        if (reasoning) assistantMessage.reasoning_content = reasoning;

        if (reasoning) {
          console.log(`💭 [Thinking]: ${reasoning}`);
        }

        if (toolCalls.length > 0) {
          assistantMessage.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.arguments
            }
          }));

          messages.push(assistantMessage);

          for (const tc of assistantMessage.tool_calls) {
            const toolName = tc.function.name as keyof typeof localTools;
            const toolArgs = JSON.parse(tc.function.arguments || '{}');
            console.log(`🛠️ [Tool Call]: ${toolName} with args:`, toolArgs);

            let result = '';
            if (typeof localTools[toolName] === 'function') {
              try {
                result = localTools[toolName](toolArgs as any);
              } catch (err: any) {
                result = JSON.stringify({ error: `Tool execution failed: ${err.message}` });
              }
            } else {
              result = JSON.stringify({
                error: `Tool '${toolName}' is not available. Please use one of the available tools: list_files, create_file, read_file, edit_file, delete_file.`
              });
            }
            console.log(`🟢 [Tool Result]: ${result}`);

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: toolName,
              content: result
            });
          }
        } else {
          console.log(`🤖 [Agent]: ${content}`);
          messages.push(assistantMessage);
          agentTurnDone = true;
        }
      }
    }

    console.log(`\n[RealTest] Integration Test complete! Total chat history size: ${messages.length} messages.`);
    assert.ok(messages.length > 30, `Expected conversation history to contain >30 messages, got ${messages.length}`);

    // Sandbox must be clean at the end
    const remainingFiles = fs.readdirSync(SANDBOX_DIR);
    assert.strictEqual(remainingFiles.length, 0, 'Sandbox directory must be empty at the end');

  } finally {
    // Teardown browser context and Hono server
    await closePlaywright();
    if (server) {
      server.close();
      console.log('[RealTest] Server stopped and Playwright closed.');
    } else {
      console.log('[RealTest] Playwright closed.');
    }
  }
});
