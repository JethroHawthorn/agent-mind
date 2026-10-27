import { expect, it } from 'vitest';
import { geminiCompleted, geminiToolEvidence } from '../../scripts/gemini-evidence.mjs';

// Synthetic protocol examples only, never authenticated CLI evidence.
function run(output: unknown, patch: Record<string, unknown> = {}) {
  return {
    exit_code: 0,
    failure: null,
    events: [
      { type: 'init', session_id: 'fixture' },
      {
        type: 'tool_use',
        tool_name: 'mcp_agentmind_agentmind_status',
        tool_id: 'fixture-tool',
        parameters: {},
      },
      {
        type: 'tool_result',
        tool_id: 'fixture-tool',
        status: 'success',
        output: JSON.stringify(output),
      },
      { type: 'result', status: 'success' },
    ],
    ...patch,
  };
}
const match = (r: ReturnType<typeof run>) =>
  geminiToolEvidence(
    r,
    'mcp_agentmind_agentmind_status',
    (_i: unknown, objects: Record<string, unknown>[]) =>
      objects.some(
        (x) => x.project_id === 'scope-fixture' && x.source_agent === 'gemini' && x.ok === true,
      ),
  );
it('accepts exact correlated health without an id/content memory shape', () => {
  expect(
    match(
      run({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, project_id: 'scope-fixture', source_agent: 'gemini' }),
          },
        ],
      }),
    ),
  ).toBe(true);
});
it.each([
  { exit_code: 1 },
  { failure: 'timeout' },
  { events: [] },
  {
    events: [
      { type: 'result', status: 'success' },
      { type: 'result', status: 'error' },
    ],
  },
])('rejects incomplete or unsuccessful process evidence %j', (patch) => {
  expect(match(run({ ok: true, project_id: 'scope-fixture', source_agent: 'gemini' }, patch))).toBe(
    false,
  );
});
it('rejects forged scope, MCP errors, prose and uncorrelated output', () => {
  expect(match(run({ ok: true, project_id: 'foreign', source_agent: 'gemini' }))).toBe(false);
  expect(
    match(
      run({
        isError: true,
        content: [
          {
            text: JSON.stringify({ ok: true, project_id: 'scope-fixture', source_agent: 'gemini' }),
          },
        ],
      }),
    ),
  ).toBe(false);
  const r = run(
    {},
    {
      events: [
        { type: 'message', role: 'assistant', content: 'the tool succeeded' },
        { type: 'result', status: 'success' },
      ],
    },
  );
  expect(match(r)).toBe(false);
  expect(geminiCompleted({})).toBe(false);
});
