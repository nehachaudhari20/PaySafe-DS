import type { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl bg-white p-5 ring-1 ring-slate-200/70 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300",
    secondary: "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:text-slate-400",
    danger: "bg-rose-600 text-white hover:bg-rose-500 disabled:bg-rose-300",
    ghost: "text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:text-slate-300",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed ${styles}`}
    >
      {children}
    </button>
  );
}

export function Dot({ tone }: { tone: "green" | "red" | "amber" | "slate" | "violet" | "indigo" }) {
  const color = {
    green: "bg-emerald-500",
    red: "bg-rose-500",
    amber: "bg-amber-500",
    slate: "bg-slate-300",
    violet: "bg-violet-500",
    indigo: "bg-indigo-500",
  }[tone];
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">{children}</p>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-sm text-rose-700">{children}</p>;
}

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

export function humanize(eventType: string): string {
  const text = eventType.toLowerCase().replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
