import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Liston",
  description: "Liston — track competitor listings, generate original content with AI, publish across marketplaces.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
