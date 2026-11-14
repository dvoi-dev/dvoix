// Unit tests for the frontend: pure logic and rune state, without a Tauri
// window. The Svelte plugin compiles the `.svelte.ts` state modules so their
// runes work outside a component.
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
