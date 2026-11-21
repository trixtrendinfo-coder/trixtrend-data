import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

function keyBytes(key) {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error('STATE_KEY must be a 256-bit hex key');
  }
  return Buffer.from(key, 'hex');
}

export function encryptState(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from('trixtrend-readonly-state-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, algorithm: 'AES-256-GCM', iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptState(envelope, key) {
  if (envelope?.version !== 1 || envelope?.algorithm !== 'AES-256-GCM') throw new Error('Invalid encrypted state');
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from('trixtrend-readonly-state-v1'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const clear = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    return JSON.parse(clear.toString('utf8'));
  } catch {
    throw new Error('Encrypted token state could not be verified');
  }
}
