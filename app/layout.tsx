/**
 * Root Layout Component
 *
 * This is the main wrapper for the entire DBML Viewer application.
 * Every page in the app is displayed inside this layout.
 *
 * What it does:
 * - Sets up the basic HTML structure (html and body tags)
 * - Imports global styles that apply to all pages
 * - Defines the page title and description that appear in browser tabs and search results
 *
 * The "children" parameter represents whatever page content should be displayed.
 * For this app, that's typically the main page (page.tsx) with the schema viewer.
 */

import type { Metadata } from "next";
import "./globals.css";

/**
 * Metadata Configuration
 *
 * These settings control how the app appears in browser tabs and when shared on social media.
 * - title: Shows in the browser tab (e.g., "DBML Viewer")
 * - description: Used by search engines to describe what the app does
 */
export const metadata: Metadata = {
  title: "DBML Viewer",
  description: "View database schemas from Bubble apps",
};

/**
 * RootLayout Function
 *
 * This function creates the outer shell of every page in the app.
 * It wraps all page content in the standard HTML structure needed by browsers.
 *
 * Parameters:
 * - children: The actual page content to display (passed in automatically by Next.js)
 *
 * Returns: The complete HTML page structure with the content inside
 */
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
