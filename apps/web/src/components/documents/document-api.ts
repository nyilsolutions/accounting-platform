'use client';

import type { DocumentDto, DocumentEntityType, DocumentUrlDto } from '@acct/shared';
import { api, ApiError } from '@/lib/api';

export interface UploadOptions {
  folderId?: string | null;
  entityType?: DocumentEntityType;
  entityId?: string;
  inbox?: boolean;
  source?: 'upload' | 'camera';
}

/** Uploads one file as the raw request body (details in the query string). */
export async function uploadDocument(
  companyId: string,
  file: File,
  opts: UploadOptions = {},
): Promise<DocumentDto> {
  const qs = new URLSearchParams({ fileName: file.name || 'photo.jpg' });
  if (opts.folderId) qs.set('folderId', opts.folderId);
  if (opts.entityType && opts.entityId) {
    qs.set('entityType', opts.entityType);
    qs.set('entityId', opts.entityId);
  }
  if (opts.inbox) qs.set('inbox', 'true');
  if (opts.source) qs.set('source', opts.source);
  return rawPost<DocumentDto>(`/companies/${companyId}/documents?${qs}`, file);
}

export async function uploadVersion(
  companyId: string,
  documentId: string,
  file: File,
): Promise<DocumentDto> {
  return rawPost<DocumentDto>(
    `/companies/${companyId}/documents/${documentId}/versions?${new URLSearchParams({ fileName: file.name })}`,
    file,
  );
}

async function rawPost<T>(path: string, file: File): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-protection': '1', 'content-type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      res.status === 413
        ? 'The file is too large.'
        : Array.isArray(data.message)
          ? data.message.join(', ')
          : (data.message ?? res.statusText);
    throw new ApiError(res.status, message, data.code, data.errors ?? []);
  }
  return data as T;
}

/** A short-lived link to the file (issued after the permission check). */
export async function documentUrl(
  companyId: string,
  documentId: string,
  disposition: 'inline' | 'attachment',
  version?: number,
): Promise<string> {
  const qs = new URLSearchParams({ disposition });
  if (version) qs.set('version', String(version));
  return (await api<DocumentUrlDto>(`/companies/${companyId}/documents/${documentId}/url?${qs}`))
    .url;
}

export async function downloadDocument(
  companyId: string,
  documentId: string,
  version?: number,
): Promise<void> {
  const url = await documentUrl(companyId, documentId, 'attachment', version);
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function downloadZip(companyId: string, ids: string[]): Promise<void> {
  const res = await fetch(`/api/companies/${companyId}/documents/download`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-protection': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.message ?? res.statusText);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `documents-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 104.8576)) / 10} MB`;
}
