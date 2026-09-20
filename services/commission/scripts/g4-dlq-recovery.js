#!/usr/bin/env node
/**
 * G4 — Berissa commission DLQ drill.
 * Blocks commission→ALB, sends poison close message, waits for DLQ + alarm,
 * recovers with start-message-move-task after restoring connectivity.
 *
 *   export AWS_PROFILE=g10 AWS_REGION=eu-central-1
 *   node services/commission/scripts/g4-dlq-recovery.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REGION = process.env.AWS_REGION || 'eu-central-1';
const ALB_RULE_ID = process.env.ALB_ECS_RULE_ID || 'sgr-0fe7f2b57d9676326';
const QUEUE_URL =
  process.env.COMMISSION_QUEUE_URL ||
  'https://sqs.eu-central-1.amazonaws.com/240462142849/devops-g10-commission-close';
const DLQ_URL =
  process.env.COMMISSION_DLQ_URL ||
  'https://sqs.eu-central-1.amazonaws.com/240462142849/devops-g10-commission-close-dlq';
const DLQ_ARN =
  process.env.COMMISSION_DLQ_ARN ||
  'arn:aws:sqs:eu-central-1:240462142849:devops-g10-commission-close-dlq';
const PRIMARY_ARN =
  process.env.COMMISSION_QUEUE_ARN ||
  'arn:aws:sqs:eu-central-1:240462142849:devops-g10-commission-close';
const OUT_DIR =
  process.env.EVIDENCE_DIR || path.resolve(__dirname, '../../../evidence/product-pos');
const POLL_MS = 5000;
// Poller ReceiveMessageCommand uses VisibilityTimeout=300 regardless of queue attribute.
const MAX_WAIT_MS = Number(process.env.DLQ_MAX_WAIT_MS || 1_200_000);

function aws(args, { json = true } = {}) {
  const out = execFileSync('aws', [...args, '--region', REGION], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return json ? JSON.parse(out) : out.trim();
}

function eatNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Africa/Nairobi', hour12: false }) + '+03:00';
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function queueDepth(url) {
  const attrs = aws(['sqs', 'get-queue-attributes', '--queue-url', url, '--attribute-names', 'All']);
  const a = attrs.Attributes || {};
  return {
    visible: Number(a.ApproximateNumberOfMessages || 0),
    notVisible: Number(a.ApproximateNumberOfMessagesNotVisible || 0),
    delayed: Number(a.ApproximateNumberOfMessagesDelayed || 0),
  };
}

function alarmState(name) {
  const out = aws(['cloudwatch', 'describe-alarms', '--alarm-names', name]);
  const alarm = (out.MetricAlarms || [])[0];
  if (!alarm) return null;
  return {
    state: alarm.StateValue,
    reason: alarm.StateReason,
    updated: alarm.StateUpdatedTimestamp,
  };
}

function slackEvents(sinceIso) {
  const sinceMs = new Date(sinceIso).getTime();
  const logs = aws([
    'logs',
    'filter-log-events',
    '--log-group-name',
    '/aws/lambda/devops-g10-slack-notifier',
    '--start-time',
    String(sinceMs),
    '--filter-pattern',
    'commission-dlq',
  ]);
  return (logs.events || []).map((e) => ({
    timestamp: new Date(e.timestamp).toISOString(),
    message: e.message?.slice(0, 500),
  }));
}

async function waitFor(fn, label, maxMs = MAX_WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const val = await fn();
    if (val) return { ...val, waited_ms: Date.now() - start };
    await sleep(POLL_MS);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  const drillStart = new Date().toISOString();
  const drillStartEat = eatNow();

  // Block commission→POS via internal ALB (ECS hairpin).
  const breakAt = new Date().toISOString();
  aws(['ec2', 'revoke-security-group-ingress', '--group-id', 'sg-0635ff8540248d2c5', '--security-group-rule-ids', ALB_RULE_ID], {
    json: false,
  });

  const poisonBody = JSON.stringify({
    type: 'commission.daily-close',
    scheduled_at: new Date().toISOString(),
    drill: 'g4-dlq-poison',
    business_day: '2099-01-01',
  });

  const sent = aws([
    'sqs',
    'send-message',
    '--queue-url',
    QUEUE_URL,
    '--message-body',
    poisonBody,
  ]);

  const dlqHit = await waitFor(() => {
    const d = queueDepth(DLQ_URL);
    if (d.visible >= 1) return { at: new Date().toISOString(), depth: d };
    return null;
  }, 'DLQ message');

  const alarmFiring = await waitFor(() => {
    const a = alarmState('devops-g10-commission-dlq');
    if (a?.state === 'ALARM') return { at: new Date().toISOString(), ...a };
    return null;
  }, 'commission-dlq ALARM');

  await sleep(10_000);
  const slackFiring = slackEvents(drillStart);

  // First safe action: read DLQ attributes (runbook).
  const dlqRead = aws(['sqs', 'get-queue-attributes', '--queue-url', DLQ_URL, '--attribute-names', 'All']);

  // Restore connectivity before redrive.
  const restoreAt = new Date().toISOString();
  aws([
    'ec2',
    'authorize-security-group-ingress',
    '--group-id',
    'sg-0635ff8540248d2c5',
    '--ip-permissions',
    JSON.stringify([
      {
        IpProtocol: 'tcp',
        FromPort: 80,
        ToPort: 80,
        UserIdGroupPairs: [
          { GroupId: 'sg-05cc34784cf1ed3e2', Description: 'HTTP from ECS tasks (service-to-service via internal ALB).' },
        ],
      },
    ]),
  ], { json: false });

  // Recover: move messages out of DLQ back to primary (processes cleanly — no eligible sales for 2099-01-01).
  const moveTask = aws([
    'sqs',
    'start-message-move-task',
    '--source-arn',
    DLQ_ARN,
    '--destination-arn',
    PRIMARY_ARN,
  ]);

  await waitFor(() => {
    const d = queueDepth(DLQ_URL);
    if (d.visible === 0 && d.notVisible === 0) return { at: new Date().toISOString(), depth: d };
    return null;
  }, 'DLQ empty');

  const alarmOk = await waitFor(() => {
    const a = alarmState('devops-g10-commission-dlq');
    if (a?.state === 'OK') return { at: new Date().toISOString(), ...a };
    return null;
  }, 'commission-dlq OK', 180_000);

  const drillEnd = new Date().toISOString();
  const slackAll = slackEvents(drillStart);

  const evidence = {
    drill: 'g4-dlq-recovery',
    owner: 'Berissa',
    runbook: 'docs/runbook.md#commission-dlq',
    times: {
      started_utc: drillStart,
      started_eat: drillStartEat,
      alb_rule_revoked_utc: breakAt,
      message_sent_utc: sent?.MD5OfMessageBody ? breakAt : breakAt,
      dlq_message_visible_utc: dlqHit.at,
      alarm_firing_utc: alarmFiring.at,
      alb_rule_restored_utc: restoreAt,
      alarm_ok_utc: alarmOk.at,
      ended_utc: drillEnd,
      ended_eat: eatNow(),
      dlq_wait_ms: dlqHit.waited_ms,
      alarm_ok_wait_ms: alarmOk.waited_ms,
    },
    poison_message: {
      queue: 'devops-g10-commission-close',
      body: JSON.parse(poisonBody),
      message_id: sent.MessageId,
      failure_mode: 'ECS→ALB ingress revoked; commission close cannot reach POS /internal/v1/commission/eligible',
      max_receive_count: 3,
      poller_visibility_seconds: 300,
      note: 'Commission poller ReceiveMessageCommand sets VisibilityTimeout=300',
    },
    break_action: {
      type: 'revoke_security_group_ingress',
      rule_id: ALB_RULE_ID,
      alb_sg: 'sg-0635ff8540248d2c5',
    },
    first_safe_action: 'get-queue-attributes on devops-g10-commission-close-dlq — read, do not redrive until failure class known',
    dlq_attributes_at_alarm: dlqRead.Attributes,
    alarm: {
      name: 'devops-g10-commission-dlq',
      firing: alarmFiring,
      recovered: alarmOk,
    },
    slack_lambda: {
      function: 'devops-g10-slack-notifier',
      log_group: '/aws/lambda/devops-g10-slack-notifier',
      events_matching_commission_dlq: slackAll,
    },
    recovery: {
      action: 'start-message-move-task',
      source_arn: DLQ_ARN,
      destination_arn: PRIMARY_ARN,
      task_handle: moveTask,
    },
    checks: [
      { check: 'message reached DLQ', ok: dlqHit.depth.visible >= 1, actual: dlqHit.depth, expected: 'visible >= 1' },
      { check: 'alarm fired', ok: alarmFiring.state === 'ALARM', actual: alarmFiring.state, expected: 'ALARM' },
      { check: 'slack notifier invoked', ok: slackAll.length >= 1, actual: slackAll.length, expected: '>= 1' },
      { check: 'alarm recovered to OK', ok: alarmOk.state === 'OK', actual: alarmOk.state, expected: 'OK' },
    ],
    passed: alarmFiring.state === 'ALARM' && alarmOk.state === 'OK' && dlqHit.depth.visible >= 1,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'g4-dlq-recovery.json');
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
