'use client';

import { notFound, useParams } from 'next/navigation';
import { UPCOMING_MODULES } from '@/components/shell/nav';
import { Badge, Card, PageHeader } from '@/components/ui';

export default function UpcomingModulePage() {
  const { module } = useParams<{ module: string }>();
  const info = UPCOMING_MODULES[module];
  if (!info) notFound();
  return (
    <>
      <PageHeader title={info.title} actions={<Badge tone="amber">Coming in {info.phase}</Badge>} />
      <Card className="max-w-2xl p-6">
        <p className="mb-3 text-sm text-gray-700">This area is planned. It will include:</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
          {info.features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}
