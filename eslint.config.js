import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".agents/**",
      ".cache/**",
      ".codex/**",
      "dist/**",
      "data/**",
      "coverage/**",
      "legal/**",
      "private/**",
      "release/**",
      "eslint.config.js"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.js",
            "vitest.config.mjs"
          ]
        },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { "allowNumber": true }
      ]
    }
  },
  {
    files: [
      "scripts/**/*.{mjs,cjs}",
      "tests/**/*.mjs",
      "src/desktop/preload.cjs",
      "src/desktop/audit-preload.cjs"
    ],
    languageOptions: {
      parserOptions: {
        projectService: false
      }
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "no-undef": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off"
    }
  }
);
