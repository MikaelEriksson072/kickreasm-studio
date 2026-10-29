/* The Mimir Studio logo (as build/icon.svg, the app icon): the rune ᛗ, Mímir's M, on a dark violet tile, with the eye
 * in Mímir's well, over a broken chain. */
import { useId } from 'react';

export function Logo({ size = 18, className }: { size?: number; className?: string }) {
  const id = useId(), tile = `${id}-tile`, eye = `${id}-eye`, inside = `${id}-in`;
  // half the chain, up to the break in the middle; the other half is its mirror image
  const half = (
    <g clipPath={`url(#${inside})`} fill="none" stroke="#8f86f0" strokeWidth="1" strokeLinecap="round">
      <path d="M0 18.6H4.8M5.6 18.6H9.8" strokeWidth="1.1" />
      <rect x="-2.2" y="17.3" width="4.2" height="2.6" rx="1.3" />
      <rect x="3.4" y="17.3" width="4.2" height="2.6" rx="1.3" />
      <path d="M10.2 17.3H9.7A1.3 1.3 0 0 0 9.7 19.9H10.2" />
      <path d="M11.35 17.15L10.95 16.5M11.35 20.05L10.95 20.7" strokeWidth="0.7" />
    </g>
  );
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3d358f" /><stop offset="1" stopColor="#191640" /></linearGradient>
        <linearGradient id={eye} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffe08a" /><stop offset="1" stopColor="#ffb627" /></linearGradient>
        <clipPath id={inside}><rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5.6" /></clipPath>
      </defs>
      <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5.6" fill={`url(#${tile})`} />
      {half}
      <g transform="matrix(-1 0 0 1 24 0)">{half}</g>
      <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5.6" fill="none" stroke="#a59cff" strokeOpacity="0.4" strokeWidth="0.6" />
      <path d="M7 15.4V4.4l10 6.6M17 15.4V4.4L7 11" fill="none" stroke="#ece9ff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="1.6" fill={`url(#${eye})`} />
    </svg>
  );
}
