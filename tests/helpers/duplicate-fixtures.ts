/** Small labeled deterministic fixtures, not a production accuracy sample. */
export const retry =
  '# Goal\nRecover SQLite startup connections after transient busy errors.\n# When to use\nSQLite startup reports a transient database lock.\n# Inputs\nAccept database path and bounded retry counter.\n# Procedure\nInspect the connection error and retry with bounded exponential backoff.\n# Verification\nAssert retry exhaustion and successful connection recovery.';
export const unrelated =
  '# Goal\nRender accessible product thumbnail galleries with responsive images.\n# Inputs\nAccept image URLs and alternative captions.\n# Procedure\nCalculate thumbnail aspect ratios and generate semantic gallery markup.\n# Verification\nCheck keyboard navigation and image captions.';
export const labeledPairs = [
  { name: 'identity', left: retry, right: retry, expected: 'EXACT_DUPLICATE' },
  { name: 'different titles', left: retry, right: retry, rename: true, expected: 'NEAR_DUPLICATE' },
  { name: 'same title different tasks', left: retry, right: unrelated, expected: 'NOT_RELATED' },
  {
    name: 'resource difference',
    left: retry,
    right: retry,
    resources: true,
    expected: 'POSSIBLE_OVERLAP',
  },
  {
    name: 'mandatory conflict',
    left: `${retry}\nMust enable write ahead logging.`,
    right: `${retry}\nNever enable write ahead logging.`,
    expected: 'POSSIBLE_CONFLICT',
  },
  {
    name: 'nonconflicting mandates',
    left: `${retry}\nMust enable write ahead logging.`,
    right: `${retry}\nAlways enable write ahead logging.`,
    expected: 'NEAR_DUPLICATE',
  },
  {
    name: 'empty template',
    left: '# Goal\nFollow best practices.\n# Procedure\nVerify changes.',
    right: '# Goal\nUse existing code.\n# Procedure\nCheck the results.',
    expected: 'INSUFFICIENT_EVIDENCE',
  },
  {
    name: 'shared workflow',
    left: retry,
    right: retry.replace(
      'Inspect the connection error and retry with bounded exponential backoff.',
      'Record connection error categories and inspect operator recovery documentation.',
    ),
    expected: 'POSSIBLE_OVERLAP',
  },
];
export function files(body: string, name = 'fixture-skill', resource = '') {
  return [
    {
      path: 'SKILL.md',
      content: `---\nname: ${name}\ndescription: Harmless bounded fixture\n---\n${body}\n`,
    },
    ...(resource ? [{ path: 'references/notes.md', content: resource }] : []),
  ];
}
