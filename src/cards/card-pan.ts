export const CARD_PAN = /(?<!\d)\d(?:[\s-]*\d){12,18}(?![\s-]*\d)/gu;

export function containsCardPan(value: string): boolean {
  return value.replace(CARD_PAN, "") !== value;
}
