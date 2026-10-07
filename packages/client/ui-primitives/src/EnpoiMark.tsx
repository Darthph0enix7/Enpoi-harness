import type { IconProps } from './icons/props.ts'

/**
 * Render the Enpoi monogram mark: the geometric "E" in a rounded glass tile
 * with the gradient border and orbital spark. Decorative (aria-hidden), so the
 * render site owns the accessible name; pair with {@link EnpoiWordmark} for
 * the full identity.
 * @param props.size - square edge in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg element.
 */
export function EnpoiMark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
      aria-hidden="true"
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

/**
 * Render the Enpoi Harness wordmark: the "Enpoi" gradient over the secondary
 * "Harness". Decorative brand art, so render it inside an aria-hidden identity
 * wrapper.
 * @returns the wordmark element.
 */
export function EnpoiWordmark() {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '6px',
        userSelect: 'none',
        lineHeight: 1,
      }}
    >
      <span
        style={{
          fontSize: '15px',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          background: 'linear-gradient(135deg, #67DCE7 0%, #A78BFA 55%, #F8F3F5 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        Enpoi
      </span>
      <span
        style={{
          fontSize: '12px',
          fontWeight: 500,
          color: 'var(--dsw-alias-label-secondary, #97ADCA)',
          letterSpacing: '-0.01em',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        Harness
      </span>
    </div>
  )
}
