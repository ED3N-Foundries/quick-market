/** Brand parameters for generated icons, avatars, and social cards. */
export const brand = {
  name: "Quick Market",
  origin: "https://qmkt.app",
  /** Phthalo green. RGB(18, 53, 36). */
  backdrop: "#123524",
  text: "#ffffff",
  /** Social description and the line on both banners. */
  tagline: "trade next, now.",
  font: {
    family: "Iowan Old Style",
    weight: 400,
    style: "normal" as const,
    letterSpacing: "-0.03em",
    local: [
      "Iowan Old Style",
      "Iowan Old Style Roman",
      "IowanOldStyle-Roman",
    ],
    /** Same family, used only for the 16px tab icon, where regular strokes vanish. */
    boldLocal: ["Iowan Old Style Bold", "IowanOldStyle-Bold"],
    fallback: ["Palatino", "Palatino Linotype", "ui-serif", "serif"],
    /**
     * macOS system face used by the on-site wordmark.
     * The renderer may read this file. It is not copied into the repo.
     */
    file: "/System/Library/Fonts/Supplemental/Iowan Old Style.ttc",
  },
  favicon: {
    text: "qm",
    /** Share of the square the word may occupy. Small sizes use more of it so the strokes survive. */
    safeWidth: 0.7,
  },
  avatar: {
    text: "qmkt.app",
    size: 1024,
    safeWidth: 0.62,
  },
  /**
   * Share card. Tighter than a full-bleed line so a cropped preview keeps
   * the words, and looser than the X header.
   */
  og: {
    width: 2400,
    height: 1260,
    safeWidth: 0.45,
  },
  /**
   * X header. Smaller profile views crop the top and bottom, and the profile
   * photo covers the lower left, so the line stays in the middle of the frame.
   */
  banner: {
    width: 3000,
    height: 1000,
    safeWidth: 0.34,
  },
} as const
