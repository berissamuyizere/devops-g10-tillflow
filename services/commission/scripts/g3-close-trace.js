#!/usr/bin/env node
/**
 * G3 evidence: trigger commission daily close and export X-Ray trace.
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
      if (row.trace_id && /close/i.test(String(row.msg || ''))) {
        return {
          trace_id: row.trace_id,
          span_id: row.span_id,
          log_message: row.msg,
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

function parseXrayTrace(xrayTraceId, out) {
  const trace = out?.Traces?.[0];
  if (!trace) return null;
  const segments = (trace.Segments || []).map((s) => {
    let doc = {};
    try {
      doc = JSON.parse(s.Document || '{}');
    } catch {
      doc = {};
    }
    return {
      id: s.Id,
      name: doc.name || doc.Name,
      origin: doc.origin,
      subsegments: (doc.subsegments || []).length,
    };
  });
  const root = segments.find((s) => s.name === 'commission.daily_close');
  return {
    trace_id: xrayTraceId,
    duration_seconds: trace.Duration,
    segment_count: segments.length,
    root_span: root || null,
    services: [...new Set(segments.map((s) => s.name).filter(Boolean))].sort(),
    segments,
  };
}

async function fetchXrayTrace(xrayTraceId, { waitMs = 90_000, pollMs = 5000 } = {}) {
  if (!xrayTraceId) return null;
  const deadline = Date.now() + waitMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const out = awsJson(['xray', 'batch-get-traces', '--trace-ids', xrayTraceId]);
      const parsed = parseXrayTrace(xrayTraceId, out);
      if (parsed?.root_span) return parsed;
      if (parsed?.segment_count > 0) return parsed;
    } catch (err) {
      lastError = String(err.message || err);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return lastError ? { error: lastError, pending: true } : { pending: true };
}

async function main() {
  const refreshOnly = (process.env.XRAY_TRACE_ID || '').trim();
  let queueUrl = null;
  let messageId = null;
  let payload = null;
  let trace = null;

  if (refreshOnly) {
    const m = refreshOnly.match(/^1-([0-9a-f]{8})-([0-9a-f]{32})$/i);
    trace = {
      trace_id: m ? `${m[1]}${m[2]}` : refreshOnly.replace(/-/g, ''),
      span_id: (process.env.SPAN_ID || '').trim() || null,
    };
    const priorPath = path.join(
      __dirname,
      '../../../evidence/product-pos/g3-commission-close-trace.json'
    );
    if (fs.existsSync(priorPath)) {
      try {
        const prior = JSON.parse(fs.readFileSync(priorPath, 'utf8'));
        queueUrl = prior.queue_url || null;
        messageId = prior.message_id || null;
        payload = prior.payload || null;
        trace.span_id = trace.span_id || prior.span_id || null;
      } catch {
        // keep refresh-only fields
      }
    }
  } else {
    const startedAt = Date.now();
    const sqs = new SQSClient({ region: REGION });
    queueUrl = await resolveQueueUrl(sqs);

    payload = {
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
    messageId = sent.MessageId;

    const deadline = startedAt + WAIT_MS;
    while (Date.now() < deadline) {
      trace = findTraceId(startedAt - 5000);
      if (trace) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const xrayTraceId = trace?.trace_id
    ? toXrayTraceId(trace.trace_id) || refreshOnly
    : refreshOnly || null;
  const xray = await fetchXrayTrace(xrayTraceId);

  const evidence = {
    captured_at: new Date().toISOString(),
    queue_url: queueUrl,
    message_id: messageId,
    payload,
    trace_id: trace?.trace_id || null,
    span_id: trace?.span_id || null,
    xray_trace_id: xrayTraceId,
    traceparent: trace?.trace_id
      ? `00-${trace.trace_id}-${trace?.span_id || '0000000000000000'}-01`
      : null,
    xray,
    passed: Boolean(trace?.trace_id && xray?.root_span),
    hint: xray?.root_span
      ? 'AWS Console → X-Ray → Traces → paste xray_trace_id; root span commission.daily_close'
      : trace?.trace_id
        ? 'trace_id captured; X-Ray still indexing — re-run with XRAY_TRACE_ID=<xray_trace_id>'
        : 'No trace_id in commission logs — confirm worker is on latest image and re-run',
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
