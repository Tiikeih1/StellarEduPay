/**
 * Unit tests for stellarService pure functions and verifyTransaction / syncPayments.
 * All external dependencies (Horizon, MongoDB models) are mocked.
 */

process.env.NODE_ENV = 'test';

const {
  validatePaymentAgainstFee,
  detectAsset,
  normalizeAmount,
  extractValidPayment,
  verifyTransaction,
  syncPayments,
} = require('../backend/src/services/stellarService');

// ─── Stellar config mock ──────────────────────────────────────────────────────

jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GTEST123',
  CONFIRMATION_THRESHOLD: 2,
  ACCEPTED_ASSETS: {
    XLM:  { code: 'XLM',  type: 'native',          issuer: null },
    USDC: { code: 'USDC', type: 'credit_alphanum4', issuer: 'GISSUER' },
  },
  isAcceptedAsset: (code, type) => {
    const map = { XLM: 'native', USDC: 'credit_alphanum4' };
    if (map[code] && map[code] === type) return { accepted: true, asset: { code, type } };
    return { accepted: false, asset: null };
  },
  getExplorerUrl: (txHash) => `https://stellar.expert/explorer/testnet/tx/${txHash}`,
  server: {
    transactions: () => ({
      forAccount: () => ({
        order: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }),
      }),
      transaction: () => ({
        call: async () => ({
          hash: 'abc123',
          memo: 'STU001',
          successful: true,
          created_at: new Date().toISOString(),
          operations: mockOperations,
        }),
      }),
    }),
    ledgers: () => ({
      order: () => ({ limit: () => ({ call: async () => ({ records: [{ sequence: 100 }] }) }) }),
    }),
  },
}));

// ─── Model mocks ─────────────────────────────────────────────────────────────

const mockOperations = jest.fn();

jest.mock('../backend/src/models/paymentModel', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  aggregate: jest.fn().mockResolvedValue([]),
  find: jest.fn().mockResolvedValue([]),
}));

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  findOne: jest.fn().mockResolvedValue({
    _id: 'intent123',
    studentId: 'STU001',
    amount: 200,
    memo: 'STU001',
    status: 'pending',
  }),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

const Student = require('../backend/src/models/studentModel');
jest.mock('../backend/src/models/studentModel', () => ({
  findOne: jest.fn().mockResolvedValue({ studentId: 'STU001', feeAmount: 200 }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

// ─── validatePaymentAgainstFee ────────────────────────────────────────────────

describe('validatePaymentAgainstFee', () => {
  test('valid when payment equals fee', () => {
    expect(validatePaymentAgainstFee(200, 200).status).toBe('valid');
  });

  test('underpaid when payment is less than fee', () => {
    expect(validatePaymentAgainstFee(150, 200).status).toBe('underpaid');
  });

  test('overpaid when payment exceeds fee', () => {
    expect(validatePaymentAgainstFee(250, 200).status).toBe('overpaid');
  });

  test('overpaid result includes correct excessAmount', () => {
    expect(validatePaymentAgainstFee(250, 200).excessAmount).toBeCloseTo(50, 5);
  });

  test('messages include the amounts', () => {
    const result = validatePaymentAgainstFee(50, 200);
    expect(result.message).toContain('50');
    expect(result.message).toContain('200');
  });
});

// ─── detectAsset ─────────────────────────────────────────────────────────────

describe('detectAsset', () => {
  test('recognizes native XLM', () => {
    expect(detectAsset({ asset_type: 'native' })).toEqual({
      assetCode: 'XLM',
      assetType: 'native',
      assetIssuer: null,
    });
  });

  test('recognizes USDC', () => {
    expect(detectAsset({
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GISSUER',
    })).toEqual({
      assetCode: 'USDC',
      assetType: 'credit_alphanum4',
      assetIssuer: 'GISSUER',
    });
  });

  test('returns null for unsupported asset', () => {
    expect(detectAsset({
      asset_type: 'credit_alphanum4',
      asset_code: 'SHIB',
      asset_issuer: 'GRANDOM',
    })).toBeNull();
  });

  test('returns null when asset code matches but type does not', () => {
    expect(detectAsset({
      asset_type: 'credit_alphanum4',
      asset_code: 'XLM',
      asset_issuer: 'GISSUER',
    })).toBeNull();
  });
});

// ─── normalizeAmount ──────────────────────────────────────────────────────────

describe('normalizeAmount', () => {
  test('rounds to 7 decimal places', () => {
    expect(normalizeAmount('100.123456789')).toBe(100.1234568);
  });

  test('handles whole numbers', () => {
    expect(normalizeAmount('200')).toBe(200.0);
  });

  test('handles smallest XLM unit', () => {
    expect(normalizeAmount('0.0000001')).toBe(0.0000001);
  });
});

// ─── extractValidPayment ──────────────────────────────────────────────────────

describe('extractValidPayment', () => {
  const validOps = async () => ({
    records: [{ type: 'payment', to: 'GTEST123', amount: '100.0', asset_type: 'native' }],
  });

  test('returns payOp, memo, asset for a valid transaction', async () => {
    const tx = { successful: true, memo: 'STU001', operations: validOps };
    const result = await extractValidPayment(tx);
    expect(result).not.toBeNull();
    expect(result.memo).toBe('STU001');
    expect(result.asset.assetCode).toBe('XLM');
  });

  test('returns null for a failed transaction', async () => {
    const tx = { successful: false, memo: 'STU001', operations: validOps };
    expect(await extractValidPayment(tx)).toBeNull();
  });

  test('returns null when memo is missing', async () => {
    const tx = { successful: true, memo: undefined, operations: validOps };
    expect(await extractValidPayment(tx)).toBeNull();
  });

  test('returns null when memo is blank whitespace', async () => {
    const tx = { successful: true, memo: '   ', operations: validOps };
    expect(await extractValidPayment(tx)).toBeNull();
  });

  test('returns null when no payment op targets school wallet', async () => {
    const tx = {
      successful: true,
      memo: 'STU001',
      operations: async () => ({
        records: [{ type: 'payment', to: 'GOTHER', amount: '100.0', asset_type: 'native' }],
      }),
    };
    expect(await extractValidPayment(tx)).toBeNull();
  });

  test('returns null for unsupported asset', async () => {
    const tx = {
      successful: true,
      memo: 'STU001',
      operations: async () => ({
        records: [{
          type: 'payment',
          to: 'GTEST123',
          amount: '100.0',
          asset_type: 'credit_alphanum4',
          asset_code: 'SHIB',
          asset_issuer: 'GRANDOM',
        }],
      }),
    };
    expect(await extractValidPayment(tx)).toBeNull();
  });
});

// ─── verifyTransaction ────────────────────────────────────────────────────────

describe('verifyTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Student.findOne.mockResolvedValue({ studentId: 'STU001', feeAmount: 200 });
  });

  test('returns payment details with explorerUrl for a valid XLM transaction', async () => {
    mockOperations.mockResolvedValue({
      records: [{ type: 'payment', to: 'GTEST123', amount: '200.0000000', asset_type: 'native' }],
    });
    const result = await verifyTransaction('abc123');
    expect(result).toMatchObject({ hash: 'abc123', memo: 'STU001', amount: 200 });
    expect(result.feeValidation.status).toBe('valid');
    expect(result).toHaveProperty('explorerUrl');
    expect(result.explorerUrl).toContain('abc123');
  });

  test('returns null when no matching payment operation exists', async () => {
    mockOperations.mockResolvedValue({ records: [] });
    expect(await verifyTransaction('abc123')).toBeNull();
  });

  test('returns null when payment is to a different wallet', async () => {
    mockOperations.mockResolvedValue({
      records: [{ type: 'payment', to: 'GOTHER999', amount: '200.0', asset_type: 'native' }],
    });
    expect(await verifyTransaction('abc123')).toBeNull();
  });

  test('returns null for unsupported asset', async () => {
    mockOperations.mockResolvedValue({
      records: [{
        type: 'payment',
        to: 'GTEST123',
        amount: '200.0',
        asset_type: 'credit_alphanum4',
        asset_code: 'SHIB',
        asset_issuer: 'GRANDOM',
      }],
    });
    expect(await verifyTransaction('abc123')).toBeNull();
  });

  test('feeValidation status is unknown when student not found', async () => {
    Student.findOne.mockResolvedValue(null);
    mockOperations.mockResolvedValue({
      records: [{ type: 'payment', to: 'GTEST123', amount: '200.0', asset_type: 'native' }],
    });
    const result = await verifyTransaction('abc123');
    expect(result.feeValidation.status).toBe('unknown');
  });
});

// ─── syncPayments ─────────────────────────────────────────────────────────────

describe('syncPayments', () => {
  test('resolves without error when no transactions exist', async () => {
    await expect(syncPayments()).resolves.toBeUndefined();
  });
});
