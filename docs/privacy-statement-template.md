# Privacy statement template

A plain-language statement for survey authors to adapt. It is shown on the participant page above the questions. Paste your version into the publish dialog (or the `privacyStatement` field of `POST .../publish`); it is stored with each published version, so participants' view is recorded.

How to use it:
- Replace every `[[PLACEHOLDER]]`. Delete any optional paragraph that does not apply.
- Do not add promises the software or your host cannot keep. Each sentence below says what it relies on; check those before publishing.
- Keep it short. Markdown works: paragraphs, lists, **bold**, links.
- The built-in default (`DEFAULT_PRIVACY_STATEMENT` in `apps/server/src/surveys.ts`) is the first two paragraphs below, reworded. Use it only if you have nothing to add; most surveys should say who runs them and how long data is kept.

---

## Template

**Who is asking.** This survey is run by [[TEAM OR PROJECT NAME]] for [[EVENT NAME]]. Questions about it: [[CONTACT EMAIL]].

**What we collect.** Only your answers to the questions below, the survey version you answered, and the time you submitted. We do not ask for your name or email address. The survey page sets no cookies and stores nothing in your browser. Your answers are saved without your IP address or browser details.

**What others may see.** [[HOSTING ORGANISATION]] runs the service that hosts this page. [[Its web servers keep no record of visitors' IP addresses for this site. | Its web servers keep connection logs, which include IP addresses, for [[N]] days.]] [[OPTIONAL, if behind a CDN: Traffic passes through [[CDN, e.g. Cloudflare]], which processes connection details such as IP addresses under its own privacy policy: [[LINK]].]] Your network or employer may also log that you visited this site.

**Staying anonymous.** Free-text answers can identify you. Leave out names, job titles and other details if you want to stay anonymous. In small groups, a combination of answers (for example your role and institution) can identify you even without free text. [[OPTIONAL: Answer only the questions you are comfortable with; none of the demographic questions are required.]]

**Who can read the answers.** The [[TEAM]] members working on this event's evaluation, and the administrators of this service, can read individual answers. [[OPTIONAL: Results shared outside the team, for example in reports to [[FUNDER]], are summaries only. We do not report groups smaller than [[5]] people, and we do not quote free text that could identify someone.]]

**How answers are used.** [[PURPOSE, e.g. "to evaluate and improve this event and to report on it to [[FUNDER]]".]] [[OPTIONAL: Anonymised answers may be used in research publications.]] Answers are never sent to AI services.

**How long we keep them.** [[RETENTION, e.g. "We delete individual answers [[12 months]] after the event; summaries may be kept longer."]] Backups are kept for up to [[N]] days after that.

**Withdrawing.** Because we do not know who you are, we usually cannot find or remove your individual answers after you submit them. [[OPTIONAL: If you wrote something identifying and want it removed, email [[CONTACT EMAIL]] with the approximate time you submitted and what you wrote.]]

[[OPTIONAL, for regulated contexts: Your rights under [[LAW, e.g. GDPR]] and the contact for our data protection officer: [[LINK]].]]

---

## What each sentence relies on

| Sentence | True because | Check before publishing |
|---|---|---|
| "We do not ask for your name or email address." | v1 has no participant identity ([ADR 0004](adr/0004-anonymous-link-only-v1.md)). | Your survey has no question asking for them. |
| "What we collect: answers, version, time." | A response row is `answers`, `survey_version_id`, `submitted_at` (`apps/server/src/schema/index.ts`). | Nothing to check. |
| "Sets no cookies and stores nothing in your browser." | Participant routes never set cookies (`participantGuard`, `apps/server/src/app.ts`); the page keeps state in memory (`apps/web/src/ParticipantPage.tsx`). | No CDN feature sets cookies on your domain (Cloudflare Bot Fight Mode, challenges and some analytics do). See [deploy.md](deploy.md#cloudflare). |
| "Saved without your IP address or browser details." | The app never reads IP or user-agent headers and its log has method, path and status only. | Nothing in the app; but see the next row. |
| "[Host] keeps no record of IP addresses." | Only if the reverse proxy is configured as in [deploy.md](deploy.md). | Ask the operator. If unsure, use the "keeps connection logs" wording. |
| "Administrators of this service can read individual answers." | Global admins pass every group check (`authorize`, `apps/server/src/authz.ts`), and the operator can read the database. | Nothing to check; do not remove this. |
| "Never sent to AI services." | Invariant in AGENTS.md; no code sends responses anywhere. | Your own analysis workflow does not paste exports into an AI tool. If it does, say so. |
| Retention period | **Not enforced by the software yet** ([#36](https://github.com/seandavi/plainfeedback/issues/36)). Deletion is a manual operator task. | The operator has agreed to delete on that date, and backups expire. |
| Withdrawal | No identifier exists, so a response can only be found by its content or time. | Do not promise deletion on request. |

Do not write "anonymous" without qualification. "We do not collect your name or email" is accurate; "your answers are anonymous" is not, for the reasons in [threat-model.md](threat-model.md).
