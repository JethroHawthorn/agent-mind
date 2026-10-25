#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  brokerRequest,
  confirmOperatorReview,
  loadBrokerClient,
  operatorQueryOperations,
} from '@agentmind/core';

async function main() {
  const { values } = parseArgs({
    options: {
      'client-config': { type: 'string' },
      project: { type: 'string' },
      request: { type: 'string' },
      read: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values['client-config'] || !values.project || !values.request)
    throw new Error('config/project/request required');
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

  if (statSync(values.request).size > 131072) throw new Error('request too large');
  const c = loadBrokerClient(values['client-config']);
  const input: unknown = JSON.parse(readFileSync(values.request, 'utf8'));
  if (values.read) {
    console.log(
      JSON.stringify(
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
  const review = (await brokerRequest(c, 'operator', {
    schema_version: 1,
    project: values.project,
    op: 'operator_prepare',
    input,
  })) as { challenge_id: string; digest: string };
  // Independent local TTY review; the broker separately authenticates this process UID.
  await confirmOperatorReview(review);
  console.log(
    JSON.stringify(
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
