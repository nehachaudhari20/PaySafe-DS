export type DashboardSection = "guide" | "demo" | "payments" | "status" | "benchmarks";

const ITEMS: { id: DashboardSection; label: string; hint: string }[] = [
  { id: "guide", label: "How it works", hint: "Start here" },
  { id: "demo", label: "Live demo", hint: "Break things, watch recovery" },
  { id: "payments", label: "Try a payment", hint: "Pay and see every step" },
  { id: "status", label: "System status", hint: "Health, leader, switches" },
  { id: "benchmarks", label: "Benchmarks", hint: "Load-test results" },
];

export function SidebarNav({
  active,
  onSelect,
}: {
  active: DashboardSection;
  onSelect: (section: DashboardSection) => void;
}) {
  return (
    <nav className="space-y-1" aria-label="Dashboard sections">
      {ITEMS.map((item, index) => {
        const selected = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition ${
              selected ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                selected ? "bg-indigo-500 text-white" : "bg-white/10 text-slate-400"
              }`}
            >
              {index + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{item.label}</span>
              <span className="block truncate text-[11px] text-slate-500">{item.hint}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
