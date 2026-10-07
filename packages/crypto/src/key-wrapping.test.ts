import { DecryptCommand, EncryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { describe, expect, it } from 'vitest';
import { AwsKmsKeyWrapper, LocalKeyWrapper } from './key-wrapping';

describe('LocalKeyWrapper (the stand-in)', () => {
  const wrapper = new LocalKeyWrapper(Buffer.alloc(32, 1).toString('base64'));

  it('wraps and unwraps a data key for its version only', async () => {
    const { plaintext, wrapped } = await wrapper.generateDataKey(4);
    expect(plaintext).toHaveLength(32);
    expect(wrapped).not.toContain(plaintext.toString('base64'));
    expect(await wrapper.unwrap(wrapped, 4)).toEqual(plaintext);
    await expect(wrapper.unwrap(wrapped, 5)).rejects.toThrow();
    const other = new LocalKeyWrapper(Buffer.alloc(32, 2).toString('base64'));
    await expect(other.unwrap(wrapped, 4)).rejects.toThrow();
  });

  it('refuses a wrapping key of the wrong size', () => {
    expect(() => new LocalKeyWrapper(Buffer.alloc(16).toString('base64'))).toThrow('32 bytes');
  });
});

describe('AwsKmsKeyWrapper', () => {
  // A fake KMS client: records each command and answers like KMS would.
  const fake = () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd instanceof GenerateDataKeyCommand)
          return { Plaintext: new Uint8Array(32).fill(3), CiphertextBlob: new Uint8Array([9, 9]) };
        if (cmd instanceof EncryptCommand) return { CiphertextBlob: new Uint8Array([8, 8]) };
        if (cmd instanceof DecryptCommand) return { Plaintext: new Uint8Array(32).fill(3) };
        throw new Error('unexpected command');
      },
    };
    return { sent, client: client as never };
  };
  const keyId = 'arn:aws:kms:us-east-1:111122223333:alias/acct-field-keys';
  const context = { app: 'acct', purpose: 'field-key', version: '2' };

  it('asks KMS for an AES-256 data key bound to its version', async () => {
    const { sent, client } = fake();
    const w = new AwsKmsKeyWrapper(keyId, client);
    const key = await w.generateDataKey(2);
    expect(key.plaintext).toEqual(Buffer.alloc(32, 3));
    expect(key.wrapped).toBe(Buffer.from([9, 9]).toString('base64'));
    expect(sent).toEqual([
      {
        name: 'GenerateDataKeyCommand',
        input: { KeyId: keyId, KeySpec: 'AES_256', EncryptionContext: context },
      },
    ]);
  });

  it('unwraps with the same key and context, and wraps an imported key', async () => {
    const { sent, client } = fake();
    const w = new AwsKmsKeyWrapper(keyId, client);
    expect(await w.unwrap(Buffer.from([9, 9]).toString('base64'), 2)).toEqual(Buffer.alloc(32, 3));
    expect(await w.wrap(Buffer.alloc(32, 7), 2)).toBe(Buffer.from([8, 8]).toString('base64'));
    expect(sent[0]).toMatchObject({
      name: 'DecryptCommand',
      input: { KeyId: keyId, EncryptionContext: context },
    });
    expect(sent[1]).toMatchObject({
      name: 'EncryptCommand',
      input: { KeyId: keyId, EncryptionContext: context },
    });
  });

  it('refuses an answer that is not a 256-bit key', async () => {
    const w = new AwsKmsKeyWrapper(keyId, {
      send: async () => ({ Plaintext: new Uint8Array(16) }),
    } as never);
    await expect(w.unwrap('AA==', 1)).rejects.toThrow('no data key');
  });
});
