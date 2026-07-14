import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createJsonStore } from '../src/json-store.js';
import { createTokenVault } from '../src/token-vault.js';

async function fixture(encryptionKey = randomBytes(32).toString('base64')) {
  const dir = await mkdtemp(join(tmpdir(), 'kefu-token-vault-'));
  const path = join(dir, 'tokens.json');
  const store = createJsonStore({ path, defaultValue: { users: {} } });
  return { path, store, vault: createTokenVault({ store, encryptionKey }) };
}

const token = {
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  expiresAt: 1_784_000_000_000,
  refreshExpiresAt: 1_785_000_000_000,
  scope: 'search:message im:message:get_as_user offline_access',
};

test('encrypts tokens at rest and decrypts them with the correct key', async () => {
  const { path, store, vault } = await fixture();

  await vault.put('ou_owner', token);
  await vault.put('ou_other', token);

  const disk = await readFile(path, 'utf8');
  assert.doesNotMatch(disk, /access-secret|refresh-secret/);
  assert.deepEqual(await vault.get('ou_owner'), token);
  const record = JSON.parse(disk).users.ou_owner;
  assert.deepEqual(Object.keys(record).sort(), ['ciphertext', 'expiresAt', 'iv', 'tag']);
  assert.equal(Buffer.from(record.iv, 'base64').length, 12);
  assert.notEqual(record.iv, (await store.read()).users.ou_other.iv);
});

test('binds ciphertext to the user open_id and rejects tampering', async () => {
  const { store, vault } = await fixture();
  await vault.put('ou_owner', token);

  await store.update((state) => {
    const record = state.users.ou_owner;
    const ciphertext = Buffer.from(record.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    return {
      ...state,
      users: {
        ...state.users,
        ou_other: record,
        ou_owner: { ...record, ciphertext: ciphertext.toString('base64') },
      },
    };
  });

  await assert.rejects(vault.get('ou_owner'), /authenticat|unable to authenticate/i);
  await assert.rejects(vault.get('ou_other'), /authenticat|unable to authenticate/i);
});

test('deletes a user token and returns undefined for missing users', async () => {
  const { vault } = await fixture();
  await vault.put('ou_owner', token);

  await vault.delete('ou_owner');

  assert.equal(await vault.get('ou_owner'), undefined);
});

test('rejects encryption keys that are not exactly 32 bytes of canonical base64', () => {
  const store = { read() {}, update() {} };
  for (const encryptionKey of [
    randomBytes(31).toString('base64'),
    randomBytes(33).toString('base64'),
    'not-base64',
  ]) {
    assert.throws(
      () => createTokenVault({ store, encryptionKey }),
      /32-byte base64/i,
    );
  }
});
