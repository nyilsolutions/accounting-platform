import { STEP_UP_REQUIRED } from '@acct/shared';

export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly errors: FieldError[] = [],
  ) {
    super(message);
  }

  fieldError(path: string): string | undefined {
    return this.errors.find((e) => e.path === path)?.message;
  }
}

/**
 * Sensitive actions answer 403 STEP_UP_REQUIRED when the last MFA code is too old (ADR 0029).
 * The app registers a prompt (`StepUpPrompt`) that asks for a fresh code; the request is then
 * sent once more. Without a prompt, or if it is cancelled, the 403 stands.
 */
let stepUpHandler: (() => Promise<boolean>) | null = null;
export function setStepUpHandler(handler: (() => Promise<boolean>) | null): void {
  stepUpHandler = handler;
}

/** Sends a request; on a step-up 403, asks for a fresh code and sends it once more. */
async function send(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`/api${path}`, init);
  if (res.status !== 403 || !stepUpHandler) return res;
  const data = await res
    .clone()
    .json()
    .catch(() => ({}));
  if (data.code !== STEP_UP_REQUIRED || !(await stepUpHandler())) return res;
  return fetch(`/api${path}`, init);
}

/** Fetches the API through the same-origin /api proxy. Sends the CSRF header on every call. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await send(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      'x-csrf-protection': '1',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = Array.isArray(data.message)
      ? data.message.join(', ')
      : (data.message ?? res.statusText);
    throw new ApiError(res.status, message, data.code, data.errors ?? []);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

/**
 * Downloads a file from the API (a GET export, or a POST with a JSON body) and saves it under the
 * name the server gives in Content-Disposition.
 */
export async function downloadFile(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<void> {
  const res = await send(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      'x-csrf-protection': '1',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.message ?? res.statusText, data.code, data.errors ?? []);
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'report';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
