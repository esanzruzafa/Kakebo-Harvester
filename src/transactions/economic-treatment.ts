export function expenseContribution(input: {
  amount: string;
  treatment: "normal" | "internal-transfer" | "review-required";
  representative: boolean;
}): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(input.amount)) throw new Error("INVALID_AMOUNT");
  if (!input.representative || input.treatment === "internal-transfer") return "0";
  if (/^-?0+(?:\.0+)?$/.test(input.amount)) return "0";
  return input.amount.startsWith("-") ? input.amount.slice(1) : `-${input.amount}`;
}
