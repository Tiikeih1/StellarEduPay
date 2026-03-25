import Link from 'next/link';

export default function Home() {
  return (
    <div style={{ maxWidth: 600, margin: '4rem auto', fontFamily: 'sans-serif', textAlign: 'center' }}>
      <h1>StellarEduPay</h1>
      <p>Transparent school fee payments on the Stellar blockchain.</p>
      <Link href="/pay-fees">
        <button style={{ padding: '0.75rem 2rem', fontSize: '1rem', cursor: 'pointer' }}>
          Pay School Fees
        </button>
      </Link>
    </div>
  );
}
