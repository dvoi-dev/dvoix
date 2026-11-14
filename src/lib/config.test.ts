// Tests for the deferred JSON writes into `.dvoix/`: reading with defaults,
// debouncing many changes into one write, and flushing before the vault closes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: { readConfig: vi.fn(), writeConfig: vi.fn() },
}));

import { api } from "./api";
import { flushConfig, readJson, readJsonRaw, writeJson } from "./config";

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.readConfig).mockResolvedValue(null);
  vi.mocked(api.writeConfig).mockResolvedValue(undefined);
});

afterEach(async () => {
  await flushConfig();
  vi.useRealTimers();
});

describe("readJson", () => {
  it("fills in missing keys from the defaults", async () => {
    vi.mocked(api.readConfig).mockResolvedValue('{"spellcheck": true}');
    const settings = await readJson("app.json", { spellcheck: false, lineNumbers: false });
    expect(settings).toEqual({ spellcheck: true, lineNumbers: false });
  });

  it("returns the defaults when the file is missing", async () => {
    vi.mocked(api.readConfig).mockResolvedValue(null);
    expect(await readJson("app.json", { a: 1 })).toEqual({ a: 1 });
  });

  it("returns the defaults for broken JSON or a non-object", async () => {
    vi.mocked(api.readConfig).mockResolvedValue("{not json");
    expect(await readJson("app.json", { a: 1 })).toEqual({ a: 1 });
    vi.mocked(api.readConfig).mockResolvedValue("[1, 2]");
    expect(await readJson("app.json", { a: 1 })).toEqual({ a: 1 });
  });

  it("does not share the defaults object between reads", async () => {
    const defaults = { a: 1 };
    const first = await readJson("app.json", defaults);
    first.a = 2;
    expect(defaults.a).toBe(1);
  });
});

describe("readJsonRaw", () => {
  it("parses any JSON value", async () => {
    vi.mocked(api.readConfig).mockResolvedValue('{"paths": ["a.md"]}');
    expect(await readJsonRaw("workspace.json")).toEqual({ paths: ["a.md"] });
  });

  it("returns undefined for missing files, broken JSON and errors", async () => {
    vi.mocked(api.readConfig).mockResolvedValue(null);
    expect(await readJsonRaw("workspace.json")).toBeUndefined();
    vi.mocked(api.readConfig).mockResolvedValue("oops");
    expect(await readJsonRaw("workspace.json")).toBeUndefined();
    vi.mocked(api.readConfig).mockRejectedValue(new Error("no vault"));
    expect(await readJsonRaw("workspace.json")).toBeUndefined();
  });
});

describe("writeJson", () => {
  it("turns many changes in a row into one write of the last value", async () => {
    writeJson("app.json", { a: 1 });
    await vi.advanceTimersByTimeAsync(200);
    writeJson("app.json", { a: 2 });
    await vi.advanceTimersByTimeAsync(299);
    expect(api.writeConfig).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.writeConfig).toHaveBeenCalledTimes(1);
    expect(api.writeConfig).toHaveBeenCalledWith("app.json", '{\n  "a": 2\n}\n');
  });

  it("writes different files independently", async () => {
    writeJson("app.json", { a: 1 });
    writeJson("appearance.json", { theme: "dark" });
    await vi.advanceTimersByTimeAsync(300);
    expect(api.writeConfig).toHaveBeenCalledTimes(2);
    expect(api.writeConfig).toHaveBeenCalledWith("app.json", '{\n  "a": 1\n}\n');
    expect(api.writeConfig).toHaveBeenCalledWith("appearance.json", '{\n  "theme": "dark"\n}\n');
  });

  it("reports a failed write without throwing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(api.writeConfig).mockRejectedValueOnce(new Error("disk full"));
    writeJson("app.json", { a: 1 });
    await vi.advanceTimersByTimeAsync(300);
    expect(logged).toHaveBeenCalled();
  });
});

describe("flushConfig", () => {
  it("writes everything pending right away", async () => {
    writeJson("app.json", { a: 1 });
    writeJson("workspace.json", { panel: "files" });
    await flushConfig();
    expect(api.writeConfig).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(api.writeConfig).toHaveBeenCalledTimes(2);
  });

  it("accepts new writes after a flush", async () => {
    writeJson("app.json", { a: 1 });
    await flushConfig();
    writeJson("app.json", { a: 2 });
    await vi.advanceTimersByTimeAsync(300);
    expect(api.writeConfig).toHaveBeenCalledTimes(2);
    expect(api.writeConfig).toHaveBeenLastCalledWith("app.json", '{\n  "a": 2\n}\n');
  });
});
