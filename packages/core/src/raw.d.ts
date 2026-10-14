// Vite/vitest `?raw` imports (tests only; core itself does no I/O).
declare module "*?raw" {
  const text: string;
  export default text;
}
