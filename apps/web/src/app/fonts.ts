import localFont from 'next/font/local'

// Free stand-ins for Baselayer's faces (Uncut Sans is the original body face).
export const uncut = localFont({
  src: [
    { path: '../fonts/uncut-sans-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/uncut-sans-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/uncut-sans-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-uncut',
  display: 'swap',
})

export const season = localFont({
  src: '../fonts/source-serif-4-opsz.woff2',
  weight: '200 900',
  variable: '--font-season',
  display: 'swap',
})

export const era = localFont({
  src: '../fonts/geist-mono-wght.woff2',
  weight: '100 900',
  variable: '--font-era',
  display: 'swap',
})
