const port = Number(process.env.CDP_PORT || 9222);
const expression = process.argv.slice(2).join(' ') || 'window.__PERF_TRIAGE__ || []';
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === 'page');
if (!target) throw new Error(`No WebView page target found on port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

const result = await new Promise((resolve, reject) => {
  const id = 1;
  const timer = setTimeout(() => reject(new Error('DevTools evaluation timed out')), Number(process.env.CDP_TIMEOUT_MS || 90000));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== id) return;
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result?.result);
  });
  socket.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
  }));
});

socket.close();
if (result?.exceptionDetails) {
  throw new Error(result.exceptionDetails.text || 'Evaluation failed');
}
console.log(JSON.stringify(result?.value ?? null, null, 2));
