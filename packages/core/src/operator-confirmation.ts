import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { isatty } from 'node:tty';
import { AgentMindError } from './errors.js';
import { localOperatorIdentity } from './local-operator.js';

export type OperatorGrant = Readonly<{ session: string }>;
type Authorization = { digest: string; operator: string; session: string; issued: number };
const grants = new WeakMap<object, Authorization>();
export function reviewDigest(preview: unknown): string {
  return createHash('sha256').update(JSON.stringify(preview)).digest('hex');
}

/** Local workflow friction only. Same-UID PTY automation is explicitly not prevented. */
export async function confirmOperatorReview(preview: unknown): Promise<OperatorGrant> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    !process.stderr.isTTY ||
    !isatty(0) ||
    !isatty(1) ||
    !isatty(2)
  ) {
    throw new AgentMindError(
      'INTERACTIVE_OPERATOR_REQUIRED',
      'Privileged actions require an interactive terminal. No noninteractive bypass exists.',
    );
  }
  let terminal: ReturnType<typeof createInterface> | undefined;
  try {
    const devices = [0, 1, 2].map((fd) => fstatSync(fd));
    if (devices.some((device) => !device.isCharacterDevice() || device.rdev !== devices[0]?.rdev))
      throw new Error('terminal mismatch');
    const digest = reviewDigest(preview);
    const challenge = `CONFIRM ${digest} ${randomBytes(16).toString('hex')}`;
    // JSON escaping prevents terminal control-sequence injection from stored content.
    const display = `\nUNTRUSTED REVIEW DATA (JSON-escaped):\n${operatorReviewText(preview)}\nEND REVIEW DATA\nLocal confirmation is NOT secure against same-user PTY automation or SQLite access.\nStatic PASS is not task verification. Read the exact artifact and diff above.\nTo authorize only this action and artifact, type this exact line:\n${challenge}\n`;
    await new Promise<void>((resolve, reject) =>
      process.stderr.write(display, (error) => (error ? reject(error) : resolve())),
    );
    terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    const line = await terminal.question('> ', { signal: AbortSignal.timeout(300000) });
    if (line !== challenge)
      throw new AgentMindError(
        'OPERATOR_CONFIRMATION_DENIED',
        'Confirmation did not match the exact artifact/action.',
      );
    const grant = Object.freeze({ session: randomUUID() });
    grants.set(grant, {
      digest,
      operator: localOperatorIdentity(),
      session: grant.session,
      issued: Date.now(),
    });
    return grant;
  } catch (error) {
    if (error instanceof AgentMindError) throw error;
    throw new AgentMindError(
      'OPERATOR_TERMINAL_UNAVAILABLE',
      'Terminal unavailable, closed or confirmation expired; privileged operation denied.',
    );
  } finally {
    terminal?.close();
    process.stdin.pause();
  }
}

/** Runtime capability check, independent of CLI parsing; no caller-supplied approver fields. */
export function consumeOperatorGrant(grant: unknown, digest: string) {
  const authorization = grant && typeof grant === 'object' ? grants.get(grant) : undefined;
  if (!authorization)
    throw new AgentMindError(
      'OPERATOR_AUTHORIZATION_REQUIRED',
      'A fresh artifact-bound local terminal confirmation is required.',
    );
  grants.delete(grant as object);
  if (
    authorization.digest !== digest ||
    Date.now() - authorization.issued > 300000 ||
    Date.now() < authorization.issued
  )
    throw new AgentMindError(
      'STALE_OPERATOR_REVIEW',
      'Confirmed state changed or confirmation expired. Inspect and confirm again.',
    );
  if (authorization.operator !== localOperatorIdentity())
    throw new AgentMindError('OPERATOR_AUTHORIZATION_REQUIRED', 'Local operator identity changed.');
  return authorization;
}

/** Round-trippable JSON, with invisible terminal controls escaped as UTF-16. */
export function operatorReviewText(preview: unknown): string {
  return JSON.stringify(preview, null, 2).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character === '\n'
      ? character
      : character
          .split('')
          .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
          .join(''),
  );
}
