"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";

function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = useSearchParams().get("next") ?? "/monitoring";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/monitoring/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (res.ok) {
      window.location.assign(next.startsWith("/monitoring") ? next : "/monitoring");
      return;
    }
    setError(res.status === 429 ? "Too many attempts — wait 15 minutes." : "Wrong password.");
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-(--border) bg-(--surface) p-6 soft-shadow">
      <div className="mb-4 flex items-center gap-2 font-display text-lg font-semibold">
        <Lock className="h-5 w-5 text-(--brand-green)" /> Navio Monitoring
      </div>
      <label className="font-display text-[13px] font-medium" htmlFor="pw">
        Password
      </label>
      <input
        id="pw"
        type="password"
        autoFocus
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mt-1 w-full rounded-xl border border-(--border) bg-(--surface-muted) px-3 py-2 text-sm outline-none focus:border-(--brand-green)"
      />
      {error && (
        <p className="mt-2 text-sm text-(--red)" role="alert">
          {error}
        </p>
      )}
      <button
        disabled={busy || !password}
        className="mt-4 w-full rounded-full bg-(--brand-green) px-4 py-2 font-display text-sm font-semibold text-white disabled:opacity-50"
      >
        Sign in
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    // Rendered inside app/monitoring/layout.tsx (header + main), so no full-screen shell here.
    <div className="flex min-h-[60vh] items-center justify-center">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
