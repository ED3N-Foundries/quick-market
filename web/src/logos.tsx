// Brand marks, rendered monochrome via currentColor so they sit cleanly in the
// dark UI (grey-ish offwhite instead of brand colors).
//
// Sources (paths vendored from official assets):
// - Phantom ghost: official Phantom integration assets
//   (docs.phantom.com/resources/assets). Eyes knock out via fill-rule.
// - Base square: official Base brand kit, logo/Basemark/Digital (TheSquare),
//   adapted to a single ring via fill-rule (base/brand-kit on GitHub).
// - NEAR mark: Simple Icons "near" glyph (CC0).

export function PhantomLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 128 128" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M55.6416 82.1477C50.8744 89.4525 42.8862 98.6966 32.2568 98.6966C27.232 98.6966 22.4004 96.628 22.4004 87.6424C22.4004 64.7584 53.6445 29.3335 82.6339 29.3335C99.1257 29.3335 105.697 40.7755 105.697 53.7689C105.697 70.4471 94.8739 89.5171 84.1156 89.5171C80.7013 89.5171 79.0264 87.6424 79.0264 84.6688C79.0264 83.8931 79.1552 83.0527 79.4129 82.1477C75.7409 88.4182 68.6546 94.2361 62.0192 94.2361C57.1877 94.2361 54.7397 91.1979 54.7397 86.9314C54.7397 85.3799 55.0618 83.7638 55.6416 82.1477ZM80.6133 53.3182C80.6133 57.1044 78.3795 58.9975 75.8806 58.9975C73.3438 58.9975 71.1479 57.1044 71.1479 53.3182C71.1479 49.532 73.3438 47.6389 75.8806 47.6389C78.3795 47.6389 80.6133 49.532 80.6133 53.3182ZM94.8102 53.3184C94.8102 57.1046 92.5763 58.9977 90.0775 58.9977C87.5407 58.9977 85.3447 57.1046 85.3447 53.3184C85.3447 49.5323 87.5407 47.6392 90.0775 47.6392C92.5763 47.6392 94.8102 49.5323 94.8102 53.3184Z"
      />
    </svg>
  )
}

export function BaseLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M3.0009 4.70623C3.0009 4.12129 3.0009 3.82882 3.11069 3.60474C3.21598 3.38966 3.39056 3.21508 3.60564 3.10979C3.82972 3 4.12219 3 4.70623 3H19.2938C19.8787 3 20.1703 3 20.3953 3.10979C20.6103 3.21508 20.784 3.39056 20.8893 3.60474C21 3.82972 21 4.12219 21 4.70623V19.2938C21 19.8787 21 20.1703 20.8893 20.3953C20.784 20.6103 20.6094 20.784 20.3953 20.8893C20.1703 21 19.8778 21 19.2938 21H4.70623C4.12129 21 3.82972 21 3.60474 20.8893C3.38966 20.784 3.21598 20.6094 3.11069 20.3953C3 20.1703 3 19.8778 3 19.2938V4.70623H3.0009ZM4.0008 5.51665C4.0008 4.9967 4.0008 4.73673 4.09839 4.53755C4.19198 4.34637 4.34717 4.19118 4.53835 4.09759C4.73753 4 4.9975 4 5.51665 4H18.4834C19.0033 4 19.2625 4 19.4625 4.09759C19.6536 4.19118 19.808 4.34717 19.9016 4.53755C20 4.73753 20 4.9975 20 5.51665V18.4834C20 19.0033 20 19.2625 19.9016 19.4625C19.808 19.6536 19.6528 19.808 19.4625 19.9016C19.2625 20 19.0025 20 18.4834 20H5.51665C4.9967 20 4.73753 20 4.53755 19.9016C4.34637 19.808 4.19198 19.6528 4.09839 19.4625C4 19.2625 4 19.0025 4 18.4834V5.51665H4.0008Z"
      />
    </svg>
  )
}

export function NearLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21.443 0c-.89 0-1.714.46-2.18 1.218l-5.017 7.448a.533.533 0 0 0 .792.7l4.938-4.282a.2.2 0 0 1 .334.151v13.41a.2.2 0 0 1-.354.128L5.03.905A2.555 2.555 0 0 0 3.078 0h-.521A2.557 2.557 0 0 0 0 2.557v18.886a2.557 2.557 0 0 0 4.736 1.338l5.017-7.448a.533.533 0 0 0-.792-.7l-4.938 4.283a.2.2 0 0 1-.333-.152V5.352a.2.2 0 0 1 .354-.128l14.924 17.87c.486.574 1.2.905 1.952.906h.521A2.558 2.558 0 0 0 24 21.445V2.557A2.558 2.558 0 0 0 21.443 0Z"
      />
    </svg>
  )
}

/** Chain badge mark: NEAR on near-testnet, Base everywhere else. */
export function ChainLogo({ chainKey, className }: { chainKey: string; className?: string }) {
  if (chainKey === "near-testnet") return <NearLogo className={className} />
  return <BaseLogo className={className} />
}
