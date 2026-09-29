'use client';

import type { ReactNode } from 'react';
import { Badge, Button, Card } from '@/components/ui';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

/** Table used by the name/item lists: search, include-inactive, edit and activate actions. */
export function ListTable<T extends { id: string; isActive: boolean; depth?: number }>({
  rows,
  columns,
  search,
  onSearch,
  showInactive,
  onShowInactive,
  onNew,
  newLabel,
  onEdit,
  onToggleActive,
  empty,
}: {
  rows: T[];
  columns: Column<T>[];
  search: string;
  onSearch: (v: string) => void;
  showInactive: boolean;
  onShowInactive: (v: boolean) => void;
  onNew?: () => void;
  newLabel: string;
  onEdit?: (row: T) => void;
  onToggleActive?: (row: T) => void;
  empty: string;
}) {
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search list"
            className="w-64 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => onShowInactive(e.target.checked)}
            />{' '}
            Include inactive
          </label>
        </div>
        {onNew && <Button onClick={onNew}>{newLabel}</Button>}
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                {columns.map((c) => (
                  <th key={c.header} className={`px-4 py-2 ${c.className ?? ''}`}>
                    {c.header}
                  </th>
                ))}
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id} className={r.isActive ? '' : 'text-gray-400'}>
                  {columns.map((c, i) => (
                    <td
                      key={c.header}
                      className={`px-4 py-2 ${c.className ?? ''}`}
                      style={
                        i === 0 && r.depth ? { paddingLeft: `${1 + r.depth * 1.25}rem` } : undefined
                      }
                    >
                      {c.cell(r)} {i === 0 && !r.isActive && <Badge>Inactive</Badge>}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    {onEdit && (
                      <button
                        className="mr-3 text-brand-700 hover:underline"
                        onClick={() => onEdit(r)}
                      >
                        Edit
                      </button>
                    )}
                    {onToggleActive && (
                      <button
                        className="text-gray-600 hover:underline"
                        onClick={() => onToggleActive(r)}
                      >
                        {r.isActive ? 'Make inactive' : 'Make active'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} className="px-4 py-8 text-center text-gray-500">
                    {empty}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
