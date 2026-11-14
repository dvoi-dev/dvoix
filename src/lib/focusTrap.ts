// Focus trap for dialogs: while one is open, Tab and Shift+Tab stay inside
// it, and closing it gives the focus back to the element that opened it.
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

function tabbable(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.tabIndex < 0 || el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

export function focusTrap(node: HTMLElement): { destroy: () => void } {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  (tabbable(node)[0] ?? node).focus();

  function keydown(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    const items = tabbable(node);
    if (!items.length) {
      e.preventDefault();
      node.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const outside = active === node || !node.contains(active);
    if (e.shiftKey && (active === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("keydown", keydown, true);
  return {
    destroy() {
      document.removeEventListener("keydown", keydown, true);
      previous?.focus();
    },
  };
}
