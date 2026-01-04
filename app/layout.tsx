import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DBML Viewer",
  description: "View database schemas from Bubble apps",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
