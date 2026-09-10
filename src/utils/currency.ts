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

function fixedDecimal(value: string, fractionDigits: number): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  const sign = match[1] === "-" ? -1n : 1n;
  let units = sign * BigInt(`${match[2]}${fraction}`);
  if (fraction.length > fractionDigits) {
    const divisor = 10n ** BigInt(fraction.length - fractionDigits);
    const absolute = units < 0n ? -units : units;
    const rounded = (absolute + divisor / 2n) / divisor;
    units = units < 0n ? -rounded : rounded;
  } else if (fraction.length < fractionDigits) {
    units *= 10n ** BigInt(fractionDigits - fraction.length);
  }
  const negative = units < 0n;
  const absolute = (negative ? -units : units)
    .toString()
    .padStart(fractionDigits + 1, "0");
  const decimal =
    fractionDigits === 0
      ? absolute
      : `${absolute.slice(0, -fractionDigits)}.${absolute.slice(-fractionDigits)}`;
  return negative && units !== 0n ? `-${decimal}` : decimal;
}

export function formatExactCurrencyDecimal(
  value: string,
  currency: string | null | undefined,
  locale: string
): string {
  const fractionDigits = currencyFractionDigits(currency);
  const fixed = fixedDecimal(value, fractionDigits);
  if (fixed === null) return [value, currency].filter(Boolean).join(" ");
  const negative = fixed.startsWith("-");
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [integer = "0", fraction] = unsigned.split(".");
  const decimalSeparator =
    new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
  const localizedNumber = fraction
    ? `${integer}${decimalSeparator}${fraction}`
    : integer;
  if (!currency) return negative ? `-${localizedNumber}` : localizedNumber;
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    }).formatToParts(negative ? -1 : 1);
    const numericIndexes = parts
      .map((part, index) =>
        ["integer", "group", "decimal", "fraction"].includes(part.type)
          ? index
          : -1
      )
      .filter((index) => index >= 0);
    const first = numericIndexes.at(0) ?? 0;
    const last = numericIndexes.at(-1) ?? first;
    return `${parts.slice(0, first).map((part) => part.value).join("")}${localizedNumber}${parts
      .slice(last + 1)
      .map((part) => part.value)
      .join("")}`;
  } catch {
    return `${negative ? "-" : ""}${localizedNumber} ${currency}`;
  }
}
