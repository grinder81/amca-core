import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".amca/**",
      ".agent.indy/templates/**",
      "coverage/**",
      "**/dist/**",
      "docs/research/whitepaper/**",
      "eslint.config.js",
      "prettier.config.js",
      "test-results/**",
      "vitest.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
);
