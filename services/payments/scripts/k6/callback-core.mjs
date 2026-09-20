export const SIGNATURE_HEADER = 'x-tillflow-signature';
export const SCHEME = 'v1';

export function signedPayload(timestampSeconds, rawBody) {
  return `${Math.floor(timestampSeconds)}.${rawBody}`;
}

export function signatureHeader(timestampSeconds, macHex) {
  return `t=${Math.floor(timestampSeconds)},${SCHEME}=${macHex}`;
}

export function buildStkCallback({
  checkoutRequestId,
  merchantRequestId = 'mr-k6',
  amountMinor,
  msisdn = '254700000000',
  mpesaReceipt = 'K6RECEIPT',
  resultCode = 0,
  resultDesc = 'The service request is processed successfully.',
}) {
  const stk = {
    MerchantRequestID: merchantRequestId,
    CheckoutRequestID: checkoutRequestId,
    ResultCode: resultCode,
    ResultDesc: resultDesc,
  };

  if (resultCode === 0) {
    stk.CallbackMetadata = {
      Item: [
        { Name: 'Amount', Value: amountMinor / 100 },
        { Name: 'MpesaReceiptNumber', Value: mpesaReceipt },
        { Name: 'PhoneNumber', Value: Number(msisdn) },
        { Name: 'TransactionDate', Value: 20260921120000 },
      ],
    };
  }

  return { Body: { stkCallback: stk } };
}
