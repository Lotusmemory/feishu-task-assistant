import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJsonStore } from '../src/json-store.js';
import {
  createOAuthServer,
  createSafeOAuthCodeExchanger,
} from '../src/oauth-server.js';

async function fixture({ exchangeError } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'kefu-oauth-'));
  const stateStore = createJsonStore({
    path: join(dir, 'state.json'),
    defaultValue: { oauthStates: {} },
  });
  const exchanges = [];
  const writes = [];
  const codeExchanger = {
    appId: 'cli_test',
    async exchange(params) {
      exchanges.push(params);
      if (exchangeError) throw exchangeError;
      return {
        accessToken: 'access-value',
        refreshToken: 'refresh-value',
        expiresIn: 3_600,
        refreshTokenExpiresIn: 2_592_000,
        scope: 'search:message im:message:get_as_user offline_access',
      };
    },
  };
  const vault = {
    async put(openId, token) {
      writes.push({ openId, token });
    },
  };
  const redirectUri = 'https://example.com/oauth/callback';
  const oauth = createOAuthServer({
    codeExchanger,
    vault,
    redirectUri,
    port: 0,
    stateStore,
  });
  const address = await oauth.start();
  return {
    oauth,
    stateStore,
    exchanges,
    writes,
    redirectUri,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test('safe exchanger suppresses sensitive SDK transport failure output', async () => {
  const secrets = {
    code: 'sensitive-code-value',
    appSecret: 'sensitive-app-secret',
    redirectUri: 'https://example.com/oauth/callback?sensitive-query-marker',
  };
  const consoleOutput = [];
  const loggerOutput = [];
  let requestCount = 0;
  const logger = Object.fromEntries(
    ['error', 'warn', 'info', 'debug', 'trace'].map((method) => [
      method,
      (...args) => loggerOutput.push([method, args]),
    ]),
  );
  const originalConsole = {};
  for (const method of ['error', 'warn', 'info', 'debug', 'trace', 'log']) {
    originalConsole[method] = console[method];
    console[method] = (...args) => consoleOutput.push(args);
  }

  let thrown;
  try {
    const exchanger = createSafeOAuthCodeExchanger({
      appId: 'cli_test',
      appSecret: secrets.appSecret,
      domain: 'https://open.feishu.cn',
      logger,
      httpInstance: {
        async request(config) {
          requestCount += 1;
          const error = new Error('simulated transport failure');
          error.config = config;
          throw error;
        },
      },
    });
    await exchanger.exchange({
      code: secrets.code,
      redirectUri: secrets.redirectUri,
    });
  } catch (error) {
    thrown = error;
  } finally {
    for (const [method, original] of Object.entries(originalConsole)) {
      console[method] = original;
    }
  }

  assert.ok(thrown);
  assert.equal(requestCount, 1);
  assert.deepEqual(consoleOutput, []);
  assert.deepEqual(loggerOutput, []);
  const visibleOutput = JSON.stringify({
    consoleOutput,
    loggerOutput,
    thrown: {
      name: thrown.name,
      message: thrown.message,
      stack: thrown.stack,
      ...thrown,
    },
  });
  assert.equal(visibleOutput.includes(secrets.code), false);
  assert.equal(visibleOutput.includes(secrets.appSecret), false);
  assert.equal(visibleOutput.includes(secrets.redirectUri), false);
  assert.equal(visibleOutput.includes('sensitive-query-marker'), false);
});

async function withFixture(run) {
  const value = await fixture();
  try {
    await run(value);
  } finally {
    await value.oauth.stop();
  }
}

test('creates a 10-minute state and redirects start to the official minimal-scope authorization URL', async () => {
  await withFixture(async ({ oauth, stateStore, baseUrl, redirectUri }) => {
    const startUrl = new URL(await oauth.authorizationUrl('ou_owner'));
    const state = startUrl.searchParams.get('state');
    const stored = (await stateStore.read()).oauthStates[state];
    assert.equal(startUrl.origin, 'https://example.com');
    assert.equal(startUrl.pathname, '/oauth/start');
    assert.equal(stored.openId, 'ou_owner');
    assert.ok(Date.now() - stored.createdAt < 1_000);

    const response = await fetch(`${baseUrl}/oauth/start?state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });
    const target = new URL(response.headers.get('location'));
    assert.equal(response.status, 302);
    assert.equal(target.origin, 'https://accounts.feishu.cn');
    assert.equal(target.pathname, '/open-apis/authen/v1/authorize');
    assert.equal(target.searchParams.get('client_id'), 'cli_test');
    assert.equal(target.searchParams.get('response_type'), 'code');
    assert.equal(target.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(target.searchParams.get('state'), state);
    assert.deepEqual(
      target.searchParams.get('scope').split(' ').sort(),
      ['im:message:get_as_user', 'offline_access', 'search:message'],
    );
  });
});

test('rejects state after 10 minutes without redirecting', async () => {
  await withFixture(async ({ oauth, stateStore, baseUrl }) => {
    const startUrl = new URL(await oauth.authorizationUrl('ou_owner'));
    const state = startUrl.searchParams.get('state');
    await stateStore.update((data) => ({
      ...data,
      oauthStates: {
        ...data.oauthStates,
        [state]: { ...data.oauthStates[state], createdAt: Date.now() - 600_001 },
      },
    }));

    const response = await fetch(`${baseUrl}/oauth/start?state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });

    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
    assert.match(await response.text(), /授权失败/);
  });
});

test('consumes callback state once, exchanges the code, and stores tokens under the initiating open_id', async () => {
  await withFixture(async ({ oauth, baseUrl, redirectUri, exchanges, writes }) => {
    const startUrl = new URL(await oauth.authorizationUrl('ou_owner'));
    const state = startUrl.searchParams.get('state');
    const before = Date.now();
    const callback = `${baseUrl}/oauth/callback?code=fake-code&state=${encodeURIComponent(state)}`;

    const first = await fetch(callback);
    const second = await fetch(callback);

    assert.equal(first.status, 200);
    assert.match(await first.text(), /授权成功/);
    assert.equal(second.status, 400);
    assert.match(await second.text(), /授权失败/);
    assert.deepEqual(exchanges, [{ code: 'fake-code', redirectUri }]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].openId, 'ou_owner');
    assert.equal(writes[0].token.accessToken, 'access-value');
    assert.equal(writes[0].token.refreshToken, 'refresh-value');
    assert.equal(writes[0].token.scope, 'search:message im:message:get_as_user offline_access');
    assert.ok(writes[0].token.expiresAt >= before + 3_600_000);
    assert.ok(writes[0].token.refreshExpiresAt >= before + 2_592_000_000);
  });
});

test('does not exchange a code for invalid state and returns 404 for every other route', async () => {
  await withFixture(async ({ baseUrl, exchanges, writes }) => {
    const invalid = await fetch(`${baseUrl}/oauth/callback?code=fake-code&state=invalid`);
    const other = await fetch(`${baseUrl}/health`);
    const wrongMethod = await fetch(`${baseUrl}/oauth/start`, { method: 'POST' });

    assert.equal(invalid.status, 400);
    assert.equal(other.status, 404);
    assert.equal(wrongMethod.status, 404);
    assert.deepEqual(exchanges, []);
    assert.deepEqual(writes, []);
  });
});

test('returns fixed Chinese text when code exchange fails', async () => {
  const sensitiveError = new Error('sensitive provider detail');
  const value = await fixture({ exchangeError: sensitiveError });
  try {
    const startUrl = new URL(await value.oauth.authorizationUrl('ou_owner'));
    const state = startUrl.searchParams.get('state');
    const response = await fetch(
      `${value.baseUrl}/oauth/callback?code=fake-code&state=${encodeURIComponent(state)}`,
    );
    const body = await response.text();

    assert.equal(response.status, 500);
    assert.equal(body, '授权失败，请重新发起授权。');
    assert.equal(body.includes(sensitiveError.message), false);
    assert.deepEqual(value.writes, []);
  } finally {
    await value.oauth.stop();
  }
});
