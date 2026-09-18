const { LEDGER_STATUSES, evaluate, statusForB2cResultCode } = require('./state');
const { sha256 } = require('../hash');
const payoutsService = require('./service');
const signature = require('../../../_shared/mpesa/signature');

const UNIQUE_VIOLATION = '23505';

const OUTCOMES = Object.freeze({
  APPLIED: 'applied',
  REPLAY_NOOP: 'replay_noop',
  REJECTED_BAD_SIGNATURE: 'rejected_bad_signature',
  REJECTED_UNKNOWN_PAYOUT: 'rejected_unknown_payout',
  REJECTED_ILLEGAL_TRANSITION: 'rejected_illegal_transition',
  REJECTED_MALFORMED: 'rejected_malformed',
});

const HTTP_STATUS = Object.freeze({
  [OUTCOMES.APPLIED]: 200,
  [OUTCOMES.REPLAY_NOOP]: 200,
  [OUTCOMES.REJECTED_BAD_SIGNATURE]: 401,
  [OUTCOMES.REJECTED_UNKNOWN_PAYOUT]: 404,
  [OUTCOMES.REJECTED_ILLEGAL_TRANSITION]: 409,
  [OUTCOMES.REJECTED_MALFORMED]: 400,
});

function parseResultEnvelope(body) {
  const result = body?.Result;
  if (!result || typeof result !== 'object') return null;
  const originatorConversationId = result.OriginatorConversationID;
  const resultCode = Number(result.ResultCode);
  if (!originatorConversationId || !Number.isFinite(resultCode)) return null;

  const params = Array.isArray(result.ResultParameters?.ResultParameter)
    ? result.ResultParameters.ResultParameter
    : [];
  const meta = {};
  for (const p of params) {
    if (p && typeof p.Key === 'string') meta[p.Key] = p.Value;
  }

  const amount = meta.TransactionAmount;
  const amountMinor =
    amount === undefined || amount === null ? null : Math.round(Number(amount) * 100);

  return {
    originatorConversationId: String(originatorConversationId),
    conversationId: result.ConversationID ?? null,
    resultCode,
    resultDesc: result.ResultDesc ?? null,
    transactionId: result.TransactionID ? String(result.TransactionID) : meta.TransactionReceipt ? String(meta.TransactionReceipt) : null,
    amountMinor: Number.isFinite(amountMinor) ? amountMinor : null,
  };
}

function hashB2cCallback(body) {
  const r = body?.Result || {};
  return sha256(
    JSON.stringify({
      originator_conversation_id: r.OriginatorConversationID ?? null,
      conversation_id: r.ConversationID ?? null,
      result_code: r.ResultCode ?? null,
      transaction_id: r.TransactionID ?? null,
    })
  );
}

async function insertLog(client, entry) {
  const res = await client.query(
    `INSERT INTO payments.payout_callback_log (
       ledger_id, originator_conversation_id, conversation_id, callback_hash,
       signature_valid, signature_reason, outcome, result_code, notes, raw_body
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      entry.ledgerId || null,
      entry.originatorConversationId || null,
      entry.conversationId || null,
      entry.callbackHash,
      entry.signatureValid,
      entry.signatureReason || null,
      entry.outcome,
      entry.resultCode ?? null,
      entry.notes || null,
      entry.rawBody,
    ]
  );
  return res.rows[0].id;
}

async function logRejection(db, entry) {
  try {
    await db.withTransaction((client) => insertLog(client, entry));
  } catch (err) {
    if (err.code !== UNIQUE_VIOLATION) throw err;
  }
}

async function handleB2cResultCallback(db, { rawBody, headers, secret, now = () => Date.now(), logger }) {
  const headerValue = headers?.[signature.SIGNATURE_HEADER];
  const verification = signature.verify(rawBody, headerValue, secret, { now });

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    parsedBody = null;
  }

  const callbackHash = parsedBody ? hashB2cCallback(parsedBody) : sha256(String(rawBody));

  if (!verification.valid) {
    await logRejection(db, {
      callbackHash,
      signatureValid: false,
      signatureReason: verification.reason,
      outcome: OUTCOMES.REJECTED_BAD_SIGNATURE,
      rawBody: parsedBody ?? { unparseable: String(rawBody).slice(0, 2000) },
    });
    logger?.warn({ reason: verification.reason }, 'b2c_callback_signature_rejected');
    return {
      status: HTTP_STATUS[OUTCOMES.REJECTED_BAD_SIGNATURE],
      outcome: OUTCOMES.REJECTED_BAD_SIGNATURE,
      body: { error: 'unauthorized', reason: verification.reason },
    };
  }

  const envelope = parsedBody ? parseResultEnvelope(parsedBody) : null;
  if (!envelope) {
    await logRejection(db, {
      callbackHash,
      signatureValid: true,
      outcome: OUTCOMES.REJECTED_MALFORMED,
      rawBody: parsedBody ?? { unparseable: String(rawBody).slice(0, 2000) },
    });
    return {
      status: HTTP_STATUS[OUTCOMES.REJECTED_MALFORMED],
      outcome: OUTCOMES.REJECTED_MALFORMED,
      body: { error: 'malformed_callback' },
    };
  }

  const settled = await db.withTransaction(async (client) => {
    const res = await client.query(
      `SELECT * FROM payments.payout_ledger
       WHERE originator_conversation_id = $1
       FOR UPDATE`,
      [envelope.originatorConversationId]
    );

    if (res.rowCount === 0) {
      await insertLog(client, {
        originatorConversationId: envelope.originatorConversationId,
        conversationId: envelope.conversationId,
        callbackHash,
        signatureValid: true,
        outcome: OUTCOMES.REJECTED_UNKNOWN_PAYOUT,
        resultCode: envelope.resultCode,
        rawBody: parsedBody,
      });
      return { outcome: OUTCOMES.REJECTED_UNKNOWN_PAYOUT, body: { error: 'unknown_payout' } };
    }

    const row = res.rows[0];

    if (envelope.resultCode === 0 && envelope.amountMinor !== null && envelope.amountMinor !== row.amount_minor) {
      await insertLog(client, {
        ledgerId: row.id,
        originatorConversationId: envelope.originatorConversationId,
        conversationId: envelope.conversationId,
        callbackHash,
        signatureValid: true,
        outcome: OUTCOMES.REJECTED_ILLEGAL_TRANSITION,
        resultCode: envelope.resultCode,
        notes: `callback ${envelope.amountMinor} != ledger ${row.amount_minor}`,
        rawBody: parsedBody,
      });
      return {
        outcome: OUTCOMES.REJECTED_ILLEGAL_TRANSITION,
        body: { error: 'amount_mismatch' },
        ledger: payoutsService.mapLedger(row),
      };
    }

    const target = statusForB2cResultCode(envelope.resultCode);
    if (!target) {
      await insertLog(client, {
        ledgerId: row.id,
        originatorConversationId: envelope.originatorConversationId,
        conversationId: envelope.conversationId,
        callbackHash,
        signatureValid: true,
        outcome: OUTCOMES.REPLAY_NOOP,
        resultCode: envelope.resultCode,
        notes: `result_code ${envelope.resultCode} is not terminal`,
        rawBody: parsedBody,
      });
      return {
        outcome: OUTCOMES.REPLAY_NOOP,
        body: { status: row.status, applied: false },
        ledger: payoutsService.mapLedger(row),
      };
    }

    let decision;
    try {
      decision = evaluate(row.status, target);
    } catch (err) {
      if (err.code !== 'ILLEGAL_TRANSITION') throw err;
      await insertLog(client, {
        ledgerId: row.id,
        originatorConversationId: envelope.originatorConversationId,
        conversationId: envelope.conversationId,
        callbackHash,
        signatureValid: true,
        outcome: OUTCOMES.REJECTED_ILLEGAL_TRANSITION,
        resultCode: envelope.resultCode,
        notes: err.message,
        rawBody: parsedBody,
      });
      return {
        outcome: OUTCOMES.REJECTED_ILLEGAL_TRANSITION,
        body: { error: 'illegal_transition', from: row.status, to: target },
        ledger: payoutsService.mapLedger(row),
      };
    }

    if (decision.action === 'noop') {
      await insertLog(client, {
        ledgerId: row.id,
        originatorConversationId: envelope.originatorConversationId,
        conversationId: envelope.conversationId,
        callbackHash,
        signatureValid: true,
        outcome: OUTCOMES.REPLAY_NOOP,
        resultCode: envelope.resultCode,
        notes: decision.reason,
        rawBody: parsedBody,
      });
      return {
        outcome: OUTCOMES.REPLAY_NOOP,
        body: { status: row.status, applied: false, replay: true },
        ledger: payoutsService.mapLedger(row),
      };
    }

    const patch =
      target === LEDGER_STATUSES.DISBURSED
        ? {
            b2c_result_code: envelope.resultCode,
            b2c_transaction_id: envelope.transactionId,
            b2c_sync_error: null,
            disbursed_at: new Date(now()),
          }
        : {
            b2c_result_code: envelope.resultCode,
            failure_reason: envelope.resultDesc || `b2c result ${envelope.resultCode}`,
            b2c_sync_error: null,
          };

    const applied = await payoutsService.applyLedgerTransition(client, row, target, patch);

    try {
      await insertLog(client, {
        ledgerId: row.id,
        originatorConversationId: envelope.originatorConversationId,
        conversationId: envelope.conversationId,
        callbackHash,
        signatureValid: true,
        outcome: OUTCOMES.APPLIED,
        resultCode: envelope.resultCode,
        rawBody: parsedBody,
      });
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        const dup = new Error('duplicate applied callback');
        dup.code = 'DUPLICATE_APPLIED';
        throw dup;
      }
      throw err;
    }

    return {
      outcome: OUTCOMES.APPLIED,
      body: { status: applied.ledger.status, applied: true },
      ledger: applied.ledger,
    };
  }).catch(async (err) => {
    if (err.code === 'DUPLICATE_APPLIED') {
      return { outcome: OUTCOMES.REPLAY_NOOP, body: { applied: false, replay: true } };
    }
    throw err;
  });

  logger?.info(
    { outcome: settled.outcome, originator_conversation_id: envelope.originatorConversationId },
    'b2c_result_callback'
  );

  return { status: HTTP_STATUS[settled.outcome], ...settled };
}

module.exports = { handleB2cResultCallback, parseResultEnvelope, hashB2cCallback, OUTCOMES, HTTP_STATUS };
