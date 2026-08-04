import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";

export default [
  {
    ignores: ["android/**/build/**", "dist/**", "node_modules/**"],
  },
  {
    // Baseline for non-JSX source, including src/lib, which previously had no
    // unused-code rule at all. Deliberately excludes .jsx: only the React block
    // below enables react/jsx-uses-vars, and without it every JSX-only usage
    // looks unused and an autofix would strip working imports.
    files: ["src/**/*.{js,mjs,cjs}"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      "no-dupe-keys": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "none",
          // Privacy code strips fields with { lat, lng, ...rest }; those bindings
          // are unused on purpose and must not be reported or autofixed away.
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: [
      "src/components/**/*.{js,mjs,cjs,jsx}",
      "src/pages/**/*.{js,mjs,cjs,jsx}",
      "src/hooks/**/*.{js,mjs,cjs,jsx}",
      // React components living in src/lib still need the hook rules; the
      // non-React modules there stay on the minimal rule set below.
      "src/lib/**/*.jsx",
      "src/Layout.jsx",
    ],
    ignores: ["src/lib/**/*.js", "src/components/ui/**/*"],
    ...pluginJs.configs.recommended,
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      "no-unused-vars": "off",
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "none",
          // Privacy code strips fields with { lat, lng, ...rest }; those bindings
          // are unused on purpose and must not be reported or autofixed away.
          ignoreRestSiblings: true,
        },
      ],
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper", "toast-close"] },
      ],
      "react-hooks/rules-of-hooks": "error",
      // Stale closures here have shipped as real bugs (state that silently
      // stops updating). Deliberate mount-only effects must opt out explicitly
      // with a disable comment stating why, not by omission.
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
