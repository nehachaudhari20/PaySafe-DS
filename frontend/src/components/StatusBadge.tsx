const styles: Record<string, string> = {
  PENDING: "bg-slate-200 text-slate-700",
  PROCESSING: "bg-amber-100 text-amber-800",
  SUCCESS: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-rose-100 text-rose-800",
  UNKNOWN: "bg-violet-100 text-violet-800",
};

export function StatusBadge({ status }: { status: string }) {
  const color = styles[status] ?? "bg-slate-200 text-slate-700";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${color}`}>{status}</span>
  );
}
