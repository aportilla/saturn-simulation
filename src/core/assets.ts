/** Absolute URL for a file under public/ (works from any page depth, e.g. /sandbox/*.html). */
export function dataUrl(path: string): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
  return base.replace(/\/?$/, '/') + path.replace(/^\//, '');
}
