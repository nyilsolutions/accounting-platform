'use client';

import { useRef, useState, type ReactNode } from 'react';
import { cx } from '@/components/ui';

/**
 * Drag and drop, or choose files. On phones, "Take photo" opens the camera (the capture
 * attribute), so receipts can be photographed straight into the app.
 */
export function DropZone({
  onFiles,
  multiple = true,
  camera = false,
  busy,
  children,
  compact,
}: {
  onFiles: (files: File[], source: 'upload' | 'camera') => void;
  multiple?: boolean;
  camera?: boolean;
  busy?: boolean;
  children?: ReactNode;
  compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cam = useRef<HTMLInputElement>(null);
  return (
    <div
      data-testid="drop-zone"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(multiple ? files : files.slice(0, 1), 'upload');
      }}
      className={cx(
        'flex flex-wrap items-center justify-center gap-3 rounded-lg border-2 border-dashed text-sm text-gray-600',
        compact ? 'px-3 py-3' : 'px-4 py-6',
        over ? 'border-brand-500 bg-brand-50' : 'border-gray-300 bg-white',
      )}
    >
      <span>{busy ? 'Uploading…' : (children ?? 'Drag files here, or')}</span>
      <button
        type="button"
        disabled={busy}
        className="font-medium text-brand-700 hover:underline disabled:text-gray-400"
        onClick={() => input.current?.click()}
      >
        choose files
      </button>
      {camera && (
        <button
          type="button"
          disabled={busy}
          className="font-medium text-brand-700 hover:underline disabled:text-gray-400"
          onClick={() => cam.current?.click()}
        >
          take a photo
        </button>
      )}
      <input
        ref={input}
        type="file"
        aria-label="Choose files"
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files, 'upload');
        }}
      />
      {camera && (
        <input
          ref={cam}
          type="file"
          accept="image/*"
          capture="environment"
          aria-label="Take a photo"
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) onFiles(files, 'camera');
          }}
        />
      )}
    </div>
  );
}
