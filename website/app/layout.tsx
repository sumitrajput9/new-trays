import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PrintPort — local print bridge for web apps",
  description:
    "PrintPort connects web pages to local printers, scales, and scanners over a secure local WebSocket bridge.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
