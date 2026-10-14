// Minimal markdown for survey intros and prompts: paragraphs, lists, bold, italic, code, links.
// ponytail: hand-rolled instead of a library because it builds React elements, never HTML strings,
// so raw HTML is just text and there is no sanitizer to configure. Images render as their alt text
// (no third-party requests). Add a library if authors need tables or nesting.
import { Fragment, type ReactNode } from "react";

const INLINE =
  /(`+)([^`]+?)\1|!\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|(?<!\w)__(.+?)__(?!\w)|\*(.+?)\*|(?<!\w)_(.+?)_(?!\w)|\\([\\`*_[\]()!#.-])/gs;
const SAFE_URL = /^(https?:|mailto:)/i;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const k = out.length;
    const [, , code, alt, label, href, strong, strong2, em, em2, escaped] = m;
    if (code !== undefined) out.push(<code key={k}>{code}</code>);
    else if (alt !== undefined) out.push(alt);
    else if (label !== undefined && href !== undefined)
      out.push(
        SAFE_URL.test(href) ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {inline(label)}
          </a>
        ) : (
          <Fragment key={k}>{inline(label)}</Fragment>
        ),
      );
    else if ((strong ?? strong2) !== undefined)
      out.push(<strong key={k}>{inline((strong ?? strong2) as string)}</strong>);
    else if ((em ?? em2) !== undefined) out.push(<em key={k}>{inline((em ?? em2) as string)}</em>);
    else out.push(escaped);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

/** Inline markdown on one line, for prompts inside labels and legends. */
export const MarkdownInline = ({ text }: { text: string }) => (
  <>{inline(text.replace(/\s*\n\s*/g, " "))}</>
);

/** Block markdown: paragraphs and flat lists. Headings render as bold paragraphs. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        for (const [re, Tag] of [
          [BULLET, "ul"],
          [NUMBERED, "ol"],
        ] as const) {
          if (lines.every((l) => re.test(l)))
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: static content
              <Tag key={i}>
                {lines.map((l, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static content
                  <li key={j}>{inline(l.replace(re, ""))}</li>
                ))}
              </Tag>
            );
        }
        const heading = /^#{1,6}\s+/.test(block);
        const body = inline(block.replace(/^#{1,6}\s+/, "").replace(/\s*\n\s*/g, " "));
        // biome-ignore lint/suspicious/noArrayIndexKey: static content
        return <p key={i}>{heading ? <strong>{body}</strong> : body}</p>;
      })}
    </>
  );
}
