/* The Mimir Studio logo (as build/icon.svg, the app icon): the rune ᛗ, Mímir's M, on a violet tile, with the eye in
 * Mímir's well. */
import { useId } from 'react';

export function Logo({ size = 18, className }: { size?: number; className?: string }) {
  const id = useId(), tile = `${id}-tile`, eye = `${id}-eye`;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9a8fff" /><stop offset="1" stopColor="#3b2f9e" /></linearGradient>
        <linearGradient id={eye} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffe08a" /><stop offset="1" stopColor="#ffb627" /></linearGradient>
      </defs>
      <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5.6" fill={`url(#${tile})`} />
      <path d="M7 18.8V5.2l10 7.4M17 18.8V5.2L7 12.6" fill="none" stroke="#f5f3ff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="16.9" r="1.75" fill={`url(#${eye})`} />
    </svg>
  );
}
