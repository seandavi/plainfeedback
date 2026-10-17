# plainfeedback: UX review

**Sign in** (staff pages): get a session from `just dev-session`. Open `http://localhost:<port>/`, run `document.cookie = "pf_session=<id>; path=/api/v1"`, then open `/app/`.

**Users to walk through as:**
- **Survey creator or editor:** often not a markdown expert. Can they complete the task without reading docs? Are error messages specific about where the problem is and how to fix it?
- **Response consumer:** exports and data views. Is it clear what they are getting?
- **Participant on a phone (375px):** anonymous and in a hurry. Is the flow short and clear, is reassurance about privacy visible, and is there no dead end?
