// Dev landing page. The public surface is /widget; in production next.config.mjs
// redirects "/" there. Locally this is just a signpost — use `npx eve dev` or the
// eve TUI for backend debugging, and /widget for the real UI.

export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", margin: "0 auto", maxWidth: 640, padding: "3rem 1.5rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: ".5rem" }}>Navio Orchestrator</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        Multi-agent Navio: one master agent routes to the FAQ subagent, the partner
        search tool, and the human-contact escalation.
      </p>
      <ul style={{ color: "#555", lineHeight: 1.9, marginTop: "1.5rem" }}>
        <li>
          <a href="/widget">/widget</a> — the embeddable widget (the real UI)
        </li>
        <li>
          <a href="/eve/v1/info">/eve/v1/info</a> — resolved agent, tools and subagents
        </li>
      </ul>
    </main>
  );
}
