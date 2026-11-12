import { describe, expect, test } from 'bun:test';

const FIXTURE = new URL('./fixtures/shutdownRun.ts', import.meta.url).pathname;

/** Starts the fixture run, waits for its bid, sends `signal` and returns everything it printed. */
const signalledRun = async (signal: NodeJS.Signals, environment: Record<string, string> = {}) => {
  const child = Bun.spawn(['bun', FIXTURE], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...environment },
  });
  const decoder = new TextDecoder();
  let output = '';
  let signalled = false;
  for await (const chunk of child.stdout) {
    output += decoder.decode(chunk);
    if (!signalled && output.includes('bidding')) {
      signalled = true;
      child.kill(signal);
    }
  }
  const errors = await new Response(child.stderr).text();
  return { output, errors, exitCode: await child.exited };
};

describe('cancelAllOnShutdown', () => {
  test.each(['SIGTERM', 'SIGINT'] as const)(
    'withdraws every bid and exits cleanly on %s',
    async (signal) => {
      const { output, exitCode } = await signalledRun(signal);

      expect(output).toContain('cancelled 100');
      expect(exitCode).toBe(0);
    },
  );

  test('exits non-zero and points at cancel-all when withdrawing fails', async () => {
    const { errors, exitCode } = await signalledRun('SIGTERM', { FAIL_CANCEL: '1' });

    expect(errors).toContain('run cancel-all to retry');
    expect(exitCode).toBe(1);
  });
});
