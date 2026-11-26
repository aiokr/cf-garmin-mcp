import js from "@eslint/js";
import ts from "typescript-eslint";
import vue from "eslint-plugin-vue";
export default ts.config(
  { ignores: ["dist/**", "node_modules/**", ".wrangler/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs["flat/essential"],
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.vue"],
    languageOptions: { parserOptions: { parser: ts.parser } },
    rules: { "vue/multi-word-component-names": "off", "no-undef": "off" },
  },
  {
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
  },
  {
    files: ["apps/web/**/*.vue"],
    languageOptions: {
      globals: {
        localStorage: "readonly",
        matchMedia: "readonly",
        document: "readonly",
      },
    },
  },
  {
    files: ["apps/worker/**/*.ts", "apps/web/**/*.ts"],
    languageOptions: { globals: { console: "readonly" } },
  },
);
