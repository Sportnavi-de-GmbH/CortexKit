import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Partner Retrieval V3 — Workflow Lab", description: "Stage-by-stage debug UI for the V3 partner-retrieval workflow." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
