import { useEffect, useRef } from "react";
import { useFocusTrap } from "../lib/focusTrap";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // This component only exists in the tree while the menu is open (the parent conditionally
  // renders it), so the trap is active for its whole mounted lifetime. Moves initial focus
  // into the menu and traps Tab there — previously Tab could escape into the sidebar/editor
  // behind it, and there was no Escape-to-close at all.
  useFocusTrap(menuRef, { active: true, onEscape: onClose });

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    window.addEventListener("mousedown", handleMouseDown);
    return () => window.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" style={{ top: y, left: x }} role="menu" aria-label="Context menu">
      {items.map((item) => (
        <button
          key={item.label}
          className={`context-menu__item${item.danger ? " context-menu__item--danger" : ""}`}
          onClick={() => {
            onClose();
            item.onClick();
          }}
          role="menuitem"
          aria-label={item.label}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
