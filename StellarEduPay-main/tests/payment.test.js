/**
 * Integration tests for the Express API routes.
 * All DB models and Stellar service are mocked — no real network or DB needed.
 */

process.env.NODE_ENV = 'test';
process.env.SCHOOL_WALLET_ADDRESS = 'GTEST123';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';

const request = require('supertest');

// ─── Model mocks ─────────────────────────────────────────────────────────────

jest.mock('../backend/src/models/studentModel', () => ({
  create: jest.fn().mockResolvedValue({
    studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200, feePaid: false,
  }),
  find: jest.fn().mockReturnValue({
    sort: jest.fn().mockResolvedValue([
      { studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200, feePaid: false },
    ]),
  }),
  findOne: jest.fn().mockResolvedValue({
    studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200, feePaid: false,
  }),
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  find: jest.fn().mockReturnValue({
    sort: jest.fn().mockResolvedValue([
      { studentId: 'STU001', txHash: 'abc123', amount: 200, toObject: () => ({ studentId: 'STU001', txHash: 'abc123', amount: 200 }) },
    ]),
  }),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock('../backend/src/models/feeStructureModel', () => {
  const fees = {
    '5A': { className: '5A', feeAmount: 200, description: 'Class 5A fees', academicYear: '2026', isActive: true },
    '6B': { className: '6B', feeAmount: 300, description: 'Class 6B fees', academicYear: '2026', isActive: true },
  };
  return {
    create: jest.fn().mockResolvedValue(fees['5A']),
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockResolvedValue(Object.values(fees)),
    }),
    findOne: jest.fn().mockImplementation(({ className }) =>
      Promise.resolve(fees[className] || null)
    ),
    findOneAndUpdate: jest.fn().mockImplementation((query, update) =>
      Promise.resolve({ className: query.className, ...update })
    ),
  };
});

jest.mock('../backend/src/models/paymentIntentModel', () => ({
  create: jest.fn().mockResolvedValue({
    studentId: 'STU001', amount: 200, memo: 'ABCD1234', status: 'pending',
  }),
  findOne: jest.fn().mockResolvedValue({
    _id: 'intent123', studentId: 'STU001', amount: 200, memo: 'ABCD1234', status: 'pending',
  }),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connect: jest.fn().mockResolvedValue(true),
  };
});

// ─── Stellar service mock ─────────────────────────────────────────────────────

jest.mock('../backend/src/services/stellarService', () => ({
  syncPayments: jest.fn().mockResolvedValue(undefined),
  verifyTransaction: jest.fn().mockResolvedValue({
    hash: 'abc123',
    memo: 'STU001',
    amount: 200,
    expectedAmount: 200,
    feeValidation: { status: 'valid', message: 'Payment matches the required fee' },
    date: new Date().toISOString(),
    explorerUrl: 'https://stellar.expert/explorer/testnet/tx/abc123',
  }),
  recordPayment: jest.fn().mockResolvedValue({}),
  finalizeConfirmedPayments: jest.fn().mockResolvedValue(undefined),
}));

// ─── Transaction service mock (prevents background polling in tests) ──────────

jest.mock('../backend/src/services/transactionService', () => ({
  startPolling: jest.fn(),
  stopPolling: jest.fn(),
}));

// ─── Config mock ──────────────────────────────────────────────────────────────

jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GTEST123',
  ACCEPTED_ASSETS: {
    XLM:  { code: 'XLM',  type: 'native',          issuer: null,     displayName: 'Stellar Lumens' },
    USDC: { code: 'USDC', type: 'credit_alphanum4', issuer: 'GISSUER', displayName: 'USD Coin' },
  },
  isAcceptedAsset: (code, type) => {
    const map = { XLM: 'native', USDC: 'credit_alphanum4' };
    if (map[code] && map[code] === type) return { accepted: true };
    return { accepted: false, asset: null };
  },
  getExplorerUrl: (txHash) => `https://stellar.expert/explorer/testnet/tx/${txHash}`,
}));

const app = require('../backend/src/app');

// ─── Student API ──────────────────────────────────────────────────────────────

describe('Student API', () => {
  test('POST /api/students — creates a student', async () => {
    const res = await request(app).post('/api/students').send({
      studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200,
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('studentId', 'STU001');
    expect(res.body).toHaveProperty('feeAmount', 200);
  });

  test('GET /api/students — returns all students', async () => {
    const res = await request(app).get('/api/students');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/students/:studentId — returns a student', async () => {
    const res = await request(app).get('/api/students/STU001');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ studentId: 'STU001', feeAmount: 200 });
  });

  test('GET /api/students/:studentId — 404 for unknown student', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/students/UNKNOWN1');
    expect(res.status).toBe(404);
  });
});

// ─── Payment API ──────────────────────────────────────────────────────────────

describe('Payment API', () => {
  test('GET /api/payments/instructions/:studentId — returns wallet and memo', async () => {
    const res = await request(app).get('/api/payments/instructions/STU001');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('memo', 'STU001');
    expect(res.body).toHaveProperty('walletAddress');
    expect(res.body).toHaveProperty('note');
    expect(res.body.acceptedAssets.some(a => a.code === 'XLM')).toBe(true);
  });

  test('GET /api/payments/:studentId — returns payment history with explorerUrl', async () => {
    const res = await request(app).get('/api/payments/STU001');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('txHash', 'abc123');
    expect(res.body[0]).toHaveProperty('explorerUrl');
    expect(res.body[0].explorerUrl).toContain('abc123');
  });

  test('POST /api/payments/sync — returns success message', async () => {
    const res = await request(app).post('/api/payments/sync');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message', 'Sync complete');
  });

  test('POST /api/payments/verify — returns transaction details with explorerUrl', async () => {
    // Use a valid 64-char hex hash to pass middleware validation
    const txHash = 'a'.repeat(64);
    const { verifyTransaction } = require('../backend/src/services/stellarService');
    verifyTransaction.mockResolvedValueOnce({
      hash: txHash,
      memo: 'STU001',
      amount: 200,
      expectedAmount: 200,
      feeValidation: { status: 'valid', message: 'Payment matches the required fee' },
      date: new Date().toISOString(),
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    });
    const res = await request(app).post('/api/payments/verify').send({ txHash });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hash', txHash);
    expect(res.body.feeValidation.status).toBe('valid');
    expect(res.body).toHaveProperty('explorerUrl');
  });

  test('POST /api/payments/verify — 409 for duplicate transaction', async () => {
    const Payment = require('../backend/src/models/paymentModel');
    Payment.findOne.mockResolvedValueOnce({ txHash: 'a'.repeat(64) });
    const res = await request(app).post('/api/payments/verify').send({ txHash: 'a'.repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('code', 'DUPLICATE_TX');
  });

  test('POST /api/payments/verify — 400 for invalid txHash format', async () => {
    const res = await request(app).post('/api/payments/verify').send({ txHash: 'short' });
    expect(res.status).toBe(400);
  });

  test('GET /api/payments/accepted-assets — returns XLM and USDC', async () => {
    const res = await request(app).get('/api/payments/accepted-assets');
    expect(res.status).toBe(200);
    expect(res.body.assets.map(a => a.code)).toEqual(expect.arrayContaining(['XLM', 'USDC']));
  });
});

// ─── Fee Structure API ────────────────────────────────────────────────────────

describe('Fee Structure API', () => {
  test('POST /api/fees — creates a fee structure', async () => {
    const res = await request(app).post('/api/fees').send({ className: '5A', feeAmount: 200 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ className: '5A', feeAmount: 200 });
  });

  test('POST /api/fees — 400 when required fields missing', async () => {
    const res = await request(app).post('/api/fees').send({ description: 'No class' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('GET /api/fees — returns all fee structures', async () => {
    const res = await request(app).get('/api/fees');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/fees/:className — returns fee for class', async () => {
    const res = await request(app).get('/api/fees/5A');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ className: '5A', feeAmount: 200 });
  });

  test('GET /api/fees/:className — 404 for unknown class', async () => {
    const res = await request(app).get('/api/fees/UNKNOWN');
    expect(res.status).toBe(404);
  });
});

// ─── Payment Intent API ───────────────────────────────────────────────────────

describe('Payment Intent API', () => {
  test('POST /api/payments/intent — creates a payment intent', async () => {
    const res = await request(app).post('/api/payments/intent').send({ studentId: 'STU001' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('memo');
    expect(res.body).toHaveProperty('amount', 200);
    expect(res.body).toHaveProperty('studentId', 'STU001');
  });

  test('POST /api/payments/intent — 404 for unknown student', async () => {
    const Student = require('../backend/src/models/studentModel');
    Student.findOne.mockResolvedValueOnce(null);
    const res = await request(app).post('/api/payments/intent').send({ studentId: 'UNKNOWN1' });
    expect(res.status).toBe(404);
  });
});

// ─── Full payment flow ────────────────────────────────────────────────────────

describe('Full payment flow', () => {
  test('Step 1 — register student', async () => {
    const res = await request(app).post('/api/students').send({
      studentId: 'STU001', name: 'Alice', class: '5A', feeAmount: 200,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ studentId: 'STU001', feeAmount: 200 });
  });

  test('Step 2 — get payment instructions', async () => {
    const res = await request(app).get('/api/payments/instructions/STU001');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('memo', 'STU001');
    expect(res.body.acceptedAssets.some(a => a.code === 'XLM')).toBe(true);
  });

  test('Step 3 — payment history reflects the transaction', async () => {
    const res = await request(app).get('/api/payments/STU001');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('txHash', 'abc123');
    expect(res.body[0]).toHaveProperty('explorerUrl');
  });
});
