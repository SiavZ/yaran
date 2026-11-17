/** Yaran's existing Y mark, used by the phone shell as an identity mark.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/screens/BrandMark.tsx
 * └── src/screens/Page.tsx
 * <module-headers:end>
 */
export function BrandMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 512 512" className="size-8 shrink-0">
      <rect width="512" height="512" rx="112" fill="var(--card)" />
      <path d="M120 104 256 240 392 104 432 144 284 292V432H228V292L80 144Z" fill="var(--yaran-brand)" />
    </svg>
  );
}
