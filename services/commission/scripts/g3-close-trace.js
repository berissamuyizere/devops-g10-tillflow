#!/usr/bin/env node
/**
 * G3 evidence: trigger commission daily close and capture trace_id from logs.
 *
 *   export AWS_PROFILE=g10 AWS_REGION=eu-central-1
 *   aws sso login --profile g10
 *   node scripts/g3-close-trace.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SQSClient, SendMessageCommand, ListQueuesCommand } = require('@aws-sdk/client-sqs');

const PREFIX = process.env.NAME_PREFIX || 'devops-g10';
const REGION = process.env.AWS_REGION || 'eu-central-1';
const QUEUE_NAME = `${PREFIX}-commission-close`;
const LOG_GROUP = `/${PREFIX}/commission`;
const WAIT_MS = Number(process.env.WAIT_MS || 120_000);
const BUSINESS_DAY = process.env.BUSINESS_DAY || '';

function awsJson(args) {
  const out = execFileSync('aws', [...args, '--output', 'json', '--region', REGION], {
    encoding: 'utf8',
    env: { ...process.env, AWS_REGION: REGION },
  });
  return JSON.parse(out);
}

async function resolveQueueUrl(sqs) {
  if (process.env.SQS_QUEUE_URL) {
    return process.env.SQS_QUEUE_URL;
  }
  const out = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: QUEUE_NAME }));
  const url = (out.QueueUrls || []).find((u) => u.includes(QUEUE_NAME));
  if (!url) {
    throw new Error(`queue ${QUEUE_NAME} not found`);
  }
  return url;
}

function findTraceId(sinceMs) {
  const out = awsJson([
    'logs',
    'filter-log-events',
    '--log-group-name',
    LOG_GROUP,
    '--start-time',
    String(sinceMs),
    '--filter-pattern',
    'trace_id',
  ]);
  for (const event of out.events || []) {
    try {
      const row = JSON.parse(event.message);
      if (row.trace_id && String(row.msg || '').includes('close')) {
        return {
          trace_id: row.trace_id,
          span_id: row.span_id,
          timestamp: row.time || new Date(event.timestamp).toISOString(),
        };
      }
    } catch {
      const match = String(event.message).match(/"trace_id":"([0-9a-f]+)"/i);
      if (match) {
        return { trace_id: match[1], timestamp: new Date(event.timestamp).toISOString() };
      }
    }
  }
  return null;
}

function toXrayTraceId(traceId) {
  if (!traceId || traceId.length !== 32) return null;
  return `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`;
}

async function main() {
  const startedAt = Date.now();
  const sqs = new SQSClient({ region: REGION });
  const queueUrl = await resolveQueueUrl(sqs);

  const payload = {
    type: 'commission.daily-close',
    scheduled_at: new Date().toISOString(),
  };
  if (BUSINESS_DAY) payload.business_day = BUSINESS_DAY;

  const sent = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
    })
  );

  const deadline = startedAt + WAIT_MS;
  let trace = null;
  while (Date.now() < deadline) {
    trace = findTraceId(startedAt - 5000);
    if (trace) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const evidence = {
    captured_at: new Date().toISOString(),
    queue_url: queueUrl,
    message_id: sent.MessageId,
    payload,
    trace_id: trace?.trace_id || null,
    span_id: trace?.span_id || null,
    xray_trace_id: trace?.trace_id ? toXrayTraceId(trace.trace_id) : null,
    traceparent: trace?.trace_id
      ? `00-${trace.trace_id}-${trace?.span_id || '0000000000000000'}-01`
      : null,
    passed: Boolean(trace?.trace_id),
    hint: trace
      ? 'AWS Console → X-Ray → Traces → paste xray_trace_id'
      : 'No trace_id yet — confirm commission task is running and re-run',
  };

  const outPath = path.join(
    __dirname,
    '../../../evidence/product-pos/g3-commission-close-trace.json'
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err.message || err) }));
  process.exitCode = 1;
});
