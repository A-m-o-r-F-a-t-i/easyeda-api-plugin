import antfu from '@antfu/eslint-config';

export default antfu({
	stylistic: {
		indent: 'tab',
		quotes: 'single',
		semi: true,
	},

	typescript: true,
	// Tests use Node's built-in runner, not Vitest.
	test: false,

	ignores: ['AGENTS.md', 'build/dist/', 'coverage/', 'dist/', 'node_modules/', '.eslintcache', 'debug.log'],
}, {
	files: ['test/*.mjs'],
	// Node ESM test bootstrap builds a temporary bundle before registering cases.
	rules: { 'antfu/no-top-level-await': 'off' },
});
