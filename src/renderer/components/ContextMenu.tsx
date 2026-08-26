import { useEffect, useRef } from "react";

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
