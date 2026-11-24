import { workerData } from 'node:worker_threads';

const { moduleUrl, init, port, flag } = workerData;
const mod = await import(moduleUrl);
let handlers;
let initError = null;
try { handlers = await mod.init(init); } catch (e) { initError = e; }

port.on('message', async ({ id, method, args }) => {
  let out;
  try {
    if (initError) throw initError;
    const fn = handlers[method];
    if (!fn) throw new Error(`Unknown method ${method}`);
    out = { id, result: await fn(...args) };
  } catch (e) {
    out = { id, error: { message: e.message, code: e.code, detail: e.detail, status: e.status } };
  }
  port.postMessage(out);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
