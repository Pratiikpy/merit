import { defineConfig, configDefaults } from "vitest/config";

/**
 * Unit/integration tests only.
 *
 * The Playwright end-to-end suite lives in `e2e/` and is run by `npm run e2e`, not by vitest —
 * its specs import `@playwright/test`, whose `test.describe()` throws if vitest collects it.
 * Without this exclusion vitest globs `e2e/**\/*.spec.ts` and reports a failed test file.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
