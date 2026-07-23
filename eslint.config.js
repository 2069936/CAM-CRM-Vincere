import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // App.jsx intentionally exports pure domain helpers used by the regression
    // suite, and these legacy screens initialize/clear local view state from
    // effects. Keep the useful hook dependency/purity rules enabled while
    // excluding two rules that assume one-component modules and derived-only state.
    files: ['src/App.jsx', 'src/components/DailySOP.jsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['src/components/StackPlaybook.jsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
])
