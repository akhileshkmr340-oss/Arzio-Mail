// Calls an async module synchronously from the main thread. The work runs in a
// worker thread; the caller blocks on Atomics.wait until the answer arrives.
// Used to give PostgreSQL and S3 the same synchronous interface as SQLite and
// the local disk, so the rest of the code does not change.
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

export function createBridge(moduleUrl, init, { timeoutMs = 60000 } = {}) {
  const { port1, port2 } = new MessageChannel();
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('./bridge-worker.js', import.meta.url), {
    workerData: { moduleUrl: String(moduleUrl), init, port: port2, flag },
    transferList: [port2],
  });
  worker.unref();
  port1.unref();
  let seq = 0;
  let dead = null;
  worker.on('error', (e) => { dead = e; });
  worker.on('exit', (code) => { dead = dead || new Error(`Bridge worker exited (${code})`); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); });

  function call(method, ...args) {
    if (dead) throw dead;
    const id = ++seq;
    Atomics.store(flag, 0, 0);
    port1.postMessage({ id, method, args });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const msg = receiveMessageOnPort(port1);
      if (msg) {
        const m = msg.message;
        if (m.id !== id) continue;
        if (m.error) throw Object.assign(new Error(m.error.message), m.error);
        return m.result;
      }
      if (dead) throw dead;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Timed out waiting for ${method}`);
      Atomics.wait(flag, 0, 0, Math.min(left, 1000));
      Atomics.store(flag, 0, 0);
    }
  }
  return { call, close: () => worker.terminate() };
}
