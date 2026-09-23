import { createSession, reduce } from './dialogue.js';

// One request per process. stdin/stdout are private backend IPC, not an HTTP API.
// Never log input, catalogue credentials, messages, or stack traces to stdout.
const MAX_BYTES = 2 * 1024 * 1024;
let size = 0;
const chunks = [];
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Input too large');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object' || !input.event || !['user', 'server'].includes(input.event.type)) throw new Error('Invalid input');
  const state = input.state ?? createSession(input.event.locale ?? 'kk');
  const output = reduce(state, input.event);
  process.stdout.write(JSON.stringify(output));
} catch {
  process.stdout.write(JSON.stringify({ error: 'dialogue_error' }));
  process.exitCode = 1;
}
