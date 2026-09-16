"use client";

// Renders an agent answer (markdown) the way the widget shows it, so a reviewer
// reads what the visitor read instead of raw `**` markers. Same component set
// as components/navio/NavioWidget.tsx, trimmed to what answers contain.
import ReactMarkdown from "react-markdown";

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`text-[14px] leading-relaxed text-(--fg) ${className}`}>
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="mb-2.5 whitespace-pre-wrap break-words last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-(--fg)">{children}</strong>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="break-all font-medium text-(--fg) underline decoration-(--brand-green) decoration-2 underline-offset-[3px] transition-colors hover:bg-(--brand-green)/15"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="mb-2.5 flex list-disc flex-col gap-1.5 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2.5 flex list-decimal flex-col gap-1.5 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="[&>p]:mb-0">{children}</li>,
          h1: ({ children }) => <h4 className="mt-4 mb-1.5 font-display text-[15px] font-semibold first:mt-0">{children}</h4>,
          h2: ({ children }) => <h4 className="mt-4 mb-1.5 font-display text-[15px] font-semibold first:mt-0">{children}</h4>,
          h3: ({ children }) => <h4 className="mt-4 mb-1.5 font-display text-[15px] font-semibold first:mt-0">{children}</h4>,
          code: ({ children, className }) =>
            className ? (
              <code className="block overflow-x-auto rounded-lg bg-(--surface-muted) p-2.5 font-mono text-xs">{children}</code>
            ) : (
              <code className="rounded bg-(--surface-muted) px-1.5 py-0.5 font-mono text-xs">{children}</code>
            ),
          pre: ({ children }) => <pre className="mb-2 last:mb-0">{children}</pre>,
          blockquote: ({ children }) => <blockquote className="mb-2 border-l-2 border-(--brand-green) pl-3 text-(--fg-muted) last:mb-0">{children}</blockquote>,
          hr: () => <hr className="my-3 border-(--border)" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
