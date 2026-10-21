import { FormEvent } from "react";
import { Button, Card } from "./ui";

type PaymentFormProps = {
  amount: string;
  description: string;
  disabled: boolean;
  idempotencyKey: string;
  workersNotNormal?: boolean;
  onAmountChange: (amount: string) => void;
  onDescriptionChange: (description: string) => void;
  onDraftChange: (amount: string, description: string) => void;
  onSubmit: (amount: string, description: string) => Promise<boolean>;
};

const inputClass =
  "mt-1 w-full rounded-lg border-0 px-3 py-2 text-slate-900 ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50";

export function PaymentForm({
  amount,
  description,
  disabled,
  idempotencyKey,
  workersNotNormal = false,
  onAmountChange,
  onDescriptionChange,
  onDraftChange,
  onSubmit,
}: PaymentFormProps) {
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accepted = await onSubmit(amount.trim(), description.trim());
    if (accepted) {
      onDescriptionChange("");
    }
  }

  return (
    <Card title="Send a simulated payment" subtitle="No real money moves.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
          <label className="block text-sm font-medium text-slate-700">
            Amount
            <input
              value={amount}
              onChange={(event) => {
                onAmountChange(event.target.value);
                onDraftChange(event.target.value, description);
              }}
              inputMode="decimal"
              placeholder="25.00"
              disabled={disabled}
              className={inputClass}
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            What is it for?
            <input
              value={description}
              onChange={(event) => {
                onDescriptionChange(event.target.value);
                onDraftChange(amount, event.target.value);
              }}
              placeholder="Course registration fee"
              maxLength={200}
              disabled={disabled}
              className={inputClass}
            />
          </label>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          <p>
            Request ID: <span className="break-all font-mono text-slate-700">{idempotencyKey}</span>
          </p>
          <p className="mt-1">
            Pressing Pay again with the same amount and description reuses this ID, so you will get the same payment back instead of a
            second charge. Changing either field gives a new ID. Teaching cases above manage request IDs separately.
          </p>
          {workersNotNormal && (
            <p className="mt-2 text-amber-800">
              Workers are not in normal mode. Use Reset workers to Normal above before Pay, or use Run case for scenarios.
            </p>
          )}
        </div>
        <Button type="submit" variant="primary" disabled={disabled || workersNotNormal}>
          {disabled ? "Paying…" : "Pay"}
        </Button>
      </form>
    </Card>
  );
}
