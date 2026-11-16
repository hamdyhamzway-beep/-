import { useEffect } from 'react';

/**
 * Registers an Escape key handler only while a modal or lightbox is open.
 */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onEscape();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, onEscape]);
}
