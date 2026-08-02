import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flamingo",
  description: "Flamingo team triage application",
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
