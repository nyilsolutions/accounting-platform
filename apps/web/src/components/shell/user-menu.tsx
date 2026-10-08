'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMe } from '@/lib/queries';

export function UserMenu({ dark }: { dark?: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const router = useRouter();

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    qc.clear();
    router.replace('/login');
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={dark ? 'text-gray-200' : 'text-gray-700'}>{me.data?.user.fullName}</span>
      <button
        onClick={signOut}
        className={dark ? 'text-gray-300 hover:text-white' : 'text-gray-600 hover:text-gray-900'}
        data-testid="sign-out"
      >
        Sign out
      </button>
    </div>
  );
}
