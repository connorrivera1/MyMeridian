import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],

    /*
     * One test in series.test.ts sweeps every hour-of-day across both DST
     * transitions and legitimately costs ~1s. At the 5s default it passed
     * alone and timed out under load, which reads as a broken build rather
     * than a busy machine.
     */
    testTimeout: 20_000,

    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],

      /*
       * Scoped to what the suite actually targets: the pure engine, the
       * server-side libraries and the data layer.
       *
       * `.tsx` is excluded because `include` above only collects `.test.ts` —
       * no component is ever rendered, so every route and every design-system
       * file would report as uncovered and drag the number to noise. That is a
       * real gap (there are no component or end-to-end tests at all), but it
       * is a gap to fix by writing those tests, not by letting them distort
       * the one signal that does mean something.
       */
      include: ["app/engine/**/*.ts", "app/lib/**/*.ts", "app/data/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],

      /*
       * Floors, not targets — set just under the measured numbers so the build
       * fails on regression rather than on ambition. Raise them when they are
       * comfortably exceeded; never lower them to make a build pass.
       */
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 82,
        lines: 80,
      },
    },
  },
});
