# plainfeedback: UI review

- **House style:** the design tokens in `apps/web/src/styles.css`.
- **Visible change:** files under `apps/web`, or HTML the server renders.
- **Sign in:** get a staff session from `just dev-session`. Open `/`, set `document.cookie = "pf_session=<id>; path=/api/v1"`, then open `/app/`.
- **Long text:** test long emails and long survey titles.
- **Participant pages (`/s/*`):** no new external fonts or assets.
