const MAX_CUSTOM_CSS_BYTES = 64 * 1024;

function stripCssCommentsAndStrings(css: string): string {
  let result = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (character === quote) quote = null;
      result += " ";
    } else if (character === "'" || character === '"') {
      quote = character;
      result += " ";
    } else if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Custom CSS contains an unfinished comment");
      result += " ";
      index = end + 1;
    } else {
      result += character;
    }
  }
  if (quote) throw new Error("Custom CSS contains an unfinished string");
  return result;
}

export function validateCustomCss(value: unknown): string {
  if (typeof value !== "string") throw new Error("Custom CSS must be text");
  if (new TextEncoder().encode(value).length > MAX_CUSTOM_CSS_BYTES) {
    throw new Error("Custom CSS must be 64 KB or smaller");
  }
  if (value.includes("\\")) {
    throw new Error("Custom CSS cannot use escape sequences");
  }
  const code = stripCssCommentsAndStrings(value).toLowerCase();
  if (/@import\b|\burl\s*\(|\b(?:-webkit-)?image-set\s*\(/i.test(code)) {
    throw new Error("Custom CSS cannot load external resources");
  }
  return value;
}

export function validateAccentColor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value)) {
    throw new Error("Accent color must be a six-digit hex color");
  }
  return value.toLowerCase();
}
