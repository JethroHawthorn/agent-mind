#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  brokerRequest,
  confirmOperatorReview,
  dailySafe,
  loadBrokerClient,
  operatorQueryOperations,
  reviewText,
} from '@agentmind/core';

const display = (value: unknown) => reviewText(dailySafe(value), false);
async function main() {
  const { values } = parseArgs({
    options: {
      'client-config': { type: 'string' },
      project: { type: 'string' },
      request: { type: 'string' },
      read: { type: 'string' },
      'advisory-review': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values['client-config'] || !values.project || !values.request)
    throw new Error('config/project/request required');
  if (values.read && values['advisory-review']) throw new Error('Choose one operator operation.');
  if (values.read) {
    if (
      ![
        ...operatorQueryOperations,
        'broker_health',
        'distribution_plan',
        'distribution_verify',
      ].some((op) => op === values.read)
    ) {
      console.error('[agentmind] BROKER_READ_OPERATION_DENIED');
      process.exitCode = 1;
      return;
    }
  }

  const fd = openSync(
    values.request,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 131072) throw new Error('request file');
    const bytes = Buffer.alloc(131073);
    let n = 0;
    while (n < bytes.length) {
      const count = readSync(fd, bytes, n, bytes.length - n, null);
      if (!count) break;
      n += count;
    }
    if (n > 131072) throw new Error('request limit');
    text = bytes.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
  const c = loadBrokerClient(values['client-config']);
  const input: unknown = JSON.parse(text);
  if (values.read) {
    console.log(
      display(
        await brokerRequest(c, 'operator', {
          schema_version: 1,
          project: values.project,
          op: values.read,
          input,
        }),
      ),
    );
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY)
    throw new Error('interactive operator required');
  if (values['advisory-review']) {
    const id =
      input && typeof input === 'object' && 'proposal_id' in input ? input.proposal_id : null;
    const current = await brokerRequest(c, 'operator', {
      schema_version: 1,
      project: values.project,
      op: 'review_get',
      input: { proposal_id: id },
    });
    await confirmOperatorReview({ advisory_only: true, decision: input, current });
    console.log(
      display(
        await brokerRequest(c, 'operator', {
          schema_version: 1,
          project: values.project,
          op: 'review_decide',
          input,
        }),
      ),
    );
    return;
  }
  const review = (await brokerRequest(c, 'operator', {
    schema_version: 1,
    project: values.project,
    op: 'operator_prepare',
    input,
  })) as { challenge_id: string; digest: string };
  // Independent local TTY review; the broker separately authenticates this process UID.
  await confirmOperatorReview(review);
  console.log(
    display(
      await brokerRequest(c, 'operator', {
        schema_version: 1,
        project: values.project,
        op: 'operator_commit',
        input: { challenge_id: review.challenge_id, review_digest: review.digest },
      }),
    ),
  );
}
main().catch(() => {
  console.error('[agentmind] BROKER_OPERATOR_DENIED');
  process.exitCode = 1;
});
