"use client";

import { useEffect, useState } from "react";
import { GitBranch, Radio, Sparkles, Wrench } from "lucide-react";
import type { AgentInfoResult } from "eve/client";

export function AgentInfoPanel() {
  const [info, setInfo] = useState<AgentInfoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/eve/v1/info")
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="m-4 rounded-lg border px-3 py-2.5 text-xs" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
        Failed to load /eve/v1/info: {error}
      </div>
    );
  }

  if (!info) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="mb-4 animate-pulse">
            <div className="mb-2 h-2.5 w-20 rounded-full" style={{ background: "var(--bg-panel-raised)" }} />
            <div className="h-9 rounded-lg" style={{ background: "var(--bg-panel-raised)" }} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 text-xs">
      <Section title="Agent">
        <Row label="name" value={info.agent.name} />
        <Row label="model" value={info.agent.model.id} />
        <Row label="mode" value={info.mode} />
        {info.agent.model.contextWindowTokens && (
          <Row label="context window" value={info.agent.model.contextWindowTokens.toLocaleString()} />
        )}
        {info.diagnostics.discoveryErrors > 0 || info.diagnostics.discoveryWarnings > 0 ? (
          <Row
            label="discovery"
            value={`${info.diagnostics.discoveryErrors} errors, ${info.diagnostics.discoveryWarnings} warnings`}
            valueColor="var(--yellow)"
          />
        ) : null}
      </Section>

      <Section title="Tools" count={info.tools.available.length} icon={Wrench}>
        {info.tools.available.map((tool) => (
          <ToolEntry key={tool.name} name={tool.name} description={tool.description} origin={tool.origin} />
        ))}
      </Section>

      {info.skills.static.length + info.skills.dynamic.length > 0 && (
        <Section title="Skills" count={info.skills.static.length + info.skills.dynamic.length} icon={Sparkles}>
          {info.skills.static.map((skill) => (
            <ToolEntry key={skill.name} name={skill.name} description={skill.description} origin="authored" />
          ))}
          {info.skills.dynamic.map((skill) => (
            <ToolEntry key={skill.slug} name={skill.slug} description="dynamic skill" origin={skill.origin} />
          ))}
        </Section>
      )}

      {info.subagents.total > 0 && (
        <Section title="Subagents" count={info.subagents.total} icon={GitBranch}>
          {info.subagents.local.map((subagent) => (
            <ToolEntry key={subagent.name} name={subagent.name} description={subagent.description} origin="authored" />
          ))}
        </Section>
      )}

      {info.channels.available.length > 0 && (
        <Section title="Channels" count={info.channels.available.length} icon={Radio}>
          <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2" style={{ borderColor: "var(--border)" }}>
            {info.channels.available.map((channel) => (
              <Row key={`${channel.method}-${channel.urlPath}`} label={channel.method} value={channel.urlPath} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  icon: Icon,
  children,
}: {
  title: string;
  count?: number;
  icon?: React.ComponentType<{ size?: number }>;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5 last:mb-0">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
        {Icon && <Icon size={12} />}
        {title}
        {count !== undefined && <span className="normal-case tracking-normal">({count})</span>}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span className="mono truncate" style={{ color: valueColor ?? "var(--text)" }}>
        {value}
      </span>
    </div>
  );
}

function ToolEntry({ name, description, origin }: { name: string; description: string; origin: string }) {
  return (
    <div
      className="rounded-lg border px-3 py-2 transition-colors hover:bg-(--bg-panel-raised)"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex items-center gap-2">
        <span className="mono font-medium" style={{ color: "var(--accent)" }}>
          {name}
        </span>
        <span
          className="ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-medium"
          style={{ color: "var(--text-faint)", background: "var(--bg-panel-raised)" }}
        >
          {origin}
        </span>
      </div>
      {description && (
        <p className="mt-1" style={{ color: "var(--text-dim)" }}>
          {description}
        </p>
      )}
    </div>
  );
}
