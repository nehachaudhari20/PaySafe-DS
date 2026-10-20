import type { CoordinatorLeadership, WorkersHealthResponse } from "../types";
import { FlowDiagram } from "./FlowDiagram";
import { Button, Card } from "./ui";

const RISKS: { problem: string; answer: string; scenario: string }[] = [
  {
    problem: "The same payment is sent twice (double click, lost reply).",
    answer: "Each request carries a unique request ID. The API stores it, so a repeat gets back the first payment instead of charging again.",
    scenario: "double",
  },
  {
    problem: "A request ID is reused for a different payment.",
    answer: "The API also remembers what the request contained, and refuses a mismatch with HTTP 409.",
    scenario: "conflict",
  },
  {
    problem: "The payment is genuinely declined.",
    answer: "The worker's answer is final and the payment is marked FAILED.",
    scenario: "failed",
  },
  {
    problem: "A worker answers too late, so nobody knows if money moved.",
    answer: "The payment is marked UNKNOWN, never guessed as FAILED. Each payment can only take effect once, and reconciliation later reads the worker's saved result.",
    scenario: "unknown",
  },
  {
    problem: "The leader coordinator crashes.",
    answer: "The other coordinators notice the missing heartbeats and elect a new leader (highest surviving ID). A higher term number stops the old leader from giving out work.",
    scenario: "leader",
  },
];

const WORDS: [string, string][] = [
  ["Request ID (idempotency key)", "A unique ID sent with each payment so repeats can be recognized."],
  ["Leader", "The one coordinator allowed to hand out work right now."],
  ["Term", "A counter that goes up at every election. Higher term = the current leader."],
  ["Lease", "The leader's right to lead, which expires unless it keeps renewing it with heartbeats."],
  ["UNKNOWN", "We don't know yet if the payment happened. Not the same as FAILED."],
  ["Reconciliation", "A later check that settles UNKNOWN payments from the worker's saved result."],
  ["Lamport time (L12)", "A logical counter that orders steps across programs, even if their clocks differ."],
];

export function HowItWorks({
  leadership,
  health,
  onWatch,
}: {
  leadership: CoordinatorLeadership | null;
  health: WorkersHealthResponse | null;
  onWatch: (scenarioId: string) => void;
}) {
  return (
    <div className="space-y-5">
      <Card
        title="The path every payment takes"
        subtitle="PaySafe is a practice payment system split into separate programs. No real money moves."
      >
        <FlowDiagram leadership={leadership} health={health} />
        <p className="mt-4 text-sm text-slate-600">
          There are three coordinators so that one can crash without stopping payments, and two workers so that one can be busy or
          broken. The database is the single source of truth for every payment and every step.
        </p>
        <div className="mt-4">
          <Button variant="primary" onClick={() => onWatch("normal")}>
            Watch a normal payment →
          </Button>
        </div>
      </Card>

      <Card title="What can go wrong, and what PaySafe does about it">
        <ul className="divide-y divide-slate-100">
          {RISKS.map((risk) => (
            <li key={risk.scenario} className="grid gap-2 py-3 first:pt-0 last:pb-0 md:grid-cols-[1fr_1.4fr_auto] md:items-center md:gap-4">
              <p className="text-sm font-medium text-slate-900">{risk.problem}</p>
              <p className="text-sm text-slate-600">{risk.answer}</p>
              <Button onClick={() => onWatch(risk.scenario)}>Watch it →</Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Words you will see">
        <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2">
          {WORDS.map(([word, meaning]) => (
            <div key={word}>
              <dt className="text-sm font-medium text-slate-900">{word}</dt>
              <dd className="text-sm text-slate-600">{meaning}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
