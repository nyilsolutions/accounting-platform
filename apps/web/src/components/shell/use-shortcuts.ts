'use client';

import { useEffect, useRef } from 'react';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Global keyboard shortcuts:
 *   Ctrl/⌘+K  command palette      ?  shortcut help      g then <key>  go to a page
 * Single-key shortcuts are ignored while typing in a field.
 */
export function useShortcuts(handlers: {
  onPalette: () => void;
  onHelp: () => void;
  onGo: (key: string) => void;
}): void {
  const pendingG = useRef<number | null>(null);
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current.onPalette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;

      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        e.preventDefault();
        ref.current.onGo(e.key.toLowerCase());
        return;
      }
      if (e.key === 'g') {
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 1200);
      } else if (e.key === '?') {
        e.preventDefault();
        ref.current.onHelp();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
