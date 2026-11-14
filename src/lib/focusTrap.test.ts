// @vitest-environment happy-dom
// Tests for the focus trap of the dialogs.
import { beforeEach, describe, expect, it } from "vitest";
import { focusTrap } from "./focusTrap";

beforeEach(() => {
  document.body.innerHTML = "";
});

function dialog(html: string): HTMLElement {
  document.body.innerHTML = `<button id="opener">Open</button><div data-dialog tabindex="-1">${html}</div>`;
  return document.querySelector<HTMLElement>("[data-dialog]")!;
}

function pressTab(node: HTMLElement, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  node.dispatchEvent(event);
  return event;
}

describe("focusTrap", () => {
  it("focuses the first tabbable element when the dialog opens", () => {
    const node = dialog('<input id="query" /><button id="go">Go</button>');
    focusTrap(node);
    expect(document.activeElement).toBe(node.querySelector("#query"));
  });

  it("wraps Tab from the last element to the first", () => {
    const node = dialog('<button id="one">One</button><button id="two">Two</button>');
    focusTrap(node);
    node.querySelector<HTMLElement>("#two")!.focus();
    const event = pressTab(node);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(node.querySelector("#one"));
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    const node = dialog('<button id="one">One</button><button id="two">Two</button>');
    focusTrap(node);
    const event = pressTab(node, true);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(node.querySelector("#two"));
  });

  it("pulls the focus back when it escaped the dialog", () => {
    const node = dialog('<button id="one">One</button>');
    focusTrap(node);
    document.querySelector<HTMLElement>("#opener")!.focus();
    pressTab(document.querySelector<HTMLElement>("#opener")!);
    expect(document.activeElement).toBe(node.querySelector("#one"));
  });

  it("skips disabled, hidden and untappable elements", () => {
    const node = dialog(
      '<button id="off" disabled>Off</button><input type="hidden" id="hid" /><button id="neg" tabindex="-1">Neg</button><button id="ok">Ok</button>',
    );
    focusTrap(node);
    expect(document.activeElement).toBe(node.querySelector("#ok"));
  });

  it("focuses the dialog itself when nothing inside is tabbable", () => {
    const node = dialog("<p>Nothing to focus</p>");
    focusTrap(node);
    expect(document.activeElement).toBe(node);
    const event = pressTab(node);
    expect(event.defaultPrevented).toBe(true);
  });

  it("gives the focus back to the opener when the dialog closes", () => {
    const node = dialog("<button>Inside</button>");
    const opener = document.querySelector<HTMLElement>("#opener")!;
    opener.focus();
    const trap = focusTrap(node);
    expect(document.activeElement).not.toBe(opener);
    trap.destroy();
    expect(document.activeElement).toBe(opener);
  });
});
