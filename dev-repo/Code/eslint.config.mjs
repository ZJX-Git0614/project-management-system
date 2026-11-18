import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // This app intentionally hydrates client-only state and fetches data from
      // effects. Keep the rest of the React Hooks rules enabled, but do not
      // block those established patterns.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@/modules/*/application", "@/modules/*/application/*", "@/modules/*/domain", "@/modules/*/domain/*", "@/modules/*/infrastructure", "@/modules/*/infrastructure/*"],
          message: "跨模块只能从模块根 index.ts 导入公开契约",
        }],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".worktrees/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
