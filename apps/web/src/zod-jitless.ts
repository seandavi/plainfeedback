import { z } from "zod";

// zod's JIT probes eval with Function(""), which a CSP without 'unsafe-eval' reports as a
// violation (#40). Must run before @plainfeedback/core builds its schemas, so main.tsx imports
// this first.
z.config({ jitless: true });
