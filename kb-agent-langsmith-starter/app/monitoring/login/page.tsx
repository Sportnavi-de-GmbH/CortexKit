"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { BrandLogo } from "@/components/monitoring/BrandLogo";
import { BTN_PRIMARY, CARD, INPUT } from "@/components/monitoring/ui";

function LoginForm() {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
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
    setError(res.status === 429 ? "Too many attempts. Please wait 15 minutes and try again." : "That password is not correct.");
  }

  return (
    <form onSubmit={submit} className={`${CARD} w-full max-w-[400px] p-7 soft-shadow-lg sm:p-8`} aria-labelledby="login-title">
      <div className="flex flex-col items-start gap-5">
        <BrandLogo height={30} />
        <div>
          <h1 id="login-title" className="font-display text-xl font-semibold leading-tight text-(--fg)">
            Navio Monitoring
          </h1>
          <p className="mt-1 text-sm text-(--fg-muted)">Internal dashboard for the FAQ and Partner agents. Sign in with the team password.</p>
        </div>
      </div>

      <div className="mt-6">
        <label className="mb-1.5 block font-display text-[13px] font-medium text-(--fg)" htmlFor="pw">
          Password
        </label>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-(--fg-subtle)" aria-hidden />
          <input
            id="pw"
            type={show ? "text" : "password"}
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "pw-error" : undefined}
            className={`${INPUT} pl-9 pr-11 ${error ? "border-(--red)" : ""}`}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide password" : "Show password"}
            className="absolute top-1/2 right-1.5 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-(--fg-subtle) transition-colors hover:bg-(--surface-muted) hover:text-(--fg)"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {error && (
          <p id="pw-error" className="mt-2 text-sm text-(--red)" role="alert">
            {error}
          </p>
        )}
      </div>

      <button disabled={busy || !password} className={`${BTN_PRIMARY} mt-5 w-full`}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    // Rendered inside app/monitoring/layout.tsx (header + main), so no full-screen shell here.
    <div className="flex min-h-[calc(100vh-14rem)] items-center justify-center py-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
