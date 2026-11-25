import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STARTUP_MS = 100_000;
const STOP_MS = 5_000;

function start(script, args, stdout = 'inherit') {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT, stdio: ['ignore', stdout, 'inherit'], detached: process.platform !== 'win32',
  });
  let spawnError, stopping;
  const closed = new Promise((resolve) => {
    child.on('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
  });
  return {
    child, closed,
    stop() {
      return stopping ??= (async () => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return closed;
        child.kill('SIGTERM');
        const timeout = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
        try { return await closed; }
        finally { clearTimeout(timeout); }
      })();
    },
  };
}

function describe({ code, signal, error }) {
  return error?.message ?? (signal ? `signal ${signal}` : `exit ${code}`);
}

async function runGate(script, args, signal) {
  signal.throwIfAborted();
  const gate = start(script, args);
  const stop = () => { void gate.stop(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const result = await gate.closed;
    signal.throwIfAborted();
    if (result.code === 0 && !result.error) return true;
    console.error(`${script} failed: ${describe(result)}`);
    return false;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

async function waitForReady(stdout, signal) {
  const lines = createInterface({ input: stdout, crlfDelay: Infinity });
  let onAbort;
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      lines.on('line', (line) => {
        if (!line.startsWith('READY ')) return;
        const url = URL.parse(line.slice('READY '.length).trim());
        if (!url || url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.href !== `${url.origin}/`) {
          reject(new Error(`Invalid local Worker READY line: ${line}`));
        } else resolve(url.origin);
      });
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
    lines.close();
    stdout.resume(); // Keep forwarding harness stdout after reading the READY line.
  }
}

export async function runLocalGate(script, { signal, workerArgs = [] }) {
  signal.throwIfAborted();
  const worker = start('scripts/local-worker.mjs', workerArgs, 'pipe');
  worker.child.stdout.pipe(process.stdout, { end: false });
  const lost = new AbortController();
  let stopping = false;
  void worker.closed.then((result) => {
    if (!stopping) lost.abort(new Error(`Local Worker exited unexpectedly: ${describe(result)}`));
  });
  const active = AbortSignal.any([signal, lost.signal]);
  const startup = AbortSignal.timeout(STARTUP_MS);
  try {
    let base;
    try { base = await waitForReady(worker.child.stdout, AbortSignal.any([active, startup])); }
    catch (error) {
      if (error === startup.reason) throw new Error(`Local Worker did not emit READY within ${STARTUP_MS / 1000}s`);
      throw error;
    }
    return await runGate(script, ['--base-url', base], active);
  } finally {
    stopping = true;
    await worker.stop();
  }
}

export async function runCli(name, main) {
  const stop = new AbortController();
  const interrupt = () => stop.abort('SIGINT');
  const terminate = () => stop.abort('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    process.exitCode = await main(stop.signal) ? 0 : 1;
  } catch (error) {
    if (!stop.signal.aborted) console.error(`${name}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (stop.signal.aborted) process.exitCode = stop.signal.reason === 'SIGINT' ? 130 : 143;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runCli('check', async (signal) => {
    const site = await runGate('scripts/check-site.mjs', [], signal);
    const worker = await runLocalGate('scripts/check-worker.mjs', { signal });
    return site && worker;
  });
}
