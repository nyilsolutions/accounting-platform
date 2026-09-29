'use client';

import { useMemo, useState } from 'react';
import { Dialog, cx } from '@/components/ui';

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  function close() {
    setQuery('');
    setActive(0);
    onClose();
  }

  function run(cmd: Command | undefined) {
    if (!cmd) return;
    close();
    cmd.run();
  }

  return (
    <Dialog open={open} onClose={close} title="Go to…">
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            run(results[active]);
          }
        }}
        placeholder="Search pages and companies…"
        aria-label="Search commands"
        className="mb-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
      <ul className="max-h-80 overflow-y-auto" role="listbox">
        {results.map((c, i) => (
          <li key={c.id} role="option" aria-selected={i === active}>
            <button
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
              className={cx(
                'flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm',
                i === active ? 'bg-brand-50 text-brand-900' : 'text-gray-700',
              )}
            >
              <span>
                <span className="mr-2 text-xs uppercase tracking-wide text-gray-400">
                  {c.group}
                </span>
                {c.label}
              </span>
              {c.hint && <span className="text-xs text-gray-400">{c.hint}</span>}
            </button>
          </li>
        ))}
        {results.length === 0 && <li className="px-3 py-2 text-sm text-gray-500">No matches</li>}
      </ul>
    </Dialog>
  );
}
