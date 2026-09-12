import { z } from "zod";

export type CustomFormulaValue = string | number | boolean | null;

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
      if (!Number.isFinite(value)) throw new Error("Invalid custom formula.");
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
  return new FormulaParser(tokenize(formula)).parse();
}

function numberValue(value: CustomFormulaValue): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Invalid custom formula value.");
  }
  return value;
}

function textValue(value: CustomFormulaValue): string {
  return value === null ? "" : String(value);
}

function evaluate(node: FormulaNode, values: Readonly<Record<string, CustomFormulaValue>>): CustomFormulaValue {
  if (node.type === "literal") return node.value;
  if (node.type === "identifier") return values[node.name] ?? null;
  if (node.type === "binary") {
    const left = evaluate(node.left, values);
    const right = evaluate(node.right, values);
    if (node.operator === "+") {
      return typeof left === "number" && typeof right === "number"
        ? left + right
        : textValue(left) + textValue(right);
    }
    const leftNumber = numberValue(left);
    const rightNumber = numberValue(right);
    if (node.operator === "-") return leftNumber - rightNumber;
    if (node.operator === "*") return leftNumber * rightNumber;
    if (rightNumber === 0) throw new Error("Invalid custom formula value.");
    return leftNumber / rightNumber;
  }
  if (node.name === "coalesce") {
    for (const argument of node.arguments) {
      const value = evaluate(argument, values);
      if (value !== null) return value;
    }
    return null;
  }
  const arguments_ = node.arguments.map((argument) => evaluate(argument, values));
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
      const precision = arguments_.length === 2 ? numberValue(arguments_[1] ?? null) : 0;
      if (!Number.isInteger(precision) || precision < 0 || precision > 15) {
        throw new Error("Invalid custom formula value.");
      }
      const value = numberValue(arguments_[0] ?? null);
      return Number(`${Math.round(Number(`${value}e${precision}`))}e-${precision}`);
    }
  }
}

export function evaluateCustomFormula(
  formula: string,
  values: Readonly<Record<string, CustomFormulaValue>>
): CustomFormulaValue {
  return evaluate(parseCustomFormula(formula), values);
}

export const customFormulaSchema = z.string().trim().min(1).max(500).superRefine((formula, context) => {
  try {
    parseCustomFormula(formula);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid custom formula." });
  }
});
