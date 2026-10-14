export type SurveyStatus = "draft" | "not_yet_open" | "open" | "closed";
type When = Date | string | boolean | null | undefined; // closedAt may be just a flag
const t = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

/** The one status rule for the public route, dashboard and editor. Closed wins over not-yet-open; no window = open. */
export function surveyStatus(
  s: {
    published: boolean;
    closedAt?: When;
    opensAt?: Date | string | null;
    closesAt?: Date | string | null;
  },
  now: Date = new Date(),
): SurveyStatus {
  if (!s.published) return "draft";
  const [opens, closes] = [t(s.opensAt), t(s.closesAt)];
  if (s.closedAt || (closes !== null && closes <= now.getTime())) return "closed";
  if (opens !== null && opens > now.getTime()) return "not_yet_open";
  return "open";
}
