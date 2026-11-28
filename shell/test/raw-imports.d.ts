// A file imported as its text (Vite's `?raw`), as a test reads wrangler.jsonc.
declare module "*?raw" {
  const text: string;
  export default text;
}
