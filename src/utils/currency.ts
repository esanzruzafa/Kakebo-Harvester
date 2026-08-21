export function currencyFractionDigits(currency: string | null | undefined): number {
  if (!currency) return 2;
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}
