// Publish guard for the all-versions export (#52, ADR 0015). The CSV merges columns by name across
// versions (`<id>`, `<id>_<statement number>`), so a new version must not give an existing name a
// different meaning. Compared with every earlier version, not just the latest: dropping statement 3
// in v2 and adding a different one in v3 would otherwise pass.
import { optionValues, type Question, type Survey } from "./model";

const questions = (m: Survey) => m.pages.flatMap((p) => p.questions);

/** One CSV export column (exporter and codebook). Likert gives `<id>_<n>`, Other text `<id>_other`. */
export type Column = {
  name: string;
  questionId: string;
  type: Question["type"];
  part: "value" | "other" | "statement";
  statement?: number;
  freeText: boolean; // respondent-written text: untrusted, may identify people
};

export const columnsFor = (model: Survey): Column[] =>
  questions(model).flatMap((q): Column[] => {
    const base = { questionId: q.id, type: q.type };
    if (q.type === "likert")
      return q.statements.map((_, i) => ({
        ...base,
        name: `${q.id}_${i + 1}`,
        part: "statement" as const,
        statement: i + 1,
        freeText: false,
      }));
    const cols: Column[] = [{ ...base, name: q.id, part: "value", freeText: q.type === "text" }];
    if ((q.type === "choice" || q.type === "multi") && q.other)
      cols.push({ ...base, name: `${q.id}_other`, part: "other", freeText: true });
    return cols;
  });

/** Plain-language list of changes in `next` that would change what an existing export column
 * means. Empty when `next` only appends statements, adds options or adds/removes questions.
 * `earlier` is oldest first; changes the latest version already has were accepted (forced) when it
 * was published, so they are not reported again. */
export function exportChanges(earlier: Survey[], next: Survey): string[] {
  const latest = earlier.at(-1);
  const accepted = new Set(latest ? diff(earlier, latest) : []);
  return diff(earlier, next).filter((c) => !accepted.has(c));
}

function diff(earlier: Survey[], next: Survey): string[] {
  const out = new Set<string>();
  const nextCols = columnsFor(next);
  for (const old of earlier) {
    const byId = new Map(questions(old).map((q) => [q.id, q]));
    // #95: a column name now produced by a different question (v1 likert #r gives r_1, v2 has #r_1).
    const owner = new Map(columnsFor(old).map((c) => [c.name, c.questionId]));
    for (const c of nextCols) {
      const was = owner.get(c.name);
      if (was !== undefined && was !== c.questionId)
        out.add(
          `The export column '${c.name}' was part of '${was}' and is now part of '${c.questionId}'.`,
        );
    }
    for (const q of questions(next)) {
      const o = byId.get(q.id);
      if (!o) continue;
      if (o.type !== q.type)
        out.add(`'${q.id}' was a .${o.type} question and is now a .${q.type} question.`);
      else if (o.type === "likert" && q.type === "likert")
        o.statements.forEach((t, i) => {
          const n = q.statements[i];
          if (n !== undefined && n !== t)
            out.add(`In '${q.id}', statement ${i + 1} was "${t}" and is now "${n}".`);
        });
      else if ("options" in o && "options" in q) {
        // #122: compare stored values; rewording a label whose {value=} is unchanged is free.
        const now = optionValues(q);
        const valued = o.values !== undefined || q.values !== undefined;
        optionValues(o).forEach((v, i) => {
          if (now.includes(v)) return;
          out.add(
            valued
              ? `In '${q.id}', the option value "${v}" ("${o.options[i]}") was removed or changed.`
              : `In '${q.id}', the option "${v}" was removed or renamed.`,
          );
        });
        // The Other label is the category in the main column, so renaming it splits it (#95).
        if (o.other !== undefined && q.other !== undefined && o.other !== q.other)
          out.add(`In '${q.id}', the Other label was "${o.other}" and is now "${q.other}".`);
      }
    }
  }
  return [...out];
}
