'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { authRedirect } from '@/lib/auth-gate';
import { useMe } from '@/lib/queries';

export default function Home() {
  const router = useRouter();
  const me = useMe();
  useEffect(() => {
    if (me.isSuccess) router.replace(authRedirect(me.data) ?? '/companies');
  }, [me.isSuccess, me.data, router]);
  return <Spinner />;
}
