import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

/**
 * Cross-platform basename: splits on both "/" and "\\" so Windows paths
 * like C:\\Users\\tom\\project resolve to "project" instead of the full path.
 */
export function basename(path: string): string {
	const parts = path.replace(/[\/\\]+$/, "").split(/[\/\\]/);
	return parts[parts.length - 1] || path;
}