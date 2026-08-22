export interface EnpoiLogoProps {
  size?: number | undefined
  className?: string | undefined
}

/**
 * Modern geometric "E" monogram + orbital spark for Enpoi Harness.
 * Sharp, crisp vector rendering across all sizes (16px to 64px).
 */
export function EnpoiLogo(props?: EnpoiLogoProps) {
  const size = props?.size ?? 24
  const className = props?.className
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <defs>
        <linearGradient id="enpoi-grad-border" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#67DCE7" />
          <stop offset="50%" stopColor="#8B5CF6" />
          <stop offset="100%" stopColor="#DD8FAC" />
        </linearGradient>
        <linearGradient id="enpoi-grad-fill" x1="6" y1="6" x2="26" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#67DCE7" />
          <stop offset="60%" stopColor="#A78BFA" />
          <stop offset="100%" stopColor="#DD8FAC" />
        </linearGradient>
      </defs>

      {/* Outer rounded container with translucent glass fill and gradient border */}
      <rect
        x="2.5"
        y="2.5"
        width="27"
        height="27"
        rx="7.5"
        fill="rgba(10, 18, 31, 0.75)"
        stroke="url(#enpoi-grad-border)"
        strokeWidth="2"
      />

      {/* Stylized geometric "E" Monogram */}
      {/* Top bar */}
      <path
        d="M8.5 9.5C8.5 8.67157 9.17157 8 10 8H21C21.8284 8 22.5 8.67157 22.5 9.5C22.5 10.3284 21.8284 11 21 11H11.5V13.5H18.5C19.3284 13.5 20 14.1716 20 15C20 15.8284 19.3284 16.5 18.5 16.5H11.5V19H21.5C22.3284 19 23 19.6716 23 20.5C23 21.3284 22.3284 22 21.5 22H10C9.17157 22 8.5 21.3284 8.5 20.5V9.5Z"
        fill="url(#enpoi-grad-fill)"
      />

      {/* Orbital glow spark at top-right */}
      <circle cx="23.5" cy="8.5" r="2.2" fill="#67DCE7" />
      <circle cx="23.5" cy="8.5" r="1.1" fill="#FFFFFF" />
    </svg>
  )
}
