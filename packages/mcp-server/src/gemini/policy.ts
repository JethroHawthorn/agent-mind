import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgentMindError } from '@agentmind/core';
import { readBounded } from '../codex/files.js';
import { settingsDocument } from './configuration.js';
export type SettingsLayer = { label: string; path: string; root?: string };
export function readSettings(layer: SettingsLayer) {
  if (!existsSync(layer.path)) {
    // A dangling symlink is a conflict, never an absent policy.
    try {
      if (lstatSync(layer.path).isSymbolicLink())
        throw new AgentMindError('GEMINI_SETTINGS_UNSAFE', 'Settings cannot be symlinks.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return null;
  }
  return readBounded(layer.root ?? realpathSync(dirname(layer.path)), layer.path);
}
/** Conservative restrictions across layers. Never weaken an admin/user exclusion.
 * This is not a complete emulator of native env/extension/policy resolution.
 */
export function inspectPolicy(layers: SettingsLayer[], ownedPath: string, ownedEntry?: unknown) {
  const blockers: string[] = [],
    collisions: string[] = [],
    inventory: { layer: string; present: boolean; agentmind: boolean }[] = [];
  for (const layer of layers) {
    const text = readSettings(layer),
      d = settingsDocument(text);
    inventory.push({
      layer: layer.label,
      present: text !== null,
      agentmind: Object.hasOwn(d.mcpServers, 'agentmind'),
    });
    const object = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
    for (const value of [d.mcp, d.admin, d.skills])
      if (value !== undefined && !object(value))
        throw new AgentMindError('GEMINI_POLICY_INVALID', 'Malformed settings policy object.');
    const m = d.mcp as
      | { allowed?: unknown; excluded?: unknown; serverCommand?: unknown }
      | undefined;
    for (const [key, value] of [
      ['allowed', m?.allowed],
      ['excluded', m?.excluded],
    ] as const) {
      if (
        value !== undefined &&
        (!Array.isArray(value) || value.some((x) => typeof x !== 'string'))
      )
        throw new AgentMindError('GEMINI_POLICY_INVALID', 'Malformed MCP allow/exclude policy.');
      if (
        Array.isArray(value) &&
        (key === 'allowed' ? !value.includes('agentmind') : value.includes('agentmind'))
      )
        blockers.push(`${layer.label}:MCP_${key.toUpperCase()}`);
    }
    if (m?.serverCommand !== undefined) blockers.push(`${layer.label}:GLOBAL_SERVER_COMMAND`);
    const admin = d.admin as
      | {
          mcp?: { enabled?: unknown; config?: unknown; requiredConfig?: unknown };
          skills?: { enabled?: unknown };
        }
      | undefined;
    for (const v of [admin?.mcp, admin?.skills])
      if (v !== undefined && !object(v))
        throw new AgentMindError('GEMINI_POLICY_INVALID', 'Malformed admin policy.');
    const skills = d.skills as { enabled?: unknown; disabled?: unknown } | undefined;
    for (const value of [admin?.mcp?.enabled, admin?.skills?.enabled, skills?.enabled])
      if (value !== undefined && typeof value !== 'boolean')
        throw new AgentMindError('GEMINI_POLICY_INVALID', 'Malformed enable policy.');
    if (
      skills?.disabled !== undefined &&
      (!Array.isArray(skills.disabled) || skills.disabled.some((x) => typeof x !== 'string'))
    )
      throw new AgentMindError('GEMINI_POLICY_INVALID', 'Malformed skill exclusions.');
    if (admin?.mcp?.enabled === false) blockers.push(`${layer.label}:ADMIN_MCP_DISABLED`);
    if (
      admin?.skills?.enabled === false ||
      skills?.enabled === false ||
      (Array.isArray(skills?.disabled) && skills.disabled.includes('agentmind-router'))
    )
      blockers.push(`${layer.label}:SKILLS_DISABLED`);
    const allowed = admin?.mcp?.config;
    if (allowed !== undefined) {
      if (!allowed || typeof allowed !== 'object' || Array.isArray(allowed))
        throw new AgentMindError('GEMINI_POLICY_INVALID', 'Malformed admin MCP policy.');
      if (Object.keys(allowed).length && !Object.hasOwn(allowed, 'agentmind'))
        blockers.push(`${layer.label}:ADMIN_MCP_ALLOWLIST`);
      if (Object.hasOwn(allowed, 'agentmind')) collisions.push(`${layer.label}:ADMIN_AGENTMIND`);
    }
    if (
      admin?.mcp?.requiredConfig &&
      Object.hasOwn(admin.mcp.requiredConfig as object, 'agentmind')
    )
      collisions.push(`${layer.label}:REQUIRED_AGENTMIND`);
    if (
      Object.hasOwn(d.mcpServers, 'agentmind') &&
      !(
        layer.path === ownedPath &&
        ownedEntry !== undefined &&
        JSON.stringify(d.mcpServers.agentmind) === JSON.stringify(ownedEntry)
      )
    )
      collisions.push(`${layer.label}:AGENTMIND_COLLISION`);
    if (Object.keys(d.mcpServers).some((n) => /^agentmind[_-]/i.test(n)))
      collisions.push(`${layer.label}:LEGACY_AGENTMIND_ALIAS`);
  }
  return {
    blockers,
    collisions,
    layers: inventory,
    effective_native_configuration: 'NOT VERIFIED',
    resolution: 'CONSERVATIVE_LAYER_GUARDS; env/extensions/native policy remain authoritative',
  };
}
