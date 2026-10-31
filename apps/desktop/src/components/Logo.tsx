/* The Mimir Studio logo as the small sizes of the app icon draw it (build/icon.svg): the rune ᛗ, Mímir's M, glowing
 * over the rings of his well, on a black tile. */
import { useId } from 'react';

export function Logo({ size = 18, className }: { size?: number; className?: string }) {
  const id = useId(), well = `${id}-well`, rune = `${id}-rune`, glow = `${id}-glow`, inside = `${id}-in`;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <radialGradient id={well} cx="12" cy="16.4" r="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0c3346" /><stop offset="0.55" stopColor="#04111a" /><stop offset="1" stopColor="#010306" />
        </radialGradient>
        <linearGradient id={rune} x1="0" y1="5" x2="0" y2="16.4" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f0feff" /><stop offset="1" stopColor="#a8f0ff" />
        </linearGradient>
        <filter id={glow} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="0.9" result="b" />
          <feFlood floodColor="#26c4ff" />
          <feComposite in2="b" operator="in" result="g" />
          <feMerge><feMergeNode in="g" /><feMergeNode in="g" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <clipPath id={inside}><rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5" /></clipPath>
      </defs>
      <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5" fill={`url(#${well})`} />
      <g clipPath={`url(#${inside})`} fill="none" stroke="#3fcfff" strokeWidth="0.55">
        <ellipse cx="12" cy="16.6" rx="10.2" ry="3.3" strokeOpacity="0.28" />
        <ellipse cx="12" cy="16.6" rx="7.6" ry="2.45" strokeOpacity="0.45" />
        <ellipse cx="12" cy="16.6" rx="5.1" ry="1.6" strokeOpacity="0.65" />
      </g>
      {/* the stems, the long stroke from the top left to the right stem, and the short one from the top right down to it */}
      <path filter={`url(#${glow})`} fill={`url(#${rune})`}
        d="M7.1 5H8.9V16.4H7.1Z M15.1 5H16.9V16.4H15.1Z M7.1 5H9.6L16.9 11.6V13.86Z M14.4 5H16.9L12 9.43V7.17Z" />
      <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5" fill="none" stroke="#5fd8ff" strokeOpacity="0.2" strokeWidth="0.25" />
    </svg>
  );
}
