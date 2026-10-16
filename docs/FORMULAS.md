# Database Formulas

A formula makes a read-only value for each row. It can use other properties
from that row, so the result updates when those values change.

## The basics

Add a **Formula (calculated)** property, then enter an expression. Use
`prop("Property name")` to refer to a property; its name must match the column
exactly. Put text in double quotes.

For example, with **Price** and **Quantity** number properties:

```text
prop("Price") * prop("Quantity")
```

This calculates the total for each row.

## Examples

Show a different label depending on a checkbox:

```text
if(prop("Done"), "Complete", "To do")
```

Add a tax amount to a price:

```text
prop("Price") * 1.1
```

Round a calculated value to two decimal places:

```text
round(prop("Price") * 1.1, 2)
```

Check whether a title contains a word:

```text
contains(prop("Title"), "meeting")
```

## Operators and functions

Use `+`, `-`, `*`, and `/` for arithmetic. Compare values with `==`, `!=`,
`>`, `<`, `>=`, and `<=`. Combine checks with `&&` (and), `||` (or), and `!`
(not). Parentheses control the order of calculations. `+` also joins values
when either side is text.

Functions take values in parentheses, separated by commas. Use these
functions:

- **Logic:** `if(condition, yes, no)`, `ifs(condition, result, ..., default)`,
  `and(...)`, `or(...)`, `not(value)`, `empty(value)`
- **Text:** `length(value)`, `contains(value, search)`,
  `startsWith(value, prefix)`, `endsWith(value, suffix)`,
  `replace(value, search, replacement)`,
  `replaceAll(value, search, replacement)`, `lower(value)`, `upper(value)`,
  `trim(value)`, `join(list, separator)`, `slice(text, start, end)`,
  `concat(...)`
- **Numbers:** `abs(value)`, `ceil(value)`, `floor(value)`,
  `round(value, places)`, `min(...)`, `max(...)`, `sum(...)`,
  `average(...)`, `mod(value, divisor)`, `pow(value, exponent)`,
  `sqrt(value)`, `sign(value)`
- **Conversion:** `toNumber(value)`, `toString(value)`, `format(value)`
- **Dates:** `now()`, `today()`, `dateAdd(date, amount, unit)`,
  `dateSubtract(date, amount, unit)`, `dateBetween(start, end, unit)`,
  `dateStart(date)`, `dateEnd(date)`,
  `formatDate(date, "YYYY-MM-DD")`

Date units include milliseconds, seconds, minutes, hours, days, weeks, months,
quarters, and years where applicable. `formatDate` supports `YYYY`, `MM`,
`DD`, `HH`, and `mm`.

For example, add seven days to a date:

```text
dateAdd(prop("Due date"), 7, "days")
```

Formulas use a practical subset of common functions, not the full Notion
formula language. If a formula is invalid, Driftleaf shows an error in that
formula cell. Formula results are calculated values, not editable cells.
