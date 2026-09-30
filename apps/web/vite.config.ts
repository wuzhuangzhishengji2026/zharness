import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { zharnessRpcBridge } from "./scripts/dev-bridge.mjs";
import path from "node:path";

export default defineConfig({
	plugins: [react(), tailwindcss(), zharnessRpcBridge()],
	clearScreen: false,
	server: {
		// Port 1420 belongs to apps/web — this GUI runs in parallel at 1421
		// so old/new can be compared side by side.
		port: 1421,
		strictPort: true,
		host: "127.0.0.1",
	},
	envPrefix: ["VITE_", "TAURI_"],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	build: {
		target: "es2022",
		outDir: "dist",
		emptyOutDir: true,
	},
});
