import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AgentMindError } from '@agentmind/core';
import { readBounded } from '../codex/files.js';
import { PROVIDERS } from './model.js';
/** Same registry selection for installer and daily CLI; no provider detection or writes. */
export function integrationRegistry(root: string, explicit?: string, home = homedir()) {
  const remembered = new Set<string>();
  for (const id of PROVIDERS) {
    const text = readBounded(root, join(root, `.agentmind/${id}/installation.json`), 1048576);
    if (text) {
      try {
        const value = JSON.parse(text).database;
        if (typeof value === 'string') remembered.add(value);
      } catch {
        throw new AgentMindError(
          'INSTALLER_RECEIPT_CONFLICT',
          'Malformed integration state; no guessing of registry location.',
        );
      }
    }
  }
  if (!explicit && remembered.size > 1)
    throw new AgentMindError(
      'INSTALLER_REGISTRY_CONFLICT',
      'Integration receipts disagree about registry location; inspect before repair.',
    );
  const database = explicit ?? [...remembered][0] ?? join(home, '.agentmind/agentmind.db');
  if (!isAbsolute(database))
    throw new AgentMindError('INSTALLER_PATH_INVALID', 'Registry path must be absolute.');
  return database;
}
