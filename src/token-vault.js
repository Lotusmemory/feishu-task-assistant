import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const TOKEN_FIELDS = [
  'accessToken',
  'refreshToken',
  'expiresAt',
  'refreshExpiresAt',
  'scope',
];

function decodeKey(encryptionKey) {
  const key = Buffer.from(encryptionKey || '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== encryptionKey) {
    throw new Error('encryptionKey must be exactly 32-byte base64');
  }
  return key;
}

function tokenPayload(token) {
  return Object.fromEntries(
    TOKEN_FIELDS
      .filter((field) => token[field] !== undefined)
      .map((field) => [field, token[field]]),
  );
}

export function createTokenVault({ store, encryptionKey }) {
  const key = decodeKey(encryptionKey);

  async function put(openId, token) {
    const payload = tokenPayload(token);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(openId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    const record = {
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      expiresAt: payload.expiresAt,
    };

    await store.update((state) => ({
      ...state,
      users: { ...(state.users || {}), [openId]: record },
    }));
  }

  async function get(openId) {
    const record = (await store.read()).users?.[openId];
    if (!record) return undefined;

    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(record.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(openId));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  }

  async function deleteToken(openId) {
    await store.update((state) => {
      const users = { ...(state.users || {}) };
      delete users[openId];
      return { ...state, users };
    });
  }

  return { put, get, delete: deleteToken };
}
