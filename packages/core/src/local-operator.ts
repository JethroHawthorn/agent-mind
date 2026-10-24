import { userInfo } from 'node:os';
import { AgentMindError } from './errors.js';

/** Local attribution for future privileged CLIs, not proof of authorization or a signature. */
export function localOperatorIdentity(): string {
  try {
    const user = userInfo();
    if (!user.username || /[\r\n\0]/.test(user.username)) throw new Error('invalid OS identity');
    return user.uid >= 0
      ? `uid:${user.uid}:${user.username.slice(0, 64)}`
      : `os:${process.platform}:${user.username.slice(0, 64)}`;
  } catch {
    throw new AgentMindError(
      'OPERATOR_UNAVAILABLE',
      'Cannot derive the local operator from the operating system.',
    );
  }
}
