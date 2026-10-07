export type FormulaValue = string | number | boolean | null | FormulaValue[];

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: string }
  | { type: "punctuation"; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index++;
    } else if (char === '"') {
      let value = "";
      index++;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\" && index + 1 < source.length) {
          const next = source[index + 1];
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          index += 2;
        } else if (source[index] === '"') {
          closed = true;
          index++;
          break;
        } else {
          value += source[index++];
        }
      }
      if (!closed) throw new Error("Formula has an unclosed string");
      tokens.push({ type: "string", value });
    } else if (/\d/.test(char) || (char === "." && /\d/.test(source[index + 1] ?? ""))) {
      const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
      if (!match) throw new Error("Formula has an invalid number");
      tokens.push({ type: "number", value: Number(match[0]) });
      index += match[0].length;
    } else if (/[A-Za-z_]/.test(char)) {
      const match = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) throw new Error("Formula has an invalid identifier");
      tokens.push({ type: "identifier", value: match[0] });
      index += match[0].length;
    } else {
      const operator = ["==", "!=", ">=", "<=", "&&", "||"].find((item) =>
        source.startsWith(item, index),
      );
      if (operator) {
        tokens.push({ type: "operator", value: operator });
        index += operator.length;
      } else if ("+-*/%><!".includes(char)) {
        tokens.push({ type: "operator", value: char });
        index++;
      } else if ("(),".includes(char)) {
        tokens.push({ type: "punctuation", value: char });
        index++;
      } else {
        throw new Error(`Formula contains an unsupported character: ${char}`);
      }
    }
  }
  return tokens;
}

function numeric(value: FormulaValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === "") return 0;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`Cannot convert "${String(value)}" to a number`);
  return result;
}

function text(value: FormulaValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.map(text).join(", ");
  return String(value);
}

function truthy(value: FormulaValue): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function dateValue(value: FormulaValue): Date {
  const date = new Date(text(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Formula expected a valid date");
  return date;
}

function unitMilliseconds(unit: string): number {
  const normalized = unit.toLowerCase().replace(/s$/, "");
  const units: Record<string, number> = {
    millisecond: 1,
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
  };
  const duration = units[normalized];
  if (!duration) throw new Error(`Unsupported date unit: ${unit}`);
  return duration;
}

function callFunction(name: string, args: FormulaValue[]): FormulaValue {
  const first = args[0] ?? null;
  switch (name.toLowerCase()) {
    case "if":
      if (args.length !== 3) throw new Error("if() expects three arguments");
      return truthy(args[0]) ? args[1] : args[2];
    case "ifs":
      for (let index = 0; index + 1 < args.length; index += 2) {
        if (truthy(args[index])) return args[index + 1];
      }
      return args.length % 2 ? args[args.length - 1] : null;
    case "and":
      return args.every(truthy);
    case "or":
      return args.some(truthy);
    case "not":
      return !truthy(first);
    case "empty":
      return first === null || first === "" || (Array.isArray(first) && first.length === 0);
    case "length":
      return Array.isArray(first) ? first.length : text(first).length;
    case "contains":
      return Array.isArray(first)
        ? first.some((item) => text(item) === text(args[1] ?? null))
        : text(first).includes(text(args[1] ?? null));
    case "startswith":
      return text(first).startsWith(text(args[1] ?? null));
    case "endswith":
      return text(first).endsWith(text(args[1] ?? null));
    case "replace":
      return text(first).replace(text(args[1] ?? null), text(args[2] ?? null));
    case "replaceall":
      return text(first).replaceAll(text(args[1] ?? null), text(args[2] ?? null));
    case "lower":
      return text(first).toLowerCase();
    case "upper":
      return text(first).toUpperCase();
    case "trim":
      return text(first).trim();
    case "abs":
      return Math.abs(numeric(first));
    case "ceil":
      return Math.ceil(numeric(first));
    case "floor":
      return Math.floor(numeric(first));
    case "round": {
      const places = Math.min(12, Math.max(0, Math.trunc(numeric(args[1] ?? 0))));
      const scale = 10 ** places;
      return Math.round(numeric(first) * scale) / scale;
    }
    case "min":
      return args.length ? Math.min(...args.map(numeric)) : null;
    case "max":
      return args.length ? Math.max(...args.map(numeric)) : null;
    case "sum":
      return args.reduce<number>((total, value) => total + numeric(value), 0);
    case "average":
      return args.length
        ? args.reduce<number>((total, value) => total + numeric(value), 0) / args.length
        : null;
    case "mod":
      if (numeric(args[1] ?? 0) === 0) throw new Error("mod() cannot divide by zero");
      return numeric(first) % numeric(args[1] ?? 0);
    case "pow":
      return numeric(first) ** numeric(args[1] ?? 0);
    case "sqrt":
      return Math.sqrt(numeric(first));
    case "sign":
      return Math.sign(numeric(first));
    case "join":
      return Array.isArray(first) ? first.map(text).join(text(args[1] ?? "")) : text(first);
    case "slice":
      return text(first).slice(
        numeric(args[1] ?? 0),
        args[2] === undefined ? undefined : numeric(args[2]),
      );
    case "concat":
      return args.map(text).join("");
    case "tonumber":
      return numeric(first);
    case "tostring":
    case "format":
      return text(first);
    case "now":
      return new Date().toISOString();
    case "today":
      return new Date().toISOString().slice(0, 10);
    case "dateadd":
    case "datesubtract": {
      const date = dateValue(first);
      const amount = numeric(args[1] ?? 0);
      const unit = text(args[2] ?? "day")
        .toLowerCase()
        .replace(/s$/, "");
      const direction = name.toLowerCase() === "dateadd" ? 1 : -1;
      if (unit === "month" || unit === "quarter" || unit === "year") {
        const months = amount * (unit === "year" ? 12 : unit === "quarter" ? 3 : 1) * direction;
        const day = date.getDate();
        date.setDate(1);
        date.setMonth(date.getMonth() + months);
        const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        date.setDate(Math.min(day, lastDay));
      } else {
        date.setTime(date.getTime() + amount * unitMilliseconds(unit) * direction);
      }
      return date.toISOString();
    }
    case "datebetween": {
      const start = dateValue(first);
      const end = dateValue(args[1] ?? null);
      const unit = text(args[2] ?? "day")
        .toLowerCase()
        .replace(/s$/, "");
      if (unit === "month") {
        return (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
      }
      if (unit === "quarter") {
        const months =
          (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
        return Math.trunc(months / 3);
      }
      if (unit === "year") return end.getFullYear() - start.getFullYear();
      return Math.trunc((end.getTime() - start.getTime()) / unitMilliseconds(unit));
    }
    case "datestart":
      return dateValue(first).toISOString().slice(0, 10);
    case "dateend":
      return dateValue(first).toISOString().slice(0, 10);
    case "formatdate": {
      const date = dateValue(first);
      const format = text(args[1] ?? "YYYY-MM-DD");
      const pad = (value: number) => String(value).padStart(2, "0");
      return format
        .replaceAll("YYYY", String(date.getFullYear()))
        .replaceAll("MM", pad(date.getMonth() + 1))
        .replaceAll("DD", pad(date.getDate()))
        .replaceAll("HH", pad(date.getHours()))
        .replaceAll("mm", pad(date.getMinutes()));
    }
    default:
      throw new Error(`Unsupported formula function: ${name}`);
  }
}

export function evaluateFormula(
  source: string,
  property: (name: string) => FormulaValue,
): FormulaValue {
  const tokens = tokenize(source);
  let cursor = 0;
  const peek = () => tokens[cursor];
  const consume = () => tokens[cursor++];
  const isOperator = (...values: string[]) => {
    const token = peek();
    return token?.type === "operator" && values.includes(token.value);
  };
  const match = (value: string) => {
    if (peek()?.value !== value) return false;
    cursor++;
    return true;
  };
  const skipToDelimiter = (delimiter: "," | ")") => {
    let depth = 0;
    while (cursor < tokens.length) {
      const token = peek();
      if (token?.type === "punctuation") {
        if (token.value === "(") depth++;
        else if (token.value === ")") {
          if (depth === 0) return;
          depth--;
        } else if (token.value === delimiter && depth === 0) {
          return;
        }
      }
      cursor++;
    }
  };

  function primary(): FormulaValue {
    const token = consume();
    if (!token) throw new Error("Formula is incomplete");
    if (token.type === "number" || token.type === "string") return token.value;
    if (token.type === "operator" && token.value === "!") return !truthy(unary());
    if (token.type === "punctuation" && token.value === "(") {
      const value = logicalOr();
      if (!match(")")) throw new Error("Formula is missing a closing parenthesis");
      return value;
    }
    if (token.type === "identifier") {
      const name = token.value;
      if (name.toLowerCase() === "true") return true;
      if (name.toLowerCase() === "false") return false;
      if (name.toLowerCase() === "null") return null;
      if (!match("(")) throw new Error(`Unknown formula name: ${name}`);
      if (name.toLowerCase() === "if") {
        const condition = logicalOr();
        if (!match(",")) throw new Error("if() expects three arguments");
        if (truthy(condition)) {
          const result = logicalOr();
          if (!match(",")) throw new Error("if() expects three arguments");
          skipToDelimiter(")");
          if (!match(")")) throw new Error("if() is missing a closing parenthesis");
          return result;
        }
        skipToDelimiter(",");
        if (!match(",")) throw new Error("if() expects three arguments");
        const result = logicalOr();
        if (!match(")")) throw new Error("if() expects three arguments");
        return result;
      }
      const args: FormulaValue[] = [];
      if (!match(")")) {
        do {
          args.push(logicalOr());
        } while (match(","));
        if (!match(")")) throw new Error(`Function "${name}" is missing a closing parenthesis`);
      }
      if (name.toLowerCase() === "prop") {
        if (args.length !== 1 || typeof args[0] !== "string") {
          throw new Error("prop() expects one quoted property name");
        }
        return property(args[0]);
      }
      return callFunction(name, args);
    }
    throw new Error("Formula has an unexpected token");
  }

  function unary(): FormulaValue {
    if (match("-")) return -numeric(unary());
    if (match("+")) return numeric(unary());
    return primary();
  }

  function multiplicative(): FormulaValue {
    let left = unary();
    while (isOperator("*", "/", "%")) {
      const operator = consume()?.value;
      const right = unary();
      if (operator === "*") left = numeric(left) * numeric(right);
      else if (operator === "/") {
        if (numeric(right) === 0) throw new Error("Formula cannot divide by zero");
        left = numeric(left) / numeric(right);
      } else left = numeric(left) % numeric(right);
    }
    return left;
  }

  function additive(): FormulaValue {
    let left = multiplicative();
    while (isOperator("+", "-")) {
      const operator = consume()?.value;
      const right = multiplicative();
      if (operator === "-" || (typeof left === "number" && typeof right === "number")) {
        left = operator === "-" ? numeric(left) - numeric(right) : numeric(left) + numeric(right);
      } else {
        left = text(left) + text(right);
      }
    }
    return left;
  }

  function comparison(): FormulaValue {
    let left = additive();
    while (isOperator("==", "!=", ">", "<", ">=", "<=")) {
      const operator = consume()?.value;
      const right = additive();
      const numericComparison = typeof left === "number" && typeof right === "number";
      const comparison = numericComparison
        ? numeric(left) - numeric(right)
        : text(left).localeCompare(text(right), undefined, { numeric: true });
      if (operator === "==") left = comparison === 0;
      else if (operator === "!=") left = comparison !== 0;
      else if (operator === ">") left = comparison > 0;
      else if (operator === "<") left = comparison < 0;
      else if (operator === ">=") left = comparison >= 0;
      else left = comparison <= 0;
    }
    return left;
  }

  function logicalAnd(): FormulaValue {
    let left = comparison();
    while (match("&&")) {
      const right = comparison();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  function logicalOr(): FormulaValue {
    let left = logicalAnd();
    while (match("||")) {
      const right = logicalAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  const result = logicalOr();
  if (cursor !== tokens.length) throw new Error(`Unexpected formula token: ${peek()?.value}`);
  if (typeof result === "number" && !Number.isFinite(result)) {
    throw new Error("Formula result is not a finite number");
  }
  return result;
}
