'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Dialog, Field, TextInput } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';

/** Email a document to the customer. */
export function SendDialog({
  open,
  onClose,
  title,
  defaultTo,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  defaultTo: string | null;
  onSend: (input: { to: string; message: string }) => Promise<void>;
}) {
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await onSend({ to: String(f.get('to')), message: String(f.get('message') ?? '') });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <Alert>
            {error instanceof ApiError && !error.errors.length
              ? error.message
              : typeof error === 'string'
                ? error
                : 'Please check the email addresses.'}
          </Alert>
        )}
        <TextInput
          label="To"
          name="to"
          defaultValue={defaultTo ?? ''}
          required
          autoFocus
          error={error instanceof ApiError ? error.fieldError('to') : undefined}
          hint="Separate several addresses with commas."
        />
        <Field label="Message" htmlFor="send-message">
          <textarea
            id="send-message"
            name="message"
            rows={4}
            className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Send
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
