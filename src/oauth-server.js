import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';

const STATE_TTL_MS = 10 * 60 * 1_000;
const USER_SCOPES = [
  'search:message',
  'im:message:get_as_user',
  'offline_access',
];

const NOOP_LOGGER = Object.freeze({
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
});

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function isCurrent(record) {
  return record
    && typeof record.openId === 'string'
    && Number.isFinite(record.createdAt)
    && Date.now() - record.createdAt < STATE_TTL_MS;
}

export function createSafeOAuthCodeExchanger({ appId, appSecret, domain, httpInstance }) {
  const dedicatedClient = new Client({
    appId,
    appSecret,
    domain,
    httpInstance,
    logger: NOOP_LOGGER,
    loggerLevel: LoggerLevel.fatal,
  });

  return {
    appId,
    exchange({ code, redirectUri }) {
      return dedicatedClient.accessToken.retrieveByAuthorizationCode({ code, redirectUri });
    },
  };
}

export function createOAuthServer({ codeExchanger, vault, redirectUri, port, stateStore }) {
  function feishuAuthorizationUrl(state) {
    const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    url.searchParams.set('client_id', codeExchanger.appId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', USER_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async function authorizationUrl(openId) {
    const state = randomBytes(32).toString('base64url');
    await stateStore.update((data) => ({
      ...data,
      oauthStates: {
        ...(data.oauthStates || {}),
        [state]: { openId, createdAt: Date.now() },
      },
    }));
    const url = new URL(redirectUri);
    url.pathname = '/oauth/start';
    url.search = '';
    url.hash = '';
    url.searchParams.set('state', state);
    return url.toString();
  }

  async function readState(state) {
    const record = (await stateStore.read()).oauthStates?.[state];
    return isCurrent(record) ? record : undefined;
  }

  async function consumeState(state) {
    let consumed;
    await stateStore.update((data) => {
      const oauthStates = { ...(data.oauthStates || {}) };
      const record = oauthStates[state];
      delete oauthStates[state];
      if (isCurrent(record)) consumed = record;
      return { ...data, oauthStates };
    });
    return consumed;
  }

  async function handleStart(requestUrl, response) {
    const state = requestUrl.searchParams.get('state');
    if (!state || !(await readState(state))) {
      sendText(response, 400, '授权失败：请求已失效，请重新发起授权。');
      return;
    }
    response.writeHead(302, { location: feishuAuthorizationUrl(state) });
    response.end();
  }

  async function handleCallback(requestUrl, response) {
    const state = requestUrl.searchParams.get('state');
    const record = state ? await consumeState(state) : undefined;
    const code = requestUrl.searchParams.get('code');
    if (!record || !code) {
      sendText(response, 400, '授权失败：请求已失效，请重新发起授权。');
      return;
    }

    try {
      const token = await codeExchanger.exchange({
        code,
        redirectUri,
      });
      const now = Date.now();
      await vault.put(record.openId, {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresIn === undefined ? undefined : now + token.expiresIn * 1_000,
        refreshExpiresAt: token.refreshTokenExpiresIn === undefined
          ? undefined
          : now + token.refreshTokenExpiresIn * 1_000,
        scope: token.scope,
      });
      sendText(response, 200, '授权成功，可以关闭此页面。');
    } catch {
      sendText(response, 500, '授权失败，请重新发起授权。');
    }
  }

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && requestUrl.pathname === '/oauth/start') {
      await handleStart(requestUrl, response);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/oauth/callback') {
      await handleCallback(requestUrl, response);
      return;
    }
    sendText(response, 404, '未找到');
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    });
  }

  function stop() {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return { start, stop, authorizationUrl };
}
