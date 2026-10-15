// Privacy statement texts (#65). Keep in line with docs/privacy-statement-template.md. The default
// claims only what the software does; who runs the survey, a contact and retention are the
// author's to add, so the publish dialog starts from the template with [[...]] placeholders.

const COLLECT =
  "**What we collect.** Only your answers, the survey version you answered and the time you " +
  "submitted, recorded to the hour only. This survey does not ask for your name or email address. " +
  "The survey page sets no cookies and stores nothing in your browser, and your answers are saved " +
  "without your IP address or browser details. IP addresses are processed transiently in memory " +
  "to limit abuse and are never stored or logged by the application. The service hosting this " +
  "page and the networks in between may keep their own connection logs.";
const ANONYMOUS =
  "**Staying anonymous.** Free-text answers can still identify you, so leave out names and other " +
  "details if you want to stay anonymous.";
const READERS =
  "**Who can read the answers.** The survey organisers and the administrators of this service " +
  "can read individual answers.";

/** Used when a version is published without a statement. Never contains placeholders. */
export const DEFAULT_PRIVACY_STATEMENT = [
  COLLECT,
  ANONYMOUS,
  READERS,
  "**How long we keep them.** Until the survey organisers delete them; this service does not " +
    "delete answers automatically.",
].join("\n\n");

/** Starting text for the publish dialog; publishing is refused until every [[...]] is replaced. */
export const PRIVACY_STATEMENT_TEMPLATE = [
  "**Who is asking.** This survey is run by [[TEAM OR PROJECT NAME]]. Questions about it: " +
    "[[CONTACT EMAIL]].",
  COLLECT,
  ANONYMOUS,
  READERS,
  '**How long we keep them.** [[RETENTION, e.g. "We delete individual answers 12 months after ' +
    'the event."]]',
].join("\n\n");

/** True while a statement still has template placeholders in it. */
export const hasPlaceholder = (s: string) => /\[\[.*?\]\]/s.test(s);
