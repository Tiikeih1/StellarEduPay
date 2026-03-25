/**
 * TransactionCard – displays a single payment record with normalized asset info.
 */
export default function TransactionCard({ payment }) {
  const {
    txHash,
    amount,
    assetCode = 'XLM',
    confirmedAt,
    studentId,
    explorerUrl,
  } = payment;

  const formattedAmount = `${parseFloat(amount).toFixed(7)} ${assetCode}`;
  const formattedDate = confirmedAt ? new Date(confirmedAt).toLocaleString() : '—';

  return (
    <div
      style={{
        border: '1px solid #ddd',
        borderRadius: 8,
        padding: '0.75rem 1rem',
        marginBottom: '0.5rem',
        fontFamily: 'sans-serif',
      }}
    >
      <p style={{ margin: 0 }}>
        <strong>Amount:</strong> {formattedAmount}
      </p>
      <p style={{ margin: '0.25rem 0', fontSize: '0.85rem', color: '#555' }}>
        <strong>Tx:</strong>{' '}
        <code style={{ wordBreak: 'break-all', fontSize: '0.8rem' }}>{txHash}</code>
      </p>
      {explorerUrl && (
        <p style={{ margin: '0.25rem 0', fontSize: '0.85rem' }}>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#1a73e8' }}
          >
            View on Stellar Explorer ↗
          </a>
        </p>
      )}
      <p style={{ margin: 0, fontSize: '0.85rem', color: '#888' }}>
        {formattedDate} — Student {studentId}
      </p>
    </div>
  );
}
