// Landing page at / (#141): the deployment's front door for organizers. Lazy-loaded from main.tsx,
// so participants and staff never download it. Screenshots in public/landing/ are captures of the
// real app (sample data, https://feedback.example.org); retake them when the screens change.
import { APP_NAME, compile } from "@plainfeedback/core";
import { SurveyForm } from "./SurveyForm";
import "./landing.css";

const GUIDE = "https://seandavi.github.io/plainfeedback/grammar.html"; // = GRAMMAR_URL in the editor
const SOURCE = "https://github.com/seandavi/plainfeedback";
const SIGN_IN = "/app";

const SAMPLE = `# Workshop feedback

::: {.choice #role required other="Other"}
What was your role at the workshop?
- Speaker
- Attendee
- Organizer
:::

::: {.likert #sessions scale="1-5" low="Poor" high="Excellent"}
Rate the sessions:
- Morning talks
- Afternoon hands-on
:::

::: {.text #change maxlength=500}
What should we change next time?
:::`;
const model = compile(SAMPLE).model;

// One response from a real JSON lines export (sample data), ids left out, shown across lines.
const EXPORT_ROW = `{
  "seq": 3,
  "eventSlug": "fall-2026",
  "eventTitle": "CFDE Fall 2026 Meeting",
  "surveySlug": "feedback",
  "waveLabel": "post",
  "surveyVersion": 1,
  "submittedAt": "2026-11-05T17:00:00Z",
  "answers": {
    "ratings": { "1": 2, "2": 4, "3": 4 },
    "affiliation": "CFDE DCC Member"
  }
}`;

const PROMISES: [string, string][] = [
  ["Cookies", "None on survey pages."],
  ["IP address and browser", "Not logged by the app."],
  ["Submission time", "Stored to the hour, never to the second."],
  ["Other sites", "Survey pages load nothing from anywhere else; the browser enforces it."],
  ["Deleting", "Real: answers go from the database, and backups age out."],
];

const Code = ({ text, label, shown }: { text: string; label: string; shown?: boolean }) => (
  <figure className="code-figure">
    <figcaption className={shown ? "caption" : "sr-only"}>{label}</figcaption>
    <pre className="code-pane">
      <code>
        {text.split("\n").map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text, lines never reorder
          <span key={i} className={line.startsWith(":::") ? "line fence" : "line"}>
            {line || " "}
          </span>
        ))}
      </code>
    </pre>
  </figure>
);

export function Landing() {
  return (
    <div className="landing">
      <header className="mast-nav">
        <div className="frame mast-nav__row">
          <a href={SOURCE}>Source code</a>
          <span className="wordmark">{APP_NAME}</span>
          <a className="key" href={SIGN_IN}>
            Sign in
          </a>
        </div>
      </header>

      <main id="main">
        <section className="hero">
          <div className="frame hero__grid">
            <div className="hero__text">
              <h1>Event surveys, written as plain text.</h1>
              <p className="lead">Write it in markdown, share one link, track no one.</p>
              <p className="hero__actions">
                <a className="key key--primary" href={SIGN_IN}>
                  Sign in to write a survey
                </a>
                <a href={GUIDE}>Read the survey syntax</a>
              </p>
            </div>
            <figure className="shot hero__shot" data-slot="hero" data-kind="product">
              <picture>
                <source
                  media="(max-width: 40rem) and (prefers-color-scheme: dark)"
                  srcSet="/landing/editor-narrow-dark.webp"
                  width={748}
                  height={1264}
                />
                <source
                  media="(max-width: 40rem)"
                  srcSet="/landing/editor-narrow.webp"
                  width={748}
                  height={1264}
                />
                <source media="(prefers-color-scheme: dark)" srcSet="/landing/editor-dark.webp" />
                <img
                  src="/landing/editor.webp"
                  width={2048}
                  height={1616}
                  alt="The survey editor: markdown on the left, the form it makes on the right."
                  fetchPriority="high"
                />
              </picture>
            </figure>
          </div>
        </section>

        <section className="stack" aria-labelledby="stack-h">
          <div className="frame stack__grid">
            <div className="stack__pin">
              <h2 id="stack-h">From draft to QR code</h2>
              <p className="lead">Save a draft, publish a version, print the code.</p>
            </div>
            <div className="stack__shots">
              <figure className="shot-figure">
                <div className="shot shot--dialog" data-slot="publish" data-kind="product">
                  <picture>
                    <source
                      media="(prefers-color-scheme: dark)"
                      srcSet="/landing/publish-dark.webp"
                    />
                    <img
                      src="/landing/publish.webp"
                      width={1152}
                      height={1276}
                      loading="lazy"
                      alt="The publish dialog with the survey's privacy statement and optional open and close dates."
                    />
                  </picture>
                </div>
                <figcaption>
                  Every version publishes with its own privacy statement, and is never edited after.
                </figcaption>
              </figure>
              <figure className="shot-figure">
                <div className="shot" data-slot="share" data-kind="product">
                  <picture>
                    <source
                      media="(prefers-color-scheme: dark)"
                      srcSet="/landing/share-dark.webp"
                    />
                    <img
                      src="/landing/share.webp"
                      width={1304}
                      height={320}
                      loading="lazy"
                      alt="The share strip: a QR code beside the survey link, with downloads."
                    />
                  </picture>
                </div>
                <figcaption>
                  One link and a QR code, as SVG or PNG for slides and posters.
                </figcaption>
              </figure>
              <figure className="shot-figure shot-figure--phone">
                <div className="shot shot--phone" data-slot="phone" data-kind="product">
                  <picture>
                    <source
                      media="(prefers-color-scheme: dark)"
                      srcSet="/landing/phone-dark.webp"
                    />
                    <img
                      src="/landing/phone.webp"
                      width={780}
                      height={1688}
                      loading="lazy"
                      alt="The survey on a phone: one page, large tap targets."
                    />
                  </picture>
                </div>
                <figcaption>Respondents get one page that works on a phone. No account.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="mapping" aria-labelledby="mapping-h">
          <div className="frame">
            <h2 id="mapping-h">One block per question</h2>
            <p className="lead">
              The form beside the markdown is live: the compiler and renderer the editor uses.
            </p>
            <div className="mapping__panes">
              <Code text={SAMPLE} label="Survey markdown" />
              <div className="mapping__form">
                {model && (
                  <>
                    <h3>{model.title}</h3>
                    <SurveyForm model={model} mode="preview" />
                  </>
                )}
              </div>
            </div>
            <p className="caption">
              Six question types: single choice, multiple choice, rating grid, free text, number and
              date.
            </p>
          </div>
        </section>

        <section className="promises" aria-labelledby="promises-h">
          <div className="frame promises__grid">
            <h2 id="promises-h">What respondents are promised</h2>
            <div>
              <table>
                <caption className="sr-only">What the app does with respondents</caption>
                <tbody>
                  {PROMISES.map(([k, v]) => (
                    <tr key={k}>
                      <th scope="row">{k}</th>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="caption">
                Free text can still identify someone, and proxies in front of the app keep their own
                logs.
              </p>
            </div>
          </div>
        </section>

        <section className="exports" aria-labelledby="exports-h">
          <div className="frame exports__grid">
            <div>
              <h2 id="exports-h">Exports name event, survey and wave</h2>
              <dl className="facts">
                <div>
                  <dt>Formats</dt>
                  <dd>CSV for spreadsheets, JSON lines for analysis.</dd>
                </div>
                <div>
                  <dt>Every row</dt>
                  <dd>Its event, survey, wave and version.</dd>
                </div>
                <div>
                  <dt>Columns</dt>
                  <dd>Publishing asks first if a change would alter one.</dd>
                </div>
              </dl>
            </div>
            <Code text={EXPORT_ROW} label="One exported response, ids left out." shown />
          </div>
        </section>
      </main>

      <footer className="mast-foot">
        <div className="frame">
          <p className="mast-foot__word">{APP_NAME}</p>
          <ul className="mast-foot__links">
            <li>
              <a href={SIGN_IN}>Sign in</a>
            </li>
            <li>
              <a href={GUIDE}>Survey syntax</a>
            </li>
            <li>
              <a href="/api/docs">API docs</a>
            </li>
            <li>
              <a href={SOURCE}>Source code</a>
            </li>
          </ul>
          <p>Answering a survey? Use the link or QR code you were given.</p>
          <p className="caption">Open source under the MIT licence.</p>
        </div>
      </footer>
    </div>
  );
}
