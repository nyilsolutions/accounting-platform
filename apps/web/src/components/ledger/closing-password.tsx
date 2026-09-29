'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Dialog, TextInput } from '@/components/ui';
import { ApiError } from '@/lib/api';

/**
 * Wraps a mutation that may touch a closed period. On a CLOSING_PASSWORD_* error it asks for the
 * closing-date password and retries.
 */
export function useClosingPassword() {
  const [prompt, setPrompt] = useState<{
    message: string;
    retry: (password: string) => Promise<void>;
  } | null>(null);

  async function run(action: (closingPassword?: string) => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && err.code?.startsWith('CLOSING_PASSWORD')) {
        setPrompt({
          message: err.message,
          retry: async (password) => {
            await action(password);
            setPrompt(null);
          },
        });
        return;
      }
      throw err;
    }
  }

  const dialog = (
    <ClosingPasswordDialog
      prompt={prompt}
      onClose={() => setPrompt(null)}
      onRetryError={(message) => prompt && setPrompt({ ...prompt, message })}
    />
  );
  return { run, dialog };
}

function ClosingPasswordDialog({
  prompt,
  onClose,
  onRetryError,
}: {
  prompt: { message: string; retry: (password: string) => Promise<void> } | null;
  onClose: () => void;
  onRetryError: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get('closingPassword') ?? '');
    setPending(true);
    try {
      await prompt!.retry(password);
    } catch (err) {
      onRetryError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={!!prompt} onClose={onClose} title="Closed period">
      <form onSubmit={submit} className="space-y-4">
        <Alert kind="info">{prompt?.message}</Alert>
        <TextInput
          label="Closing date password"
          name="closingPassword"
          type="password"
          autoComplete="off"
          required
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Continue
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
