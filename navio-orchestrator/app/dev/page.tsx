"use client";

// /dev — the Navio Orchestrator console.
//
// The widget hides routing on purpose (one assistant, no visible agents), which
// makes it useless for debugging or for showing anyone how the system works.
// This page is the inverse: every decision, in plain language, in real time.
//
// Dev only. Not linked from /widget; block it at the edge before launch.

import { DevConsole } from "@/components/dev/DevConsole";

export default function DevPage() {
  return <DevConsole />;
}
