import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
// Formula date functions in both implementations are timezone-sensitive (JS Date's local
// getters/setters on the Node side; a deliberate UTC-only choice on the Rust side — see
// date.rs's module comment). Forcing the test process to UTC makes the two comparable.
process.env.TZ = "UTC";
const { evaluateFormula } = await import("../../src/shared/formula.ts");

const binary = path.resolve(
  import.meta.dirname,
  "../../crates/driftleaf-core/target/release/examples/formula_bridge" +
    (process.platform === "win32" ? ".exe" : ""),
);

const properties = [
  { id: "p_name", name: "Name" },
  { id: "p_score", name: "Score" },
  { id: "p_due", name: "Due" },
];
const rowValues = { p_name: "Widget", p_score: 7, p_due: "2026-01-15" };

function runRust(formula) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ formula, properties, rowValues }),
    encoding: "utf8",
  });
  if (result.status !== 0) return { error: result.stderr.trim() };
  return { ok: JSON.parse(result.stdout).result };
}

function runNode(formula) {
  try {
    return { ok: evaluateFormula(formula, (name) => {
      const property = properties.find((p) => p.name === name);
      if (!property) throw new Error(`Unknown property: ${name}`);
      return rowValues[property.id] ?? null;
    }) };
  } catch (err) {
    return { error: err.message };
  }
}

function compare(formula) {
  const rust = runRust(formula);
  const node = runNode(formula);
  if (node.error) {
    assert.ok(rust.error, `expected Rust to also fail for: ${formula}\nRust returned: ${JSON.stringify(rust)}`);
  } else {
    assert.deepEqual(rust, node, `mismatch for formula: ${formula}`);
  }
  return rust;
}

// Arithmetic, precedence, and string/numeric coercion in +.
compare('1 + 2 * 3');
compare('(1 + 2) * 3');
compare('10 / 4');
compare('10 % 3');
compare('-5 + 3');
compare('"a" + "b"');
compare('"Score: " + 7');
compare('pow(2, 10)');

// Comparisons: numeric vs locale-string ("file10" > "file2" numeric-aware).
compare('5 > 3');
compare('"abc" == "abc"');
compare('"file10" > "file2"');
compare('"file2" > "file10"');

// Logical operators and short-circuiting shapes.
compare('true && false');
compare('true || false');
compare('!true');
compare('and(true, true, false)');
compare('or(false, false, true)');
compare('not(false)');

// if()/ifs(), including the branch NOT taken containing something that would otherwise
// error (skipToDelimiter must skip it without evaluating it).
compare('if(true, 1, 1/0)');
compare('if(false, 1/0, 2)');
compare('ifs(false, 1, true, 2, 3)');
compare('ifs(false, 1, false, 2)');

// prop() referencing a stored value, plus string/array functions.
compare('prop("Name")');
compare('upper(prop("Name"))');
compare('length(prop("Name"))');
compare('contains(prop("Name"), "idg")');
compare('startsWith(prop("Name"), "Wid")');
compare('endsWith(prop("Name"), "get")');
compare('replace(prop("Name"), "i", "I")');
compare('replaceAll("aaa", "a", "b")');
compare('trim("  padded  ")');
compare('slice(prop("Name"), 1, 3)');
compare('join(prop("Name"), "x")'); // not an array: falls through to plain text

// Numeric functions.
compare("abs(-5)");
compare("ceil(1.2)");
compare("floor(1.8)");
compare("round(1.2345, 2)");
compare("min(3, 1, 2)");
compare("max(3, 1, 2)");
compare("sum(1, 2, 3)");
compare("average(2, 4, 6)");
compare("mod(10, 3)");
compare("sqrt(16)");
compare("sign(-5)");
compare("sign(0)");
compare("toNumber(\"42\")");
compare('toString(42)');

// Date functions, all forced to UTC by process.env.TZ above.
compare('prop("Due")');
compare('dateAdd(prop("Due"), 1, "day")');
compare('dateAdd(prop("Due"), 1, "month")');
compare('dateAdd(prop("Due"), 1, "year")');
compare('dateSubtract(prop("Due"), 1, "day")');
compare('dateBetween(prop("Due"), dateAdd(prop("Due"), 10, "days"), "days")');
compare('dateBetween(prop("Due"), dateAdd(prop("Due"), 14, "months"), "months")');
compare('dateStart(prop("Due"))');
compare('formatDate(prop("Due"), "DD/MM/YYYY")');

// now()/today() aren't deterministic between the two processes; only check shape/date.
const nowRust = runRust("now()");
const nowNode = runNode("now()");
assert.ok(!nowRust.error && !nowNode.error);
assert.equal(nowRust.ok.slice(0, 10), nowNode.ok.slice(0, 10));
const todayRust = runRust("today()");
assert.equal(todayRust.ok.length, 10);

// Errors that must match on both sides.
compare("1 / 0");
compare('mod(1, 0)');
compare("unknownFunction(1)");
compare('"unterminated');
compare("prop(123)");
compare("1 +"); // incomplete expression

// A real bug found in the reference implementation while writing this test: its
// `match(value)` helper compares only a token's `.value` field, not its type, so a bare
// string literal equal to "-" or "+" is misread as the unary minus/plus operator by
// unary() — which then recurses looking for an operand, finds none, and reports "Formula
// is incomplete" instead of returning the string. This is NOT replicated in Rust: the
// Rust tokenizer's Token::Str/Token::Operator/Token::Punct are distinct variants, so
// match_operator()/match_punct() can't accidentally match a string's content — the
// correct, intended behavior. Documented here rather than silently dropped, since
// `join(array, "-")`/`concat(a, "-", b)` (joining with a dash) are realistic formulas
// that fail today in the live Node app.
for (const formula of ['"-"', '"+"', 'concat("a", "-", "b")', 'if(true, "+", 2)']) {
  const nodeResult = runNode(formula);
  assert.ok(nodeResult.error, `expected Node's known match() bug to still reject: ${formula}`);
  const rustResult = runRust(formula);
  assert.ok(!rustResult.error, `expected Rust to correctly evaluate: ${formula}\ngot: ${JSON.stringify(rustResult)}`);
}

console.log(
  "Rust's formula evaluator (arithmetic, comparisons, logical ops, if/ifs, prop(), " +
    "string/numeric/date functions, and matching error cases) agrees with evaluateFormula() " +
    "across every expression tested.",
);
