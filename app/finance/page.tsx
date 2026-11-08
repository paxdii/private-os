import type { Metadata } from 'next';
import { FinanceClient } from '@/components/finance/FinanceClient';

export const metadata: Metadata = { title: 'Finanzen' };

export const dynamic = 'force-dynamic';

export default function FinancePage() {
  return <FinanceClient />;
}
