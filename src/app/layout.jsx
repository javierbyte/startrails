import 'jbx/main.css';
import './globals.css';

import { GoogleAnalytics } from '@next/third-parties/google';

import GitHubCorner from '../components/GitHubCorner.jsx';

const TITLE = 'Star Trails | Stack timelapse frames into a star trail photo';
const DESCRIPTION =
  'Turn a folder of timelapse frames into a single star trail photo. Everything runs in your browser, nothing is uploaded, and the export keeps the EXIF from your first frame.';
const CANONICAL = 'https://javier.xyz/startrails';
const THUMBNAIL = 'https://javier.xyz/startrails/javier-xyz-startrails.jpg';

export const metadata = {
  metadataBase: new URL('https://javier.xyz'),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: CANONICAL,
    images: [
      {
        url: THUMBNAIL,
        width: 1200,
        height: 630,
        alt: TITLE,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: [THUMBNAIL],
  },
};

export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <GitHubCorner />
        <GoogleAnalytics gaId="G-M2FT27FXS2" />
      </body>
    </html>
  );
}
