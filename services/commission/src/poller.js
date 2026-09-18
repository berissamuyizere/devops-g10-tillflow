const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { runDailyClose } = require('./close');

function startPoller({
  queueUrl,
  region,
  posBaseUrl,
  paymentsBaseUrl,
  paymentsToken,
  commissionToken,
  tenantIds,
  logger,
  fetchImpl = fetch,
  sqsClient,
  retryDelayMs = 5000,
} = {}) {
  if (!queueUrl) {
    logger.info({ msg: 'sqs_poller_disabled', reason: 'SQS_QUEUE_URL unset' });
    return { stop() {} };
  }

  const client = sqsClient || new SQSClient({ region });
  let stopped = false;

  async function loop() {
    while (!stopped) {
      try {
        const out = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 300,
          })
        );
        const messages = out.Messages || [];
        for (const msg of messages) {
          let payload = {};
          try {
            payload = JSON.parse(msg.Body || '{}');
          } catch {
            payload = {};
          }
          logger.info({ type: payload.type, message_id: msg.MessageId }, 'close_message_received');
          await runDailyClose({
            fetchImpl,
            posBaseUrl,
            paymentsBaseUrl,
            paymentsToken,
            commissionToken,
            tenantIds,
            scheduledAt: payload.scheduled_at,
            logger,
          });
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: msg.ReceiptHandle,
            })
          );
          logger.info({ message_id: msg.MessageId }, 'close_message_deleted');
        }
      } catch (err) {
        if (stopped) return;
        logger.error({ err: String(err.message || err) }, 'close_poller_error');
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  const running = loop();
  return {
    async stop() {
      stopped = true;
      await running.catch(() => {});
    },
  };
}

module.exports = { startPoller };
