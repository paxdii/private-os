import type { Metadata, Viewport } from 'next';
import { Sidebar } from '@/components/Sidebar';
import { TodayDataProvider } from '@/components/TodayDataProvider';
import { PWAProvider } from '@/components/PWAProvider';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Today · Private Dashboard', template: '%s · Private Dashboard' },
  description: 'Personal life dashboard — Habits, Health, Reflexion',
  applicationName: 'Private Dashboard',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Dashboard',
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: '/icons/favicon-16.png?v=2', sizes: '16x16', type: 'image/png' },
      { url: '/icons/favicon-32.png?v=2', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png?v=2', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png?v=2', sizes: '180x180', type: 'image/png' }],
  },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#141315',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body className="bg-base text-primary min-h-dvh">
        <PWAProvider>
          <TodayDataProvider>
            <Sidebar />
            <div className="app-content relative z-10">
              {children}
            </div>
          </TodayDataProvider>
        </PWAProvider>
      </body>
    </html>
  );
}
