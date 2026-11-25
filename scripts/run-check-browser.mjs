import { runCli, runLocalGate } from './run-check.mjs';

await runCli('check:browser:local', (signal) => runLocalGate('scripts/verify-browser.mjs', {
  signal,
  workerArgs: ['--seed-live'],
}));
