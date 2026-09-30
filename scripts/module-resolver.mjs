// ESM loader that redirects bare specifier resolution to the project root's node_modules.
// This allows the sidecar (whose cwd is ~/.zharness/main) to find dependencies installed
// in the zharness project directory during development.
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export async function resolve(specifier, context, nextResolve) {
	// Windows drive-letter absolute paths (e.g. D:\foo\bar.js) are not URLs —
	// the default resolver would parse them as scheme "d:" and throw
	// ERR_UNSUPPORTED_ESM_URL_SCHEME. Convert to a file:// URL first.
	if (/^[a-zA-Z]:[\\/]/.test(specifier)) {
		return nextResolve(pathToFileURL(specifier).href, context);
	}

	// Only intercept bare specifiers (not relative/absolute paths or URLs)
	if (
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		specifier.startsWith("/") ||
		specifier.startsWith("file:") ||
		specifier.startsWith("data:") ||
		specifier.startsWith("node:") ||
		specifier.startsWith("#")
	) {
		return nextResolve(specifier, context);
	}

	// Try resolving from the project root first
	try {
		return await nextResolve(specifier, {
			...context,
			parentURL: pathToFileURL(projectRoot + "/").href,
		});
	} catch {
		// Fall back to default resolution
		return nextResolve(specifier, context);
	}
}
