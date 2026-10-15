// Publish guard for the all-versions export (#52, ADR 0015). The CSV merges columns by name across
// versions (`<id>`, `<id>_<statement number>`), so a new version must not give an existing name a
// different meaning. Compared with every earlier version, not just the latest: dropping statement 3
// in v2 and adding a different one in v3 would otherwise pass.
import type { Survey } from "./model";

const questions = (m: Survey) => m.pages.flatMap((p) => p.questions);

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
  for (const old of earlier) {
    const byId = new Map(questions(old).map((q) => [q.id, q]));
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
      else if ("options" in o && "options" in q)
        for (const opt of o.options)
          if (!q.options.includes(opt))
            out.add(`In '${q.id}', the option "${opt}" was removed or renamed.`);
    }
  }
  return [...out];
}
