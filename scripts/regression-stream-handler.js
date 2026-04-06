const { StreamHandler } = require('../lib/streamHandler');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeSseResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

async function run() {
  const handler = new StreamHandler();
  const response = makeSseResponse([
    'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n'
  ]);

  await handler.handleStream(response);
  const result = handler.getResult();

  assert(result.completed === false, 'expected incomplete stream result');
  assert(result.status === 'incomplete_stream', `expected incomplete_stream status, got ${result.status}`);
  assert(result.content.includes('partial answer'), 'expected partial content to be preserved');
  assert(result.warning && result.warning.includes('completion signal'), 'expected missing completion warning');

  console.log('stream handler regression passed');
  console.log(JSON.stringify(result, null, 2));
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
