// Tests for attachment naming and embed parsing: the rules that decide what
// is an image, how `![[…]]` is split and how a folder typed by the user is
// made vault-relative. No Tauri window and no file reads.
import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ api: { readBinary: vi.fn() } }));
vi.mock("./vault.svelte", () => ({
  vault: { resolveLink: vi.fn(() => null), entryAt: vi.fn(() => undefined) },
}));

import { cleanFolder, extensionOf, folderOf, isImage, parseEmbed } from "./attachments";

describe("extensionOf", () => {
  it("uses the last dot and lower-cases the extension", () => {
    expect(extensionOf("photo.PNG")).toBe("png");
    expect(extensionOf("folder/archive.tar.gz")).toBe("gz");
    expect(extensionOf("no-extension")).toBe("");
    expect(extensionOf(".hidden")).toBe("");
    expect(extensionOf("a/b/.hidden.MD")).toBe("md");
  });
});

describe("isImage", () => {
  it("knows the image types the webview can show", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]) {
      expect(isImage(`x.${ext}`)).toBe(true);
      expect(isImage(`x.${ext.toUpperCase()}`)).toBe(true);
    }
    expect(isImage("note.md")).toBe(false);
    expect(isImage("doc.pdf")).toBe(false);
  });
});

describe("parseEmbed", () => {
  it("takes a plain file name", () => {
    expect(parseEmbed("photo.png")).toEqual({ target: "photo.png", heading: undefined, width: undefined });
  });

  it("takes a heading and a width", () => {
    expect(parseEmbed("Note#Section")).toEqual({ target: "Note", heading: "Section", width: undefined });
    expect(parseEmbed("photo.png|300")).toEqual({ target: "photo.png", heading: undefined, width: 300 });
    expect(parseEmbed("photo.png|300x200")).toEqual({ target: "photo.png", heading: undefined, width: 300 });
    expect(parseEmbed("Note#Section|120")).toEqual({ target: "Note", heading: "Section", width: 120 });
  });

  it("ignores a size that is not a number and trims the parts", () => {
    expect(parseEmbed(" photo.png | wide ")).toEqual({ target: "photo.png", heading: undefined, width: undefined });
    expect(parseEmbed(" Note # Section ")).toEqual({ target: "Note", heading: "Section", width: undefined });
  });

  it("keeps a pipe inside the heading after the first one", () => {
    expect(parseEmbed("a#b|c")).toEqual({ target: "a", heading: "b", width: undefined });
  });
});

describe("cleanFolder", () => {
  it("removes leading, trailing and double slashes", () => {
    expect(cleanFolder("/a/b/")).toBe("a/b");
    expect(cleanFolder("a//b")).toBe("a/b");
    expect(cleanFolder("  a / b  ")).toBe("a/b");
  });

  it("accepts Windows separators and drops dot segments", () => {
    expect(cleanFolder("a\\b\\c")).toBe("a/b/c");
    expect(cleanFolder("./a/../b")).toBe("a/b");
    expect(cleanFolder("a//./b//")).toBe("a/b");
  });

  it("turns an empty or unusable value into the vault root", () => {
    expect(cleanFolder("")).toBe("");
    expect(cleanFolder("/")).toBe("");
    expect(cleanFolder("..")).toBe("");
  });
});

describe("folderOf", () => {
  it("returns the folder of a path", () => {
    expect(folderOf("a/b/c.md")).toBe("a/b");
    expect(folderOf("c.md")).toBe("");
    expect(folderOf(null)).toBe("");
  });
});
