// Purple and light text are exact, taken from the logo. The rest are estimates from the app screens,
// to be replaced with the Figma values.
export const BRAND = {
  name: 'Deeper Tones',
  logoUrl: 'https://assets.deepertones.com/email/logo.png',
  logo: { width: 254, height: 40 },
  supportEmail: 'hello@deepertones.com',
  tagline: "Say it your way. We'll tell you honestly what it takes.",
  colors: {
    purple: '#9D4EDD',
    header: '#0E0E0E',
    lightText: '#F1F1F1',
    bodyText: '#1A1A1A',
    muted: '#6B6B6B',
    border: '#E6E6E6',
    footerBg: '#F6F6F6',
    pageBg: '#EDEDED',
  },
  fonts: {
    serif: "Georgia, 'Times New Roman', serif",
    mono: "'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace",
  },
} as const
