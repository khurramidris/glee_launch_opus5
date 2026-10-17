import eslint from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/target/**",
      ".artifacts/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "jsx-a11y": jsxA11y,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "no-control-regex": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-refresh/only-export-components": "off",
      "jsx-a11y/no-noninteractive-tabindex": [
        "error",
        { roles: ["region", "tabpanel"] },
      ],
    },
  },
  {
    files: ["*.config.{ts,mts,js,mjs}", "scripts/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
);
