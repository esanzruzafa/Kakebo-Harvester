import { z } from "zod";

export type CustomFormulaValue = string | number | boolean | null;
type EvaluationValue = string | boolean | null | Rational;

type FormulaNode =
  | { type: "literal"; value: CustomFormulaValue }
  | { type: "identifier"; name: string }
  | { type: "binary"; operator: "+" | "-" | "*" | "/"; left: FormulaNode; right: FormulaNode }
  | { type: "call"; name: "upper" | "lower" | "coalesce" | "concat" | "round"; arguments: FormulaNode[] };

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: "+" | "-" | "*" | "/" }
  | { type: "punctuation"; value: "(" | ")" | "," }
  | { type: "end" };

type StaticFormulaType = "number" | "string" | "boolean" | "null" | "unknown";

function normalizeDecimalLiteral(input: string): string {
  const [coefficient, exponentText] = input.toLowerCase().split("e");
  const exponent = Number(exponentText ?? "0");
  const sign = coefficient?.startsWith("-") ? "-" : "";
  const unsignedCoefficient = sign ? coefficient?.slice(1) : coefficient;
  const [integer = "", fraction = ""] = unsignedCoefficient?.split(".") ?? [];
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  const expanded = decimalIndex <= 0
    ? `0.${"0".repeat(-decimalIndex)}${digits}`
    : decimalIndex >= digits.length
      ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
      : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  const [whole = "", decimal = ""] = expanded.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/u, "") || "0";
  const normalizedDecimal = decimal.replace(/0+$/u, "");
  const normalized = normalizedDecimal ? `${normalizedWhole}.${normalizedDecimal}` : normalizedWhole;
  return sign && normalized !== "0" ? `${sign}${normalized}` : normalized;
}

const validFunctions = new Set(["upper", "lower", "coalesce", "concat", "round"]);
const validIdentifiers = new Set([
  "movementKey", "date", "valueDate", "bank", "account", "accountAlias", "productType",
  "description", "merchant", "counterparty", "amount", "direction", "status", "categoryAuto",
  "subcategoryAuto", "reviewed", "source", "importedAt"
]);

class FormulaParser {
  private position = 0;

  public constructor(private readonly tokens: Token[]) {}

  public parse(): FormulaNode {
    const expression = this.parseAddition();
    if (this.current().type !== "end") this.invalid();
    return expression;
  }

  private parseAddition(): FormulaNode {
    let left = this.parseMultiplication();
    while (this.matchesOperator("+") || this.matchesOperator("-")) {
      const operator = (this.current() as Extract<Token, { type: "operator" }>).value as "+" | "-";
      this.advance();
      left = { type: "binary", operator, left, right: this.parseMultiplication() };
    }
    return left;
  }

  private parseMultiplication(): FormulaNode {
    let left = this.parsePrimary();
    while (this.matchesOperator("*") || this.matchesOperator("/")) {
      const operator = (this.current() as Extract<Token, { type: "operator" }>).value as "*" | "/";
      this.advance();
      left = { type: "binary", operator, left, right: this.parsePrimary() };
    }
    return left;
  }

  private parsePrimary(): FormulaNode {
    const token = this.advance();
    if (token.type === "number" || token.type === "string") {
      return { type: "literal", value: token.value };
    }
    if (token.type === "identifier") {
      if (!this.matchesPunctuation("(")) {
        if (!validIdentifiers.has(token.value)) this.invalid();
        return { type: "identifier", name: token.value };
      }
      if (!validFunctions.has(token.value)) this.invalid();
      this.advance();
      const arguments_: FormulaNode[] = [];
      if (!this.matchesPunctuation(")")) {
        arguments_.push(this.parseAddition());
        while (this.matchesPunctuation(",")) {
          this.advance();
          arguments_.push(this.parseAddition());
        }
      }
      this.expectPunctuation(")");
      const count = arguments_.length;
      if ((token.value === "upper" || token.value === "lower") && count !== 1) this.invalid();
      if (token.value === "round" && (count < 1 || count > 2)) this.invalid();
      if (token.value === "round" && count === 2) {
        const precision = arguments_[1];
        if (!precision || precision.type !== "literal" || typeof precision.value !== "number" ||
            !Number.isInteger(precision.value) || precision.value < 0 || precision.value > 15) this.invalid();
      }
      return {
        type: "call",
        name: token.value as "upper" | "lower" | "coalesce" | "concat" | "round",
        arguments: arguments_
      };
    }
    if (token.type === "punctuation" && token.value === "(") {
      const expression = this.parseAddition();
      this.expectPunctuation(")");
      return expression;
    }
    this.invalid();
  }

  private current(): Token {
    return this.tokens[this.position] ?? { type: "end" };
  }

  private advance(): Token {
    const token = this.current();
    this.position += 1;
    return token;
  }

  private matchesOperator(operator: "+" | "-" | "*" | "/"): boolean {
    const token = this.current();
    return token.type === "operator" && token.value === operator;
  }

  private matchesPunctuation(punctuation: "(" | ")" | ","): boolean {
    const token = this.current();
    return token.type === "punctuation" && token.value === punctuation;
  }

  private expectPunctuation(punctuation: ")"): void {
    if (!this.matchesPunctuation(punctuation)) this.invalid();
    this.advance();
  }

  private invalid(): never {
    throw new Error("Invalid custom formula.");
  }
}

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  while (position < formula.length) {
    const input = formula.slice(position);
    const whitespace = /^\s+/u.exec(input)?.[0];
    if (whitespace) {
      position += whitespace.length;
      continue;
    }
    const number = /^(?:\d+\.\d*|\d*\.\d+|\d+)/u.exec(input)?.[0];
    if (number) {
      const value = Number(number);
      if (!Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
          normalizeDecimalLiteral(number) !== normalizeDecimalLiteral(value.toString())) {
        throw new Error("Invalid custom formula.");
      }
      tokens.push({ type: "number", value });
      position += number.length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(input)?.[0];
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier });
      position += identifier.length;
      continue;
    }
    const character = input[0];
    if (character === '"') {
      let value = "";
      position += 1;
      let terminated = false;
      while (position < formula.length) {
        const current = formula[position] ?? "";
        if (current === '"') {
          position += 1;
          terminated = true;
          break;
        }
        if (current === "\\") {
          const escaped = formula[position + 1] ?? "";
          if (escaped !== '"' && escaped !== "\\") throw new Error("Invalid custom formula.");
          value += escaped;
          position += 2;
          continue;
        }
        value += current;
        position += 1;
      }
      if (!terminated) throw new Error("Invalid custom formula.");
      tokens.push({ type: "string", value });
      continue;
    }
    if (character === "+" || character === "-" || character === "*" || character === "/") {
      tokens.push({ type: "operator", value: character });
      position += 1;
      continue;
    }
    if (character === "(" || character === ")" || character === ",") {
      tokens.push({ type: "punctuation", value: character });
      position += 1;
      continue;
    }
    throw new Error("Invalid custom formula.");
  }
  tokens.push({ type: "end" });
  return tokens;
}

export function parseCustomFormula(formula: string): FormulaNode {
  const expression = new FormulaParser(tokenize(formula)).parse();
  validateStaticTypes(expression);
  validateConstantValues(expression);
  return expression;
}

function validateStaticTypes(node: FormulaNode): StaticFormulaType {
  if (node.type === "literal") {
    if (node.value === null) return "null";
    if (typeof node.value === "number") return "number";
    if (typeof node.value === "string") return "string";
    return "boolean";
  }
  if (node.type === "identifier") {
    if (node.name === "amount") return "number";
    if (node.name === "reviewed") return "boolean";
    return "string";
  }
  if (node.type === "binary") {
    const left = validateStaticTypes(node.left);
    const right = validateStaticTypes(node.right);
    if (node.operator !== "+" &&
        (left !== "number" && left !== "unknown" || right !== "number" && right !== "unknown")) {
      throw new Error("Invalid custom formula.");
    }
    return node.operator === "+" && (left !== "number" || right !== "number") ? "string" : "number";
  }
  const arguments_ = node.arguments.map(validateStaticTypes);
  if (node.name === "round") {
    const valueType = arguments_[0];
    if (valueType !== "number" && valueType !== "unknown") throw new Error("Invalid custom formula.");
    return "number";
  }
  if (node.name === "upper" || node.name === "lower" || node.name === "concat") return "string";
  for (const argument of arguments_) {
    if (argument === "null") continue;
    return argument;
  }
  return "null";
}

function finiteNumber(value: number): number {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new Error("Invalid custom formula value.");
  }
  return value;
}

function decimalParts(value: number): { coefficient: bigint; scale: number } {
  const sign = value < 0 ? -1n : 1n;
  const [whole, fraction = ""] = normalizeDecimalLiteral(Math.abs(value).toString()).split(".");
  return { coefficient: sign * BigInt(`${whole ?? "0"}${fraction}`), scale: fraction.length };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let dividend = left < 0n ? -left : left;
  let divisor = right < 0n ? -right : right;
  while (divisor !== 0n) [dividend, divisor] = [divisor, dividend % divisor];
  return dividend;
}

class Rational {
  public readonly numerator: bigint;
  public readonly denominator: bigint;

  public constructor(numerator: bigint, denominator = 1n) {
    if (denominator === 0n) throw new Error("Invalid custom formula value.");
    const sign = denominator < 0n ? -1n : 1n;
    const divisor = greatestCommonDivisor(numerator, denominator);
    this.numerator = sign * numerator / divisor;
    this.denominator = sign * denominator / divisor;
  }

  public static fromNumber(value: number): Rational {
    if (!Number.isFinite(value)) throw new Error("Invalid custom formula value.");
    const { coefficient, scale } = decimalParts(value);
    return new Rational(coefficient, 10n ** BigInt(scale));
  }

  public add(other: Rational): Rational {
    return new Rational(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator
    );
  }

  public subtract(other: Rational): Rational {
    return new Rational(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator
    );
  }

  public multiply(other: Rational): Rational {
    return new Rational(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  public divide(other: Rational): Rational {
    if (other.numerator === 0n) throw new Error("Invalid custom formula value.");
    return new Rational(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  public round(precision: number): Rational {
    const scale = 10n ** BigInt(precision);
    const absolute = this.numerator < 0n ? -this.numerator : this.numerator;
    const rounded = (absolute * scale * 2n + this.denominator) / (this.denominator * 2n);
    return new Rational(this.numerator < 0n ? -rounded : rounded, scale);
  }

  public toNumber(): number {
    const decimal = this.terminatingDecimal();
    const converted = decimal ? Number(decimal) : this.approximateNumber();
    if (this.numerator !== 0n && converted === 0) throw new Error("Invalid custom formula value.");
    const number = finiteNumber(converted);
    if (decimal && normalizeDecimalLiteral(decimal) !== normalizeDecimalLiteral(number.toString())) {
      throw new Error("Invalid custom formula value.");
    }
    return number;
  }

  private approximateNumber(): number {
    const absolute = this.numerator < 0n ? -this.numerator : this.numerator;
    let exponent = absolute.toString().length - this.denominator.toString().length;
    const left = exponent >= 0
      ? absolute
      : absolute * 10n ** BigInt(-exponent);
    const right = exponent >= 0
      ? this.denominator * 10n ** BigInt(exponent)
      : this.denominator;
    if (left < right) exponent -= 1;
    const significantDigits = 18;
    const shift = significantDigits - 1 - exponent;
    const numerator = shift >= 0 ? absolute * 10n ** BigInt(shift) : absolute;
    const denominator = shift >= 0 ? this.denominator : this.denominator * 10n ** BigInt(-shift);
    let digits = (numerator * 2n + denominator) / (denominator * 2n);
    const limit = 10n ** BigInt(significantDigits);
    if (digits >= limit) {
      digits /= 10n;
      exponent += 1;
    }
    const coefficient = digits.toString().padStart(significantDigits, "0");
    const sign = this.numerator < 0n ? "-" : "";
    return Number(`${sign}${coefficient[0]}.${coefficient.slice(1)}e${exponent}`);
  }

  private terminatingDecimal(): string | undefined {
    let denominator = this.denominator;
    let twos = 0;
    let fives = 0;
    while (denominator % 2n === 0n) {
      denominator /= 2n;
      twos += 1;
    }
    while (denominator % 5n === 0n) {
      denominator /= 5n;
      fives += 1;
    }
    if (denominator !== 1n) return undefined;
    const scale = Math.max(twos, fives);
    const coefficient = this.numerator * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
    const sign = coefficient < 0n ? "-" : "";
    const digits = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
    return scale === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
}

function rationalValue(value: EvaluationValue): Rational {
  if (!(value instanceof Rational)) throw new Error("Invalid custom formula value.");
  return value;
}

function integerValue(value: EvaluationValue): number {
  const rational = rationalValue(value);
  if (rational.denominator !== 1n) throw new Error("Invalid custom formula value.");
  return finiteNumber(Number(rational.numerator));
}

function textValue(value: EvaluationValue): string {
  if (value === null) return "";
  return value instanceof Rational ? String(value.toNumber()) : String(value);
}

function externalValue(value: EvaluationValue): CustomFormulaValue {
  return value instanceof Rational ? value.toNumber() : value;
}

function evaluate(
  node: FormulaNode,
  values: Readonly<Record<string, CustomFormulaValue>>,
  onIdentifier?: (identifier: string) => void
): EvaluationValue {
  if (node.type === "literal") {
    return typeof node.value === "number" ? Rational.fromNumber(node.value) : node.value;
  }
  if (node.type === "identifier") {
    onIdentifier?.(node.name);
    const value = values[node.name] ?? null;
    return typeof value === "number" ? Rational.fromNumber(value) : value;
  }
  if (node.type === "binary") {
    const left = evaluate(node.left, values, onIdentifier);
    const right = evaluate(node.right, values, onIdentifier);
    if (node.operator === "+") {
      return left instanceof Rational && right instanceof Rational
        ? left.add(right)
        : textValue(left) + textValue(right);
    }
    const leftNumber = rationalValue(left);
    const rightNumber = rationalValue(right);
    if (node.operator === "-") return leftNumber.subtract(rightNumber);
    if (node.operator === "*") return leftNumber.multiply(rightNumber);
    return leftNumber.divide(rightNumber);
  }
  if (node.name === "coalesce") {
    for (const argument of node.arguments) {
      const value = evaluate(argument, values, onIdentifier);
      if (value !== null) return value;
    }
    return null;
  }
  const arguments_ = node.arguments.map((argument) => evaluate(argument, values, onIdentifier));
  switch (node.name) {
    case "upper":
      if (arguments_.length !== 1) throw new Error("Invalid custom formula.");
      return textValue(arguments_[0] ?? null).toUpperCase();
    case "lower":
      if (arguments_.length !== 1) throw new Error("Invalid custom formula.");
      return textValue(arguments_[0] ?? null).toLowerCase();
    case "concat":
      return arguments_.map(textValue).join("");
    case "round": {
      if (arguments_.length < 1 || arguments_.length > 2) throw new Error("Invalid custom formula.");
      const precision = arguments_.length === 2 ? integerValue(arguments_[1] ?? null) : 0;
      if (!Number.isInteger(precision) || precision < 0 || precision > 15) {
        throw new Error("Invalid custom formula value.");
      }
      return rationalValue(arguments_[0] ?? null).round(precision);
    }
  }
}

type ConstantEvaluation = { constant: true; value: EvaluationValue } | { constant: false };

function validateConstantValues(node: FormulaNode): void {
  const result = evaluateConstant(node);
  if (result.constant) externalValue(result.value);
}

function evaluateConstant(node: FormulaNode): ConstantEvaluation {
  if (node.type === "literal") {
    return { constant: true, value: typeof node.value === "number" ? Rational.fromNumber(node.value) : node.value };
  }
  if (node.type === "identifier") return { constant: false };
  if (node.type === "binary") {
    const left = evaluateConstant(node.left);
    const right = evaluateConstant(node.right);
    if (node.operator === "/" && right.constant &&
        right.value instanceof Rational && right.value.numerator === 0n) {
      throw new Error("Invalid custom formula value.");
    }
    if (!left.constant || !right.constant) return { constant: false };
    return { constant: true, value: validatedConstantValue(node) };
  }
  if (node.name === "coalesce") {
    let allPreviousValuesWereConstant = true;
    for (const argument of node.arguments) {
      const result = evaluateConstant(argument);
      if (!result.constant) {
        allPreviousValuesWereConstant = false;
        continue;
      }
      if (result.value !== null) {
        return allPreviousValuesWereConstant
          ? { constant: true, value: result.value }
          : { constant: false };
      }
    }
    return allPreviousValuesWereConstant ? { constant: true, value: null } : { constant: false };
  }
  const arguments_ = node.arguments.map(evaluateConstant);
  if (arguments_.some((argument) => !argument.constant)) return { constant: false };
  return { constant: true, value: validatedConstantValue(node) };
}

function validatedConstantValue(node: FormulaNode): EvaluationValue {
  const value = evaluate(node, {});
  externalValue(value);
  return value;
}

export function evaluateCustomFormula(
  formula: string,
  values: Readonly<Record<string, CustomFormulaValue>>,
  onIdentifier?: (identifier: string) => void
): CustomFormulaValue {
  return externalValue(evaluate(parseCustomFormula(formula), values, onIdentifier));
}

export const customFormulaSchema = z.string().trim().min(1).max(500).superRefine((formula, context) => {
  try {
    parseCustomFormula(formula);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid custom formula." });
  }
});
