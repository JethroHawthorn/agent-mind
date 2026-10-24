import { expect, it } from 'vitest';
import { retrievedByClaude, savedByCodex } from '../../scripts/cli-evidence.mjs';

const memory = {
  id: 'saved-id',
  project_id: 'project',
  content: 'unique-marker SQLite',
  source_agent: 'codex',
};
const result = { content: [{ type: 'text', text: JSON.stringify({ memory }) }] };
const saveEvent = {
  type: 'item.completed',
  item: {
    type: 'mcp_tool_call',
    server: 'agentmind',
    tool: 'memory_save',
    status: 'completed',
    result,
  },
};
const searchEvents = [
  {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'mcp__agentmind__memory_search', id: 'search-1' }],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'search-1',
          content: JSON.stringify({ memories: [memory] }),
        },
      ],
    },
  },
];
it('requires completed Codex MCP results rather than final prose', () => {
  expect(savedByCodex([saveEvent], 'unique-marker')).toEqual(memory);
  expect(() =>
    savedByCodex([{ type: 'agent_message', text: JSON.stringify(memory) }], 'unique-marker'),
  ).toThrow();
  expect(() =>
    savedByCodex(
      [{ ...saveEvent, item: { ...saveEvent.item, status: 'failed' } }],
      'unique-marker',
    ),
  ).toThrow();
});
it('requires a correlated successful Claude tool result with matching content and ID', () => {
  expect(() => retrievedByClaude(searchEvents, memory)).not.toThrow();
  expect(() => retrievedByClaude(searchEvents.slice(1), memory)).toThrow();
  expect(() =>
    retrievedByClaude(
      [
        searchEvents[0],
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                is_error: true,
                tool_use_id: 'search-1',
                content: JSON.stringify({ memories: [memory] }),
              },
            ],
          },
        },
      ],
      memory,
    ),
  ).toThrow();
  expect(() => retrievedByClaude(searchEvents, { ...memory, id: 'different-id' })).toThrow();
  expect(() =>
    retrievedByClaude(
      [{ message: { content: [{ type: 'text', text: JSON.stringify(memory) }] } }],
      memory,
    ),
  ).toThrow();
});
