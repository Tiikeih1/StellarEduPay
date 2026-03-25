const { server, SCHOOL_WALLET, isAcceptedAsset, CONFIRMATION_THRESHOLD, getExplorerUrl } = require('../config/stellarConfig');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const PaymentIntent = require('../models/paymentIntentModel');

/**
 * Detect asset information from a Stellar payment operation.
 * Returns { assetCode, assetType, assetIssuer } or null if unsupported.
 */
function detectAsset(payOp) {
  const assetType = payOp.asset_type;
  const assetCode = assetType === 'native' ? 'XLM' : payOp.asset_code;
  const assetIssuer = assetType === 'native' ? null : payOp.asset_issuer;

  const { accepted } = isAcceptedAsset(assetCode, assetType);
  if (!accepted) return null;

  return { assetCode, assetType, assetIssuer };
}

/**
 * Normalize a raw amount string to a number with consistent precision.
 */
function normalizeAmount(rawAmount) {
  return parseFloat(parseFloat(rawAmount).toFixed(7));
}

/**
 * Extract and validate the payment operation from a transaction.
 * Returns { payOp, memo, asset } or null if the transaction is invalid.
 * Checks: successful flag, memo presence, destination wallet, accepted asset.
 */
async function extractValidPayment(tx) {
  if (!tx.successful) return null;

  const memo = tx.memo ? tx.memo.trim() : null;
  if (!memo) return null;

  const ops = await tx.operations();
  const payOp = ops.records.find(op => op.type === 'payment' && op.to === SCHOOL_WALLET);
  if (!payOp) return null;

  const asset = detectAsset(payOp);
  if (!asset) return null;

  return { payOp, memo, asset };
}

/**
 * Validate a payment amount against the expected fee.
 * @param {number} paymentAmount
 * @param {number} expectedFee
 * @returns {{ status: string, excessAmount: number, message: string }}
 */
function validatePaymentAgainstFee(paymentAmount, expectedFee) {
  if (paymentAmount < expectedFee) {
    return {
      status: 'underpaid',
      excessAmount: 0,
      message: `Payment of ${paymentAmount} is less than the required fee of ${expectedFee}`,
    };
  }
  if (paymentAmount > expectedFee) {
    const excess = parseFloat((paymentAmount - expectedFee).toFixed(7));
    return {
      status: 'overpaid',
      excessAmount: excess,
      message: `Payment of ${paymentAmount} exceeds the required fee of ${expectedFee} by ${excess}`,
    };
  }
  return {
    status: 'valid',
    excessAmount: 0,
    message: 'Payment matches the required fee',
  };
}

/**
 * Check whether a transaction has met the confirmation threshold.
 * @param {number} txLedger - the ledger sequence the transaction was included in
 * @returns {Promise<boolean>}
 */
async function checkConfirmationStatus(txLedger) {
  const latestLedger = await server.ledgers().order('desc').limit(1).call();
  const latestSequence = latestLedger.records[0].sequence;
  return (latestSequence - txLedger) >= CONFIRMATION_THRESHOLD;
}

/**
 * Detect memo collision: same memo used by a different sender within 24h,
 * or payment amount is wildly outside expected range.
 * @returns {{ suspicious: boolean, reason: string|null }}
 */
async function detectMemoCollision(memo, senderAddress, paymentAmount, expectedFee, txDate) {
  const COLLISION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const windowStart = new Date(txDate.getTime() - COLLISION_WINDOW_MS);

  const recentFromOtherSender = await Payment.findOne({
    studentId: memo,
    senderAddress: { $ne: senderAddress, $ne: null },
    confirmedAt: { $gte: windowStart },
  });

  if (recentFromOtherSender) {
    return {
      suspicious: true,
      reason: `Memo "${memo}" was used by a different sender (${recentFromOtherSender.senderAddress}) within the last 24 hours`,
    };
  }

  if (paymentAmount <= 0 || paymentAmount > expectedFee * 2) {
    return {
      suspicious: true,
      reason: `Unusual payment amount ${paymentAmount} for expected fee ${expectedFee}`,
    };
  }

  return { suspicious: false, reason: null };
}

/**
 * Persist a payment record, enforcing uniqueness on txHash.
 * Throws DUPLICATE_TX if already recorded.
 */
async function recordPayment(data) {
  const exists = await Payment.findOne({ txHash: data.txHash });
  if (exists) {
    const err = new Error(`Transaction ${data.txHash} has already been processed`);
    err.code = 'DUPLICATE_TX';
    throw err;
  }
  try {
    return await Payment.create(data);
  } catch (e) {
    if (e.code === 11000) {
      const err = new Error(`Transaction ${data.txHash} has already been processed`);
      err.code = 'DUPLICATE_TX';
      throw err;
    }
    throw e;
  }
}

/**
 * Fetch recent transactions to the school wallet and record new payments.
 */
async function syncPayments() {
  const transactions = await server
    .transactions()
    .forAccount(SCHOOL_WALLET)
    .order('desc')
    .limit(20)
    .call();

  for (const tx of transactions.records) {
    const exists = await Payment.findOne({ txHash: tx.hash });
    if (exists) continue;

    const valid = await extractValidPayment(tx);
    if (!valid) continue;

    const { payOp, memo } = valid;

    // Find the corresponding payment intent by memo
    const intent = await PaymentIntent.findOne({ memo, status: 'pending' });
    if (!intent) continue;

    const student = await Student.findOne({ studentId: intent.studentId });
    if (!student) continue;

    const paymentAmount = normalizeAmount(payOp.amount);
    const senderAddress = payOp.from || null;
    const txDate = new Date(tx.created_at);
    const txLedger = tx.ledger_attr || tx.ledger || null;

    const isConfirmed = txLedger ? await checkConfirmationStatus(txLedger) : false;
    const confirmationStatus = isConfirmed ? 'confirmed' : 'pending_confirmation';

    const collision = await detectMemoCollision(memo, senderAddress, paymentAmount, student.feeAmount, txDate);

    // Aggregate cumulative payments for this student
    const previousPayments = await Payment.aggregate([
      { $match: { studentId: intent.studentId } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const previousTotal = previousPayments.length ? previousPayments[0].total : 0;
    const cumulativeTotal = parseFloat((previousTotal + paymentAmount).toFixed(7));
    const remaining = parseFloat((student.feeAmount - cumulativeTotal).toFixed(7));

    let cumulativeStatus;
    if (cumulativeTotal < student.feeAmount) {
      cumulativeStatus = 'underpaid';
    } else if (cumulativeTotal > student.feeAmount) {
      cumulativeStatus = 'overpaid';
    } else {
      cumulativeStatus = 'valid';
    }

    const excessAmount = cumulativeStatus === 'overpaid'
      ? parseFloat((cumulativeTotal - student.feeAmount).toFixed(7))
      : 0;

    await Payment.create({
      studentId: intent.studentId,
      txHash: tx.hash,
      amount: paymentAmount,
      feeAmount: student.feeAmount,
      feeValidationStatus: cumulativeStatus,
      excessAmount,
      status: 'confirmed',
      memo,
      senderAddress,
      isSuspicious: collision.suspicious,
      suspicionReason: collision.reason,
      ledger: txLedger,
      confirmationStatus,
      confirmedAt: txDate,
    });

    if (isConfirmed && !collision.suspicious) {
      await Student.findOneAndUpdate(
        { studentId: intent.studentId },
        {
          totalPaid: cumulativeTotal,
          remainingBalance: remaining < 0 ? 0 : remaining,
          feePaid: cumulativeTotal >= student.feeAmount,
        }
      );
    }

    await PaymentIntent.findByIdAndUpdate(intent._id, { status: 'completed' });
  }
}

/**
 * Verify a single transaction hash against the school wallet.
 * Returns payment details with explorerUrl, or null if the transaction is invalid.
 */
async function verifyTransaction(txHash) {
  const tx = await server.transactions().transaction(txHash).call();

  const valid = await extractValidPayment(tx);
  if (!valid) return null;

  const { payOp, memo, asset } = valid;
  const amount = normalizeAmount(payOp.amount);

  const student = await Student.findOne({ studentId: memo });
  const feeAmount = student ? student.feeAmount : null;
  const feeValidation = feeAmount != null
    ? validatePaymentAgainstFee(amount, feeAmount)
    : { status: 'unknown', message: 'Student not found, cannot validate fee' };

  return {
    hash: tx.hash,
    memo,
    amount,
    assetCode: asset.assetCode,
    assetType: asset.assetType,
    feeAmount,
    feeValidation,
    date: tx.created_at,
    explorerUrl: getExplorerUrl(tx.hash),
  };
}

/**
 * Re-check all pending_confirmation payments and promote them to confirmed
 * once the ledger threshold has been met.
 */
async function finalizeConfirmedPayments() {
  const pending = await Payment.find({ confirmationStatus: 'pending_confirmation', isSuspicious: false });

  for (const payment of pending) {
    if (!payment.ledger) continue;

    const isConfirmed = await checkConfirmationStatus(payment.ledger);
    if (!isConfirmed) continue;

    await Payment.findByIdAndUpdate(payment._id, { confirmationStatus: 'confirmed' });

    const student = await Student.findOne({ studentId: payment.studentId });
    if (!student) continue;

    const agg = await Payment.aggregate([
      { $match: { studentId: payment.studentId, confirmationStatus: 'confirmed', isSuspicious: false } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const totalPaid = agg.length ? parseFloat(agg[0].total.toFixed(7)) : 0;
    const remainingBalance = parseFloat(Math.max(0, student.feeAmount - totalPaid).toFixed(7));

    await Student.findOneAndUpdate(
      { studentId: payment.studentId },
      {
        totalPaid,
        remainingBalance,
        feePaid: totalPaid >= student.feeAmount,
      }
    );
  }
}

module.exports = {
  syncPayments,
  verifyTransaction,
  validatePaymentAgainstFee,
  detectAsset,
  normalizeAmount,
  extractValidPayment,
  recordPayment,
  detectMemoCollision,
  finalizeConfirmedPayments,
  checkConfirmationStatus,
};
