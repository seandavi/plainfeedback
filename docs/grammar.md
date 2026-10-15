# Writing a survey in markdown

A plainfeedback survey is a plain text file. You write a title, an optional
introduction, and then one block per question. The app turns the file into the
survey people see; if something is wrong, it tells you the line number and what
to fix.

This page is the full reference. The [example at the end](#full-example-cfde-fall-2026-meeting-feedback)
shows a complete survey.

## The shape of a survey

```markdown
# Survey title

Introduction text. Optional. Ordinary markdown: **bold**, _italics_,
[links](https://example.org), lists.

::: {.text #comments}
Any comments?
:::
```

1. **Title.** The first line is the title, written after a single `#` and a space.
2. **Introduction.** Everything between the title and the first question. It
   can be several paragraphs and can contain links.
3. **Questions.** Each question is a block that starts with a line like
   `::: {.text #comments}` and ends with a line of just `:::`.

Nothing may come after the last question except blank lines, and text between
questions is not allowed: put it in a question's prompt or in the introduction.

## Questions

A question block has three parts:

```markdown
::: {.choice #role required}
What is your role?
- Researcher
- Student
:::
```

- **The opening line** gives the question's **type** (`.choice`), its **id**
  (`#role`) and any **settings** (`required`), all inside `{ }`.
- **The prompt** is the text inside the block: the question people read. It can
  use markdown, including links and several paragraphs.
- **A list** (lines starting with `- `) gives the options or statements, for the
  types that need them. A long list item can continue on the next line if that
  line is indented.

### The id

Every question needs an id written after `#`. Answers are stored and exported
under it, so pick something short and meaningful, and keep it the same when you
edit the wording. Ids use lowercase letters, digits, `-` and `_`, start with a
letter, and must be different for each question in the survey. Good:
`#affiliation`, `#years-in-field`, `#q3`. An id also can't be `seq` or the name
of another question's export column: a rating grid `#r` exports `r_1`, `r_2`,
..., and a question `#c` with an Other box exports `c_other`.

To ask the same questions at another event, or before and after one, copy the
survey instead of retyping it: **Duplicate** next to a survey on the event page
copies its draft into a new survey in the same or another event of the group,
and **Start from** on the new-survey form offers the CFDE example. Keep the ids
of copied questions unchanged, so answers line up across events; give a new id
only to a question whose meaning changed.

Once a survey has responses, publishing asks you to confirm changes that would
mix different answers in one export column: reordering, inserting or rewording
rating-grid statements (add new ones at the end instead), reusing an id for a
different question type (use a new id), removing or renaming an option, renaming
the Other label, or giving an earlier question's export column (such as `r_1`) to
a new question.
Adding questions, options and statements at the end needs no confirmation.

### Settings for every question

| Setting | Meaning |
|---|---|
| `required` | People must answer before they can submit. Without it, the question is optional. |

### Question types

| Type | What people do | List items are | Settings |
|---|---|---|---|
| `.choice` | Pick one option | options (at least two) | `other` |
| `.multi` | Pick any number of options | options (at least two) | `other` |
| `.likert` | Rate each statement on one shared scale | statements (at least one) | `scale`, `low`, `mid`, `high` |
| `.text` | Type an answer | (no list) | `maxlength`, `multiline` |
| `.number` | Enter a number | (no list) | `min`, `max` |

#### Single choice: `.choice`

```markdown
::: {.choice #affiliation required other="Other"}
Please specify your CFDE affiliation.
- CFDE Center Member
- CFDE DCC Member
- NIH Representative
:::
```

- `other="Label"` adds a last option with a text box, so people can write their
  own answer. Write just `other` for the label "Other". Leave it out if people
  must pick from the list.

#### Multiple choice: `.multi`

Same as `.choice`, but people may tick several options (or none, unless
`required`). `other` works the same way. Options and the `other` label can't
contain `;`, because the CSV export joins the ticked options with `;`.

#### Rating grid: `.likert`

Every statement is rated on the same scale. This is the right type for a block
of "How satisfied / how useful / how familiar" questions.

```markdown
::: {.likert #ratings scale="1-5" low="Not at all / Poor" mid="Somewhat / Okay" high="Very / Excellent"}
Answer any applicable questions:
- Before attending, how familiar were you with the CFDE?
- After attending, how familiar do you feel with the CFDE?
:::
```

| Setting | Default | Meaning |
|---|---|---|
| `scale="1-5"` | `1-5` | Lowest and highest rating, as whole numbers. At most 11 points (`0-10` works). |
| `low="..."` | none | Label shown at the low end. |
| `mid="..."` | none | Label shown at the middle point. Only for scales with a middle (an odd number of points). |
| `high="..."` | none | Label shown at the high end. |

`required` on a grid means every statement must be rated. Without it, people
rate the statements that apply to them.

The `low` and `high` labels are repeated under every statement so they stay in
view on a phone; keep them short (a word or two). If statements need different
labels, use separate grids.

#### Free text: `.text`

```markdown
::: {.text #elaborate multiline maxlength=2000}
Please elaborate on your answers above.
:::
```

| Setting | Default | Meaning |
|---|---|---|
| `multiline` | off | A large box for paragraphs instead of a one-line field. |
| `maxlength=N` | `2000` | Longest answer, in characters. |

#### Number: `.number`

```markdown
::: {.number #years min=0 max=60}
How many years have you worked in this field?
:::
```

`min` and `max` are optional and may be decimals.

### Writing settings

- A setting with a value is `name=value`. Use quotes when the value has spaces:
  `low="Not at all"`. Single quotes also work. Use straight quotes: curly quotes
  (`“ ”`), which Word and Google Docs insert, are reported as an error.
- `required`, `multiline` and `other` can be written on their own.
- Settings can come in any order. A misspelled setting is an error, not ignored.

## Not supported yet

These are planned (see `docs/design.md`, "Conditionals and pages"). For now they
give an error rather than being silently ignored:

- **Conditional questions** (`show-if="..."`).
- **Multiple pages**, written as `---` lines or `##` headings between questions.
  A survey is one page.

## When something is wrong

The app lists every problem it finds, each with a line number, for example:

- `Line 7: Unknown question type '.radio'. Use one of: .choice, .multi, .likert, .text, .number.`
- `Line 12: The id '#role' is already used on line 3.`
- `Line 15: A .choice question needs at least two options, written as '- ' list items.`
- `Line 20: The scale "5-1" must go from low to high, like scale="1-5".`
- `Line 31: This question block is never closed. Add a line with just ':::' after it.`

## Full example: CFDE Fall 2026 meeting feedback

This survey has a single-choice question with an Other box, a 13-statement rating
grid on one 1 to 5 scale, and four free-text questions. The structure follows
the real CFDE Fall 2026 form.

```markdown
# 2026 Fall Meeting Feedback

We want to hear your feedback so we can keep improving our logistics and content.
Please fill this quick survey and let us know your thoughts (we do not ask for your
name or email). As a reminder, the agenda is [here](https://example.org/agenda).

::: {.choice #affiliation required other="Other"}
What is your main CFDE affiliation?
- CFDE Center Member
- CFDE DCC Member
- CFDE Program Member (not DCC affiliated)
- NIH Representative
:::

::: {.likert #ratings scale="1-5" low="Not at all · None · Poor · Very unlikely · Very dissatisfied" mid="Somewhat · Okay" high="Very · All · Excellent · Definitely · Very satisfied"}
Answer any applicable questions on a scale from low to high:
- Before attending, how familiar were you with the CFDE?
- After attending, how familiar do you feel with the CFDE?
- How much of the duration were you able to attend?
- How relevant was the content to your work and interests?
- How engaged were you?
- How much did you participate?
- How likely/prepared are you to use the resources you heard about in your work?
- How many of your questions about the resources got answered?
- How well did the event facilitate new connections and collaborations?
- How suitable were the dates/times/length?
- How suitable was the venue (incl. accommodations, food/drink, etc.) or technology platform?
- How well was the event organized and communicated (pre/during/post)?
- Overall, how satisfied are you?
:::

::: {.text #elaborate multiline maxlength=2000}
Please elaborate on your answers above and share any other notes.
:::

::: {.text #most-valuable multiline maxlength=2000}
Which sessions or content did you find most valuable? See [here](https://example.org/agenda) for the agenda.
:::

::: {.text #least-valuable multiline maxlength=2000}
Which sessions or content did you find least valuable? See [here](https://example.org/agenda) for the agenda.
:::

::: {.text #spring-2027 multiline maxlength=2000}
What would you like to see included in the Spring 2027 meeting?
:::
```

It compiles to the model in
[`packages/core/src/fixtures/cfde-fall-2026.json`](https://github.com/seandavi/plainfeedback/blob/main/packages/core/src/fixtures/cfde-fall-2026.json).

---

## For developers

### The compiled model

The compiler (`compile` in `packages/core`) produces this JSON. The zod schema
in `packages/core/src/model.ts` is authoritative.

```ts
{
  title: string,
  intro?: string,              // markdown source
  pages: [{ questions: Question[] }],   // always one page in phase 1
}
// every Question has:
{ id, type, prompt /* markdown source */, required: boolean, visibleIf?: string /* reserved */ }
// plus, by type:
choice | multi: { options: string[], other?: string /* label */ }
likert: { statements: string[], scale: { min, max }, anchors: { low?, mid?, high? } }
text:   { maxlength: number /* default 2000 */, multiline: boolean }
number: { min?: number, max?: number }
```

Prompts and the intro are stored as markdown source. Rendering them to HTML,
and sanitizing it, is the web app's job, so `core` stays free of I/O and
rendering. Errors are `{ line, column?, message }` with 1-based lines.

### Answers

A response is an object keyed by question id. `validateAnswers(model, answers)`
returns `{ [questionId]: message }`, empty when valid. The browser and server
use the same function. The server first applies `normalizeAnswers` (trim
strings, drop unrated Likert statements and empty answers), then validates and
stores the normalised object.

| Type | Answer |
|---|---|
| `choice` | The chosen option's text. With `other`, any other string (at most 500 characters) is the "Other" text. |
| `multi` | An array of distinct option texts. With `other`, at most one entry may be "Other" text. |
| `likert` | An object from statement number (`"1"`, `"2"`, ... in list order) to an integer rating within the scale. Unrated statements are left out (or `null`). |
| `text` | A string of at most `maxlength` characters. |
| `number` | A finite number within `min`/`max`. |

A missing answer, `null`, an empty or blank string, an empty array and an empty
object all count as unanswered, with one exception: for a question with `other`,
a blank string (or a blank entry in a `multi` array) means "Other" was picked and
left empty, and is rejected with a message asking to describe it. Answers for ids that are not in the survey are
rejected. Published versions are immutable, so statement numbers and option
texts are stable within a version.
