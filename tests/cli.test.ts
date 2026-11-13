import { describe, expect, test } from 'bun:test';

const CLI = new URL('../src/cli/index.ts', import.meta.url).pathname;

describe.each(['approve', 'approve-opensea', 'wrap'])('%s', (command) => {
  test.each([
    { amount: '0', positionals: ['0'] },
    { amount: 'lots', positionals: ['lots'] },
    { amount: '-1', positionals: ['--', '-1'] },
  ])('rejects $amount before reading the key or sending anything', async ({ positionals }) => {
    const environment = { ...process.env };
    delete environment.MARKET_MAKER_PRIVATE_KEY;
    delete environment.MARKET_MAKER_PRIVATE_KEY_FILE;
    const child = Bun.spawn(['bun', CLI, command, ...positionals], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: environment,
    });

    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain('positive ETH amount');
  });
});
