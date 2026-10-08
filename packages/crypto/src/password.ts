import { hash, verify } from '@node-rs/argon2';

// argon2id, OWASP-recommended parameters (m=19 MiB, t=2, p=1).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * `pepper` is a secret key kept outside the database (ASVS 2.4.5, ADR 0029): with it, a copy of
 * the users table alone isn't enough to guess passwords offline. A hash made with a pepper only
 * verifies with the same pepper.
 */
export function hashPassword(password: string, pepper?: Buffer): Promise<string> {
  return hash(password, pepper ? { ...OPTIONS, secret: pepper } : OPTIONS);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
  pepper?: Buffer,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password, pepper ? { secret: pepper } : undefined);
  } catch {
    return false;
  }
}

/**
 * A real hash of a random value, verified against when the user does not exist so that
 * login timing does not reveal which emails are registered.
 */
let dummyHash: Promise<string> | undefined;
export function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalization');
  return dummyHash;
}
