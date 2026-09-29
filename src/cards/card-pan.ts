export const CARD_PAN = /(?<!\d)\d(?:[\s\p{P}]*\d){12,18}(?![\s\p{P}]*\d)/gu;

export function containsCardPan(value: string): boolean {
  return value.replace(CARD_PAN, "") !== value;
}

export function redactCardPan(value: string | null): string | null {
  return value === null ? null : value.replace(CARD_PAN, "[TARJETA OCULTA]");
}
