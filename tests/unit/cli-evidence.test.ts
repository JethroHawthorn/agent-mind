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

it('validates native experience handoff using tool events and candidate/unverified labels', () => {
  const experience = {
    id: 'experience-id',
    project_id: 'project',
    problem: 'unique-marker SQLite startup',
    solution: 'Retry journal mode changes',
    source_agent: 'codex',
    approval_status: 'candidate',
    verification_status: 'unverified',
  };
  const event = {
    ...saveEvent,
    item: {
      ...saveEvent.item,
      tool: 'experience_record',
      result: {
        content: [{ type: 'text', text: JSON.stringify({ experience }) }],
      },
    },
  };
  expect(savedByCodex([event], 'unique-marker', true)).toEqual(experience);
  const searches = [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'mcp__agentmind__experience_search', id: 'experience-search' },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'experience-search',
            content: JSON.stringify({ experiences: [experience] }),
          },
        ],
      },
    },
  ];
  expect(() => retrievedByClaude(searches, experience, true)).not.toThrow();
  expect(() => retrievedByClaude(searches, { ...experience, solution: 'changed' }, true)).toThrow();
  const forged = {
    ...event,
    item: {
      ...event.item,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              experience: { ...experience, verification_status: 'verified' },
            }),
          },
        ],
      },
    },
  };
  expect(() => savedByCodex([forged], 'unique-marker', true)).toThrow();
  expect(() => savedByCodex([event], 'unique-marker')).toThrow();
});
