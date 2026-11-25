import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react-hooks';
import a11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  a11y.flatConfigs.recommended,
  {
    plugins: { 'react-hooks': react },
    rules: { ...react.configs.recommended.rules },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
);
