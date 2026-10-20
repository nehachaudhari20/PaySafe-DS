import { FormEvent, useState } from "react";

type PaymentFormProps = {
  disabled: boolean;
  idempotencyKey: string;
  onDraftChange: (amount: string, description: string) => void;
  onSubmit: (amount: string, description: string) => Promise<boolean>;
};

export function PaymentForm({
  disabled,
  idempotencyKey,
  onDraftChange,
  onSubmit,
}: PaymentFormProps) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accepted = await onSubmit(amount.trim(), description.trim());
    if (accepted) {
      setDescription("");
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="text-lg font-semibold text-slate-900">
        New simulated payment
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        Amount and a short description are enough for this demo.
      </p>

      <label
        className="mt-4 block text-sm font-medium text-slate-700"
        htmlFor="amount"
      >
        Amount
      </label>
      <input
        id="amount"
        value={amount}
        onChange={(event) => {
          const nextAmount = event.target.value;
          setAmount(nextAmount);
          onDraftChange(nextAmount, description);
        }}
        inputMode="decimal"
        placeholder="25.00"
        disabled={disabled}
        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none ring-indigo-500 focus:ring-2 disabled:bg-slate-100"
      />

      <label
        className="mt-4 block text-sm font-medium text-slate-700"
        htmlFor="description"
      >
        Description
      </label>
      <input
        id="description"
        value={description}
        onChange={(event) => {
          const nextDescription = event.target.value;
          setDescription(nextDescription);
          onDraftChange(amount, nextDescription);
        }}
        placeholder="Course registration fee"
        maxLength={200}
        disabled={disabled}
        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none ring-indigo-500 focus:ring-2 disabled:bg-slate-100"
      />

      <p className="mt-3 break-all font-mono text-xs text-slate-500">
        Idempotency key: {idempotencyKey}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        A retry of this same amount and description reuses the key. Changing
        either field starts a new payment.
      </p>

      <button
        type="submit"
        disabled={disabled}
        className="mt-5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300"
      >
        {disabled ? "Submitting payment…" : "Submit payment"}
      </button>
    </form>
  );
}
