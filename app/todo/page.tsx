import type { Metadata } from 'next';
import Planner from './planner';

export const metadata: Metadata = { title: 'Planer' };

export default function TodoPage() {
  return <Planner />;
}
