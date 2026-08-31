/**
 * Utility for managing focus within modal dialogs.
 * Ensures focus stays within the modal and returns to the triggering element on close.
 */

import React from "react";

export interface FocusTrapOptions {
  initialFocus?: HTMLElement;
  returnFocus?: HTMLElement;
  onEscape?: () => void;
}

export class FocusTrap {
  private element: HTMLElement;
  private previousActiveElement: Element | null;
  private options: FocusTrapOptions;
  private keydownHandler: (e: KeyboardEvent) => void;

  constructor(element: HTMLElement, options: FocusTrapOptions = {}) {
    this.element = element;
    this.options = options;
    this.previousActiveElement = document.activeElement;
    this.keydownHandler = this.handleKeydown.bind(this);
  }

  private getFocusableElements(): HTMLElement[] {
    const selector = [
      'button:not([disabled]):not([aria-hidden])',
      'input:not([disabled]):not([aria-hidden])',
      'textarea:not([disabled]):not([aria-hidden])',
      '[tabindex]:not([tabindex="-1"]):not([aria-hidden])',
      '[role="button"]:not([aria-disabled="true"])',
      '[role="menuitem"]:not([aria-disabled="true"])',
    ].join(',');

    return Array.from(this.element.querySelectorAll(selector)) as HTMLElement[];
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.options.onEscape?.();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusableElements = this.getFocusableElements();
    if (focusableElements.length === 0) return;

    const activeElement = document.activeElement as HTMLElement;
    const activeIndex = focusableElements.indexOf(activeElement);

    if (event.shiftKey) {
      // Shift+Tab: move backward
      if (activeIndex <= 0) {
        event.preventDefault();
        focusableElements[focusableElements.length - 1]?.focus();
      }
    } else {
      // Tab: move forward
      if (activeIndex >= focusableElements.length - 1) {
        event.preventDefault();
        focusableElements[0]?.focus();
      }
    }
  }

  activate(): void {
    // Set initial focus
    const focusableElements = this.getFocusableElements();
    const elementToFocus = this.options.initialFocus || focusableElements[0];
    if (elementToFocus) {
      elementToFocus.focus();
    }

    // Add keyboard listener
    this.element.addEventListener('keydown', this.keydownHandler);

    // Hide other content from screen readers
    document.querySelectorAll('body > *:not(.modal-backdrop):not([role="dialog"])').forEach((el) => {
      if (el !== this.element && !el.contains(this.element)) {
        el.setAttribute('aria-hidden', 'true');
      }
    });
  }

  deactivate(): void {
    // Remove keyboard listener
    this.element.removeEventListener('keydown', this.keydownHandler);

    // Restore aria-hidden
    document.querySelectorAll('[aria-hidden="true"]').forEach((el) => {
      el.removeAttribute('aria-hidden');
    });

    // Return focus to an explicit target if one was given, otherwise to whatever had focus
    // before the trap activated (e.g. the button that opened this modal/menu).
    const target = this.options.returnFocus ?? this.previousActiveElement;
    if (target instanceof HTMLElement) {
      target.focus();
    }
  }
}

/**
 * React hook for managing focus trap in modals
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  options: FocusTrapOptions & { active: boolean },
): void {
  // Read via a ref rather than depending on `options` directly: a fresh object literal is
  // passed on every render from call sites, and depending on it by reference would
  // re-activate the trap (re-capturing previousActiveElement, re-running activate()'s
  // initial-focus logic) on every render while active, not just when it actually opens.
  // The ref object itself is never replaced, only mutated in a layout effect (refs can't be
  // written during render) — FocusTrap holds a reference to this same object, so mutating
  // it in place keeps its view of onEscape/initialFocus/returnFocus current without needing
  // to reconstruct (and thus re-activate) the trap.
  const optionsRef = React.useRef(options);
  React.useLayoutEffect(() => {
    Object.assign(optionsRef.current, options);
  });

  React.useEffect(() => {
    if (!ref.current || !optionsRef.current.active) return;
    const trap = new FocusTrap(ref.current, optionsRef.current);
    trap.activate();
    return () => trap.deactivate();
  }, [ref, options.active]);
}
