// Share panel for a survey (issue #9): participant URL with copy button, QR preview and downloads.
// Self-contained; the editor drops it in with the event id and survey slug.
import { useEffect, useState } from "react";

type Link = { url: string; published: boolean };

export function ShareLink({ eventId, survey }: { eventId: string; survey: string }) {
  const base = `/api/v1/events/${encodeURIComponent(eventId)}/surveys/${encodeURIComponent(survey)}/link`;
  const [link, setLink] = useState<Link>();
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(base)
      .then((r) =>
        r.ok ? (r.json() as Promise<Link>) : Promise.reject(new Error(String(r.status))),
      )
      .then((l) => live && setLink(l))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [base]);

  if (failed) return <p role="alert">Could not load the survey link.</p>;
  if (!link) return <p>Loading link...</p>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked: the URL is selectable in the field
    }
  };
  return (
    <section aria-label="Share this survey">
      {!link.published && (
        <p>Not published yet: the link shows a "not found" page until you publish.</p>
      )}
      <input
        readOnly
        aria-label="Survey link"
        value={link.url}
        onFocus={(e) => e.target.select()}
      />
      <button type="button" onClick={copy}>
        {copied ? "Copied" : "Copy link"}
      </button>
      <img src={`${base}/qr.svg`} alt={`QR code for ${link.url}`} width={200} height={200} />
      <p>
        <a href={`${base}/qr.svg`} download>
          Download SVG
        </a>{" "}
        <a href={`${base}/qr.png?size=1024`} download>
          Download PNG
        </a>
      </p>
    </section>
  );
}
