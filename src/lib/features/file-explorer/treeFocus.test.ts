// The tree only takes the keyboard focus once per explicit request.
import { describe, expect, it } from "vitest";
import { treeFocus } from "./treeFocus.svelte";

describe("treeFocus", () => {
  it("clears a focus request once the row has focused itself", () => {
    treeFocus.focus("notes/a.md");
    expect(treeFocus.path).toBe("notes/a.md");
    expect(treeFocus.pending).toBe("notes/a.md");
    treeFocus.done("notes/a.md");
    expect(treeFocus.pending).toBeNull();
    expect(treeFocus.path).toBe("notes/a.md");
  });

  it("keeps a newer request when an older row reports back", () => {
    treeFocus.focus("a.md");
    treeFocus.focus("b.md");
    treeFocus.done("a.md");
    expect(treeFocus.pending).toBe("b.md");
  });
});
