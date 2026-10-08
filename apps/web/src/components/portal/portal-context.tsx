'use client';

import { createContext, useContext } from 'react';
import type { MyPortalLinkDto } from '@acct/shared';

/** The signed-in person's link in the company the portal pages are for. */
export const PortalLinkContext = createContext<MyPortalLinkDto | null>(null);

export function usePortalLink(): MyPortalLinkDto {
  const link = useContext(PortalLinkContext);
  if (!link) throw new Error('usePortalLink outside a company portal');
  return link;
}

/** `/api/portal/c/<company><path>` for the portal's own API. */
export const portalApi = (companyId: string, path: string) => `/portal/c/${companyId}${path}`;
