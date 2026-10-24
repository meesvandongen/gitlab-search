import { defineConfig } from "vite-plus";

export default defineConfig({
	// Mirrors the existing code style (tabs, double quotes, semicolons).
	fmt: {
		useTabs: true,
		printWidth: 80,
	},
	lint: {
		options: { typeAware: true, typeCheck: true },
	},
});
