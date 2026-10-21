import type { CoordinatorLeadership, WorkersHealthResponse } from "../types";
import type { DashboardSection } from "./SidebarNav";
import { FlowDiagram } from "./FlowDiagram";
import { Button, Card } from "./ui";

const TOPICS: { title: string; detail: string; demoId?: string }[] = [
  {
    title: "Idempotency",
    detail: "Request IDs and payload fingerprints stop duplicate charges when clients retry.",
    demoId: "double",
  },
  {
    title: "Retries and worker failover",
    detail: "The coordinator tries another worker when a gRPC call fails or times out, within a bounded attempt limit.",
    demoId: "normal",
  },
  {
    title: "UNKNOWN vs FAILED",
    detail: "A deadline without confirmation becomes UNKNOWN—not a confirmed failure.",
    demoId: "unknown",
  },
  {
    title: "Reconciliation",
    detail: "Later admin reconciliation copies stored worker effects onto uncertain payments without re-dispatching.",
    demoId: "unknown",
  },
  {
    title: "Leader election and lease fencing",
    detail: "Three coordinators run Bully election; only the lease holder may dispatch work at the current term.",
    demoId: "leader",
  },
  {
    title: "Observed execution history",
    detail: "The API records steps it actually saw, with optional Lamport timestamps for ordering demos.",
  },
];

export function Home({
  leadership,
  health,
  onNavigate,
  onWatchDemo,
}: {
  leadership: CoordinatorLeadership | null;
  health: WorkersHealthResponse | null;
  onNavigate: (section: DashboardSection) => void;
  onWatchDemo: (scenarioId: string) => void;
}) {
  return (
    <div className="space-y-5">
      <Card
        title="PaySafe"
        subtitle="A distributed-systems payment simulation. Simulated payments only—no real money moves."
      >
        <FlowDiagram leadership={leadership} health={health} />
        <p className="mt-4 text-sm text-slate-600">
          Your browser sends HTTP to the Payment API, which stores each request and asks the elected coordinator leader to
          dispatch work over gRPC to one of two workers. Results and execution events land in PostgreSQL—the shared source
          of truth for this demo.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => onNavigate("payments")}>
            Try a payment →
          </Button>
          <Button onClick={() => onNavigate("demo")}>
            Live demo →
          </Button>
          <Button variant="ghost" onClick={() => onNavigate("status")}>
            System status
          </Button>
        </div>
      </Card>

      <Card title="What this project demonstrates">
        <ul className="space-y-3">
          {TOPICS.map((topic) => (
            <li key={topic.title} className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-medium text-slate-900">{topic.title}</p>
                <p className="text-sm text-slate-600">{topic.detail}</p>
              </div>
              {topic.demoId && (
                <Button variant="ghost" onClick={() => onWatchDemo(topic.demoId!)}>
                  Live demo →
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <p className="rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200">
        This stack is for learning and demos. It does not provide exactly-once execution across every failure mode, and
        development fault controls are not authenticated.
      </p>
    </div>
  );
}
