export function BrandIcon({
	size = 28,
	className,
}: {
	size?: number;
	className?: string;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 32 32"
			xmlns="http://www.w3.org/2000/svg"
			className={className}
			role="img"
			aria-label="zharness"
		>
			{/* Rounded-square brand mark: accent background + white E letter.
			    The square uses currentColor so the theme accent is applied via
			    a text color class (e.g. text-accent). */}
			<rect x="0" y="0" width="32" height="32" rx="7" fill="currentColor" />
			<path
				d="M11 9h11v3.2h-7.4v2.6h6.4v3.2h-6.4v2.8H22V24H11V9Z"
				fill="#ffffff"
			/>
		</svg>
	);
}
