'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Dialog, TextInput } from '@/components/ui';
import { api, errorMessage, setStepUpHandler } from '@/lib/api';

/**
 * Asks for a fresh authenticator code when the API says a sensitive action needs one (step-up,
 * ADR 0029); the request that needed it is then sent again by `api()`.
 */
export function StepUpPrompt() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current?.(false);
          resolver.current = resolve;
          setError(null);
          setOpen(true);
        }),
    );
    return () => setStepUpHandler(null);
  }, []);

  function finish(ok: boolean) {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
    setPending(false);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    setPending(true);
    setError(null);
    try {
      await api('/auth/step-up', { method: 'POST', body: { code } });
      finish(true);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onClose={() => finish(false)} title="Confirm it's you">
      <form onSubmit={onSubmit} className="space-y-4" data-testid="step-up">
        <p className="text-sm text-gray-600">
          This action needs a fresh code from your authenticator app.
        </p>
        {error && <Alert>{error}</Alert>}
        <TextInput
          label="Authentication code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Confirm
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
